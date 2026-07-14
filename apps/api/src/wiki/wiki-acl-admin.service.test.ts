import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PrismaService } from '../common/prisma.service';
import { WikiAdminService } from './wiki-admin.service';

test('ACL admin creates an ordered rule and immutable change log', async () => {
  const createdAt = new Date('2026-07-12T06:00:00.000Z');
  const logs: unknown[] = [];
  const audits: unknown[] = [];
  const store = {
    aclRule: {
      async aggregate() { return { _max: { sortOrder: 20 } }; },
      async create({ data }: { data: Record<string, unknown> }) {
        return { id: 9n, ...data, createdAt, updatedAt: createdAt };
      }
    },
    aclChangeLog: {
      async create({ data }: { data: unknown }) { logs.push(data); return { id: 1n }; }
    },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const service = new WikiAdminService(
    store as unknown as PrismaService,
    { async audit(...args: unknown[]) { audits.push(args); } } as never
  );

  const result = await service.createAclRule({
    targetType: 'namespace',
    targetId: '7',
    action: 'edit',
    effect: 'allow',
    subjectType: 'role',
    subjectValue: 'server_editor',
    reason: '서버 위키 편집자 허용',
    actorProfileId: 3n
  });

  assert.equal(result.id, '9');
  assert.equal(result.sortOrder, 30);
  assert.equal(result.targetId, '7');
  assert.equal(logs.length, 1);
  assert.equal(audits.length, 1);
});

test('ACL admin rejects resource rules without an unsigned target id', async () => {
  const service = new WikiAdminService({} as PrismaService);

  await assert.rejects(
    () => service.createAclRule({
      targetType: 'page',
      targetId: '../1',
      action: 'read',
      effect: 'deny',
      subjectType: 'perm',
      subjectValue: 'guest',
      actorProfileId: 3n
    }),
    /targetId must be an unsigned integer/
  );
});

test('ACL admin reorders the complete page action rule set and logs the change', async () => {
  const createdAt = new Date('2026-07-12T06:00:00.000Z');
  const rules = [
    { id: 1n, targetType: 'page', targetId: 7n, action: 'edit', effect: 'allow', subjectType: 'perm', subjectValue: 'member', sortOrder: 10, reason: null, expiresAt: null, createdBy: 3n, createdAt, updatedAt: createdAt },
    { id: 2n, targetType: 'page', targetId: 7n, action: 'edit', effect: 'deny', subjectType: 'perm', subjectValue: 'any', sortOrder: 20, reason: null, expiresAt: null, createdBy: 3n, createdAt, updatedAt: createdAt }
  ];
  const logs: unknown[] = [];
  const store = {
    aclRule: {
      async findMany() { return rules; },
      async update({ where, data }: { where: { id: bigint }; data: { sortOrder: number; updatedAt: Date } }) {
        return { ...rules.find((rule) => rule.id === where.id)!, ...data };
      }
    },
    aclChangeLog: {
      async create({ data }: { data: unknown }) { logs.push(data); return { id: 1n }; }
    },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const service = new WikiAdminService(store as unknown as PrismaService);

  const result = await service.reorderPageAclRules({
    pageId: '7', action: 'edit', ruleIds: ['2', '1'], actorProfileId: 3n
  });

  assert.deepEqual(result.map((rule) => [rule.id, rule.sortOrder]), [['2', 10], ['1', 20]]);
  assert.equal(logs.length, 1);
});

test('ACL admin rejects stale or partial page reorder requests', async () => {
  const store = {
    aclRule: {
      async findMany() { return [{ id: 1n }, { id: 2n }]; }
    }
  };
  const service = new WikiAdminService(store as unknown as PrismaService);

  await assert.rejects(
    service.reorderPageAclRules({ pageId: '7', action: 'edit', ruleIds: ['1'], actorProfileId: 3n }),
    /rule set changed/i
  );
});
