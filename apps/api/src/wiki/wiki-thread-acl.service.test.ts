import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import { WikiThreadAclService } from './wiki-thread-acl.service';
import type { WikiDiscussionLiveService } from './wiki-discussion-live.service';

const session = { userId: 'account-1', permissions: ['wiki.admin'] } as SessionPayload;
const now = new Date('2026-07-15T00:00:00.000Z');
const thread = { id: 30n, pageId: 10n, title: '토론', status: 'open', createdBy: 20n, pinnedCommentId: null, createdAt: now, updatedAt: now };
const page = {
  id: 10n, namespaceId: 1, spaceId: 2n, localPath: 'guide', slug: 'guide', title: 'Guide', displayTitle: 'Guide',
  currentRevisionId: 1n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 20n,
  createdAt: now, updatedAt: now
};

function profileService(): WikiProfileService {
  return { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
}

function permissionService(options: { manage?: boolean; onRead?: () => void } = {}): WikiPermissionService {
  return {
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active', permissions: ['wiki.admin'] }; },
    async canManageThreadAcl() { return { allowed: options.manage ?? true, reason: 'test_manager' }; },
    async assertCanManageThreadAcl() {},
    async assertCanReadThread() { options.onRead?.(); }
  } as unknown as WikiPermissionService;
}

test('thread ACL GET lets an authorized manager recover a closed thread rule set', async () => {
  let readChecks = 0;
  const prisma = {
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiPage: { async findUnique() { return page; } },
    aclRule: { async findMany() { return []; } },
    wikiGroup: { async findMany() { return []; } },
    aclGroup: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const service = new WikiThreadAclService(prisma, profileService(), permissionService({ onRead: () => { readChecks += 1; } }));
  const result = await service.getThreadAcl('30', session);
  assert.equal(result.canManage, true);
  assert.equal(readChecks, 0);
  assert.match(result.ruleSetHash, /^[a-f0-9]{64}$/);
});

test('every thread ACL mutation requires a non-blank audit reason', async () => {
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 20n }; } }
  } as unknown as PrismaService;
  const service = new WikiThreadAclService(prisma, profileService(), permissionService());
  await assert.rejects(service.createRule('30', session, {
    action: 'read', effect: 'allow', subjectType: 'perm', subjectValue: 'member', reason: '   '
  }), BadRequestException);
  await assert.rejects(service.deleteRule('30', '1', session, ''), BadRequestException);
  await assert.rejects(service.reorderRules('30', session, {
    action: 'read', ruleIds: ['1'], expectedRuleSetHash: '0'.repeat(64), reason: ' '
  }), BadRequestException);
});

test('thread ACL rejects unknown permission subjects before they can close the thread', async () => {
  const service = new WikiThreadAclService({} as PrismaService, profileService(), permissionService());
  await assert.rejects(service.createRule('30', session, {
    action: 'read', effect: 'allow', subjectType: 'perm', subjectValue: 'memeber', reason: '오타 방지'
  }), BadRequestException);
});

test('thread ACL rejects a group scoped to another wiki space', async () => {
  const prisma = {
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiPage: { async findUnique() { return page; } },
    aclGroup: {
      async findUnique() {
        return { status: 'active', scopeType: 'space', spaceId: 99n };
      }
    }
  } as unknown as PrismaService;
  const service = new WikiThreadAclService(prisma, profileService(), permissionService());
  await assert.rejects(service.createRule('30', session, {
    action: 'read', effect: 'allow', subjectType: 'aclgroup', subjectValue: 'other_space', reason: '공간 격리 검증'
  }), /this wiki space/i);
});

test('thread readers do not receive the manager-only ACL subject catalog', async () => {
  let catalogQueried = false;
  const prisma = {
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiPage: { async findUnique() { return page; } },
    aclRule: { async findMany() { return []; } },
    wikiGroup: { async findMany() { catalogQueried = true; return []; } },
    aclGroup: { async findMany() { catalogQueried = true; return []; } }
  } as unknown as PrismaService;
  const service = new WikiThreadAclService(prisma, profileService(), permissionService({ manage: false }));
  const result = await service.getThreadAcl('30', null);
  assert.equal(catalogQueried, false);
  assert.deepEqual(result.catalog.groups, []);
  assert.deepEqual(result.catalog.aclGroups, []);
  assert.deepEqual(result.catalog.roles, []);
});

test('thread ACL create locks the thread and writes both ACL and business audit records', async () => {
  let locked = false;
  let changeLogged = false;
  let audited = false;
  let committed = false;
  let published = false;
  const rule = {
    id: 1n, targetType: 'thread', targetId: 30n, action: 'read', effect: 'allow', subjectType: 'perm',
    subjectValue: 'member', sortOrder: 10, reason: '운영 정책', expiresAt: null, createdBy: 20n, createdAt: now, updatedAt: now
  };
  const tx = {
    async $queryRaw() { locked = true; return [{ id: 30n }]; },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiPage: { async findUnique() { return page; } },
    aclRule: {
      async aggregate() { return { _max: { sortOrder: null } }; },
      async create() { return rule; },
      async findMany() { return [rule]; }
    },
    aclChangeLog: { async create() { changeLogged = true; return {}; } }
  };
  const prisma = {
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiPage: { async findUnique() { return page; } },
    async $transaction(callback: (store: typeof tx) => Promise<unknown>) {
      const result = await callback(tx);
      committed = true;
      return result;
    }
  } as unknown as PrismaService;
  const events = { async audit() { audited = true; } } as unknown as BusinessEventService;
  const live = {
    publish(id: bigint) {
      assert.equal(committed, true);
      assert.equal(id, thread.id);
      published = true;
    }
  } as unknown as WikiDiscussionLiveService;
  const service = new WikiThreadAclService(prisma, profileService(), permissionService(), events, live);
  const result = await service.createRule('30', session, {
    action: 'read', effect: 'allow', subjectType: 'perm', subjectValue: 'member', reason: '운영 정책'
  });
  assert.equal(result.rule.id, '1');
  assert.equal(locked, true);
  assert.equal(changeLogged, true);
  assert.equal(audited, true);
  assert.equal(published, true);
});

test('thread ACL reorder rejects a stale hash after taking the thread lock', async () => {
  let locked = false;
  let updated = false;
  const rule = {
    id: 1n, targetType: 'thread', targetId: 30n, action: 'read', effect: 'allow', subjectType: 'perm',
    subjectValue: 'member', sortOrder: 10, reason: '기존', expiresAt: null, createdBy: 20n, createdAt: now, updatedAt: now
  };
  const tx = {
    async $queryRaw() { locked = true; return []; },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiPage: { async findUnique() { return page; } },
    aclRule: {
      async findMany() { return [rule]; },
      async update() { updated = true; return rule; }
    }
  };
  const prisma = {
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiPage: { async findUnique() { return page; } },
    async $transaction(callback: (store: typeof tx) => Promise<unknown>) { return callback(tx); }
  } as unknown as PrismaService;
  const service = new WikiThreadAclService(prisma, profileService(), permissionService());
  await assert.rejects(service.reorderRules('30', session, {
    action: 'read', ruleIds: ['1'], expectedRuleSetHash: '0'.repeat(64), reason: '순서 변경'
  }), ConflictException);
  assert.equal(locked, true);
  assert.equal(updated, false);
});
