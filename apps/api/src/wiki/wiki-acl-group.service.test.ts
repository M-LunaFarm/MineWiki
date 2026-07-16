import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import { WikiAclGroupService } from './wiki-acl-group.service';

const now = new Date('2026-07-15T00:00:00.000Z');

function group(overrides: Record<string, unknown> = {}) {
  return {
    id: 1n, groupKey: 'trusted', scopeType: 'site', spaceId: null,
    title: '신뢰 사용자', description: null, status: 'active',
    selfRemovable: false, createdAt: now, updatedAt: now, ...overrides
  };
}

function member(overrides: Record<string, unknown> = {}) {
  return {
    id: 3n, groupId: 1n, memberType: 'user', userId: 9n, ip: null, ipVersion: null, cidr: null,
    reason: '운영 정책', expiresAt: null, addedBy: 2n, addedAt: now, removedAt: null, ...overrides
  };
}

test('creates an ACL group and its immutable change log in one serializable transaction', async () => {
  const operations: string[] = [];
  const tx = {
    aclGroup: {
      async findUnique() { return null; },
      async create(args: { data: Record<string, unknown> }) { operations.push('group'); return group({ ...args.data }); }
    },
    aclChangeLog: { async create() { operations.push('acl-audit'); return {}; } },
    auditEvent: { async create() { operations.push('business-audit'); return {}; } }
  };
  const prisma = {
    async $transaction(callback: (store: typeof tx) => unknown) { operations.push('begin'); const result = await callback(tx); operations.push('commit'); return result; }
  };
  const service = new WikiAclGroupService(prisma as unknown as PrismaService);
  const result = await service.createGroup({ key: 'trusted', title: '신뢰 사용자', actorProfileId: 2n });
  assert.equal(result.key, 'trusted');
  assert.deepEqual(operations, ['begin', 'group', 'acl-audit', 'business-audit', 'commit']);
});

test('creates a space-scoped ACL group only for an active wiki space', async () => {
  let createdData: Record<string, unknown> | null = null;
  const tx = {
    wikiSpace: { async findUnique() { return { status: 'active' }; } },
    aclGroup: {
      async findUnique() { return null; },
      async create(args: { data: Record<string, unknown> }) {
        createdData = args.data;
        return group({ ...args.data });
      }
    },
    aclChangeLog: { async create() { return {}; } },
    auditEvent: { async create() { return {}; } }
  };
  const prisma = { async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); } };
  const service = new WikiAclGroupService(prisma as unknown as PrismaService);
  const result = await service.createGroup({
    key: 'server_editors', title: '서버 편집자', scopeType: 'space', spaceId: '12', actorProfileId: 2n
  });
  assert.equal(createdData?.scopeType, 'space');
  assert.equal(createdData?.spaceId, 12n);
  assert.equal(result.spaceId, '12');
});

test('adds and canonicalizes an IPv6 CIDR member while recording the audit atomically', async () => {
  let createdData: Record<string, unknown> | null = null;
  let audited = false;
  const tx = {
    aclGroup: {
      async findUnique() { return group(); },
      async update() { return group(); }
    },
    wikiProfile: { async findUnique() { return null; } },
    aclGroupMember: {
      async findFirst() { return null; },
      async create(args: { data: Record<string, unknown> }) { createdData = args.data; return member({ id: 4n, ...args.data }); }
    },
    aclChangeLog: { async create() { audited = true; return {}; } },
    auditEvent: { async create() { return {}; } }
  };
  const prisma = { async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); } };
  const service = new WikiAclGroupService(prisma as unknown as PrismaService);
  const result = await service.addMember({
    groupId: '1', memberType: 'cidr', address: '2001:0db8:1::abcd/48', reason: '악성 네트워크 차단', actorProfileId: 2n
  });
  assert.equal(result.cidr, '2001:db8:1::/48');
  assert.equal(createdData?.ipVersion, 6);
  assert.ok(Buffer.isBuffer(createdData?.ip));
  assert.equal(audited, true);
});

test('rejects a duplicate active user membership before creating an audit entry', async () => {
  let audited = false;
  const tx = {
    aclGroup: { async findUnique() { return group(); } },
    wikiProfile: { async findUnique() { return { id: 9n }; } },
    aclGroupMember: { async findFirst() { return { id: 3n }; } },
    aclChangeLog: { async create() { audited = true; } },
    auditEvent: { async create() { return {}; } }
  };
  const prisma = { async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); } };
  const service = new WikiAclGroupService(prisma as unknown as PrismaService);
  await assert.rejects(
    service.addMember({ groupId: '1', memberType: 'user', userId: '9', reason: '중복 확인', actorProfileId: 2n }),
    ConflictException
  );
  assert.equal(audited, false);
});

test('self remove is denied unless the group explicitly opts in', async () => {
  const tx = { aclGroup: { async findUnique() { return group({ selfRemovable: false }); } } };
  const prisma = { async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); } };
  const service = new WikiAclGroupService(prisma as unknown as PrismaService);
  await assert.rejects(
    service.selfRemove({ groupId: '1', profileId: 9n, requestIp: '192.0.2.1' }),
    ForbiddenException
  );
});

test('self remove matches both the current user and centrally supplied IPv4 CIDR, with one audit per member', async () => {
  const candidates = [
    member(),
    member({ id: 4n, memberType: 'cidr', userId: null, cidr: '192.0.2.0/24', ipVersion: 4 })
  ];
  const removed: bigint[] = [];
  let audits = 0;
  const tx = {
    aclGroup: {
      async findUnique() { return group({ selfRemovable: true }); },
      async update() { return group({ selfRemovable: true }); }
    },
    aclGroupMember: {
      async findMany() { return candidates; },
      async updateMany(args: { where: { id: bigint } }) { removed.push(args.where.id); return { count: 1 }; }
    },
    aclChangeLog: { async create() { audits += 1; return {}; } },
    auditEvent: { async create() { return {}; } }
  };
  const prisma = { async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); } };
  const service = new WikiAclGroupService(prisma as unknown as PrismaService);
  const result = await service.selfRemove({ groupId: '1', profileId: 9n, requestIp: '192.0.2.55' });
  assert.deepEqual(result.memberIds, ['3', '4']);
  assert.deepEqual(removed, [3n, 4n]);
  assert.equal(audits, 2);
});

test('archiving a group preserves its ACL rules while removing active memberships and writing both audits', async () => {
  let archived = false;
  let membersRemoved = false;
  let ruleTouched = false;
  let domainAudit = false;
  let businessAudit = false;
  const tx = {
    aclGroup: {
      async findUnique() { return group(); },
      async update() { archived = true; return group({ status: 'archived', selfRemovable: false }); }
    },
    aclGroupMember: { async updateMany() { membersRemoved = true; return { count: 2 }; } },
    aclRule: { async updateMany() { ruleTouched = true; return { count: 0 }; } },
    aclChangeLog: { async create() { domainAudit = true; return {}; } },
    auditEvent: { async create() { businessAudit = true; return {}; } }
  };
  const prisma = { async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); } };
  const service = new WikiAclGroupService(prisma as unknown as PrismaService);
  await service.deleteGroup({ groupId: '1', reason: '운영 종료로 그룹 보관', actorProfileId: 2n });
  assert.equal(archived, true);
  assert.equal(membersRemoved, true);
  assert.equal(ruleTouched, false);
  assert.equal(domainAudit, true);
  assert.equal(businessAudit, true);
});
