import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../common/prisma.service';
import { WikiAclService } from './wiki-acl.service';

function createService(options: {
  readonly rules?: Array<{
    targetType: string;
    targetId?: bigint | null;
    action: string;
    effect: string;
    subjectType: string;
    subjectValue: string;
    sortOrder?: number;
    reason?: string | null;
    expiresAt?: Date | null;
  }>;
  readonly aclGroup?: { id: bigint; groupKey: string; status: string } | null;
  readonly aclGroupMember?: { id: bigint } | null;
  readonly userGroups?: Array<{ groupId: number }>;
  readonly groups?: Array<{ id: number; code: string }>;
  readonly groupPermissions?: Array<{ permissionCode: string }>;
  readonly subwikiRole?: { id: bigint } | null;
  readonly serverWiki?: { voteServerId: string | null; createdBy: bigint | null } | null;
  readonly server?: { ownerAccountId: string | null } | null;
} = {}) {
  const now = new Date();
  const store = {
    aclRule: {
      async findMany() {
        return (options.rules ?? []).map((rule, index) => ({
          id: BigInt(index + 1),
          targetType: rule.targetType,
          targetId: rule.targetId ?? null,
          action: rule.action,
          effect: rule.effect,
          subjectType: rule.subjectType,
          subjectValue: rule.subjectValue,
          sortOrder: rule.sortOrder ?? index + 1,
          reason: rule.reason ?? null,
          expiresAt: rule.expiresAt ?? null,
          createdBy: null,
          createdAt: now,
          updatedAt: now
        }));
      }
    },
    aclGroup: {
      async findUnique() {
        return options.aclGroup ?? null;
      }
    },
    aclGroupMember: {
      async findFirst() {
        return options.aclGroupMember ?? null;
      }
    },
    wikiUserGroup: {
      async findMany() {
        return options.userGroups ?? [];
      }
    },
    wikiGroup: {
      async findMany() {
        return options.groups ?? [];
      }
    },
    wikiGroupPermission: {
      async findMany() {
        return options.groupPermissions ?? [];
      }
    },
    subwikiRole: {
      async findFirst() {
        return options.subwikiRole ?? null;
      }
    },
    serverWiki: {
      async findFirst() {
        return options.serverWiki ?? null;
      }
    },
    server: {
      async findUnique() {
        return options.server ?? null;
      }
    },
    modWiki: {
      async findFirst() {
        return null;
      }
    },
    wikiPage: {
      async findMany() {
        return [];
      }
    },
    wikiPageRevision: {
      async findFirst() {
        return null;
      }
    }
  };
  return { service: new WikiAclService(store as unknown as PrismaService), store };
}

test('page deny read rule rejects matching public actor', async () => {
  const { service, store } = createService({
    rules: [{
      targetType: 'page',
      targetId: 1n,
      action: 'read',
      effect: 'deny',
      subjectType: 'perm',
      subjectValue: 'any',
      reason: 'private_page'
    }]
  });

  const decision = await service.evaluate({
    actor: null,
    action: 'read',
    resource: { pageId: 1n, spaceId: 10n, title: '비공개' },
    store: store as unknown as PrismaService
  });

  assert.equal(decision.matched, true);
  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'private_page');
});

test('expired ACL rule is ignored', async () => {
  const { service, store } = createService({
    rules: [{
      targetType: 'page',
      targetId: 1n,
      action: 'read',
      effect: 'deny',
      subjectType: 'perm',
      subjectValue: 'any',
      expiresAt: new Date(Date.now() - 1000)
    }]
  });

  const decision = await service.evaluate({
    actor: null,
    action: 'read',
    resource: { pageId: 1n, spaceId: 10n, title: '문서' },
    store: store as unknown as PrismaService
  });

  assert.equal(decision.matched, false);
});

test('ACL group member can match allow rule', async () => {
  const { service, store } = createService({
    rules: [{
      targetType: 'space',
      targetId: 10n,
      action: 'edit',
      effect: 'allow',
      subjectType: 'aclgroup',
      subjectValue: 'trusted_editors'
    }],
    aclGroup: { id: 5n, groupKey: 'trusted_editors', status: 'active' },
    aclGroupMember: { id: 9n }
  });

  const decision = await service.evaluate({
    actor: { accountId: 'account-1', profileId: 100n, status: 'active' },
    action: 'edit',
    resource: { pageId: 1n, spaceId: 10n, title: '문서' },
    store: store as unknown as PrismaService
  });

  assert.equal(decision.matched, true);
  assert.equal(decision.allowed, true);
});

test('space allow server owner role works', async () => {
  const { service, store } = createService({
    rules: [{
      targetType: 'space',
      targetId: 10n,
      action: 'create',
      effect: 'allow',
      subjectType: 'role',
      subjectValue: 'server_owner'
    }],
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'account-1' }
  });

  const decision = await service.evaluate({
    actor: { accountId: 'account-1', profileId: 100n, status: 'active' },
    action: 'create',
    resource: { spaceId: 10n, namespaceCode: 'server', title: '새 문서' },
    store: store as unknown as PrismaService
  });

  assert.equal(decision.matched, true);
  assert.equal(decision.allowed, true);
});
