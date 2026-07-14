import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../common/prisma.service';
import { runWithHttpRequestContext } from '../common/http/request-context';
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
  readonly aclGroupIpMembers?: Array<{ cidr: string | null }>;
  readonly userGroups?: Array<{ groupId: number }>;
  readonly groups?: Array<{ id: number; code: string }>;
  readonly groupPermissions?: Array<{ permissionCode: string }>;
  readonly subwikiRole?: { id: bigint } | null;
  readonly serverWiki?: { voteServerId: string | null; createdBy: bigint | null } | null;
  readonly server?: { ownerAccountId: string | null } | null;
  readonly namespaceId?: number | null;
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
    wikiNamespace: {
      async findUnique() {
        return options.namespaceId ? { id: options.namespaceId } : null;
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
      },
      async findMany() {
        return options.aclGroupIpMembers ?? [];
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

test('ACL group CIDR member matches a centrally supplied IPv4 request address for guests', async () => {
  const { service, store } = createService({
    rules: [{
      targetType: 'site', action: 'read', effect: 'deny',
      subjectType: 'aclgroup', subjectValue: 'blocked_networks'
    }],
    aclGroup: { id: 6n, groupKey: 'blocked_networks', status: 'active' },
    aclGroupIpMembers: [{ cidr: '192.0.2.0/24' }]
  });

  const decision = await service.evaluate({
    actor: null,
    requestIp: '192.0.2.50',
    action: 'read',
    resource: {},
    store: store as unknown as PrismaService
  });

  assert.equal(decision.matched, true);
  assert.equal(decision.allowed, false);
});

test('ACL group CIDR member uses the isolated HTTP request context for anonymous reads', async () => {
  const { service, store } = createService({
    rules: [{
      targetType: 'site', action: 'read', effect: 'deny',
      subjectType: 'aclgroup', subjectValue: 'blocked_networks'
    }],
    aclGroup: { id: 6n, groupKey: 'blocked_networks', status: 'active' },
    aclGroupIpMembers: [{ cidr: '192.0.2.0/24' }]
  });

  const decision = await runWithHttpRequestContext('192.0.2.50', () => service.evaluate({
    actor: null,
    action: 'read',
    resource: {},
    store: store as unknown as PrismaService
  }));

  assert.equal(decision.matched, true);
  assert.equal(decision.allowed, false);
});

test('ACL group CIDR member does not match another network or an invalid address', async () => {
  const { service, store } = createService({
    rules: [{
      targetType: 'site', action: 'read', effect: 'deny',
      subjectType: 'aclgroup', subjectValue: 'blocked_networks'
    }],
    aclGroup: { id: 6n, groupKey: 'blocked_networks', status: 'active' },
    aclGroupIpMembers: [{ cidr: '2001:db8::/32' }]
  });

  for (const requestIp of ['2001:db9::1', 'not-an-ip']) {
    const decision = await service.evaluate({
      actor: null, requestIp, action: 'read', resource: {},
      store: store as unknown as PrismaService
    });
    assert.equal(decision.matched, false);
  }
});

test('rules referencing an archived ACL group remain inert without becoming an implicit deny', async () => {
  const { service, store } = createService({
    rules: [{
      targetType: 'site', action: 'edit', effect: 'allow',
      subjectType: 'aclgroup', subjectValue: 'retired_editors'
    }],
    aclGroup: { id: 7n, groupKey: 'retired_editors', status: 'archived' },
    aclGroupMember: { id: 11n }
  });
  const decision = await service.evaluate({
    actor: { accountId: 'account-1', profileId: 100n, status: 'active' },
    action: 'edit', resource: {}, store: store as unknown as PrismaService
  });
  assert.deepEqual(decision, { matched: false, allowed: false, reason: 'acl_no_match' });
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

test('a page rule overrides an inherited site rule', async () => {
  const { service, store } = createService({
    rules: [
      {
        targetType: 'site',
        action: 'edit',
        effect: 'deny',
        subjectType: 'perm',
        subjectValue: 'member',
        reason: 'site_member_deny'
      },
      {
        targetType: 'page',
        targetId: 1n,
        action: 'edit',
        effect: 'allow',
        subjectType: 'perm',
        subjectValue: 'member',
        reason: 'page_member_allow'
      }
    ]
  });

  const decision = await service.evaluate({
    actor: { accountId: 'account-1', profileId: 100n, status: 'active' },
    action: 'edit',
    resource: { pageId: 1n, spaceId: 10n },
    store: store as unknown as PrismaService
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'page_member_allow');
});

test('namespace rules apply between space and site inheritance', async () => {
  const { service, store } = createService({
    namespaceId: 7,
    rules: [{
      targetType: 'namespace',
      targetId: 7n,
      action: 'create',
      effect: 'allow',
      subjectType: 'perm',
      subjectValue: 'member',
      reason: 'server_namespace_member'
    }]
  });

  const decision = await service.evaluate({
    actor: { accountId: 'account-1', profileId: 100n, status: 'active' },
    action: 'create',
    resource: { namespaceCode: 'server', title: '새 문서' },
    store: store as unknown as PrismaService
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'server_namespace_member');
});

for (const scenario of [
  { action: 'read', specificType: 'page', specificId: 1n, broaderEffect: 'allow', specificEffect: 'deny' },
  { action: 'read', specificType: 'page', specificId: 1n, broaderEffect: 'deny', specificEffect: 'allow' },
  { action: 'edit', specificType: 'page', specificId: 1n, broaderEffect: 'allow', specificEffect: 'deny' },
  { action: 'edit', specificType: 'page', specificId: 1n, broaderEffect: 'deny', specificEffect: 'allow' },
  { action: 'create', specificType: 'space', specificId: 10n, broaderEffect: 'allow', specificEffect: 'deny' },
  { action: 'create', specificType: 'space', specificId: 10n, broaderEffect: 'deny', specificEffect: 'allow' }
] as const) {
  test(`${scenario.specificType} ${scenario.specificEffect} overrides namespace ${scenario.broaderEffect} for ${scenario.action}`, async () => {
    const { service, store } = createService({
      namespaceId: 7,
      rules: [
        {
          targetType: 'namespace',
          targetId: 7n,
          action: scenario.action,
          effect: scenario.broaderEffect,
          subjectType: 'perm',
          subjectValue: 'any',
          sortOrder: 0,
          reason: 'namespace_rule'
        },
        {
          targetType: scenario.specificType,
          targetId: scenario.specificId,
          action: scenario.action,
          effect: scenario.specificEffect,
          subjectType: 'perm',
          subjectValue: 'any',
          sortOrder: 999,
          reason: 'specific_rule'
        }
      ]
    });

    const decision = await service.evaluate({
      actor: null,
      action: scenario.action,
      resource: {
        pageId: scenario.action === 'create' ? null : 1n,
        spaceId: 10n,
        namespaceCode: 'server'
      },
      store: store as unknown as PrismaService
    });

    assert.equal(decision.allowed, scenario.specificEffect === 'allow');
    assert.equal(decision.reason, 'specific_rule');
  });
}

test('general wiki groups are distinct ACL subjects', async () => {
  const { service, store } = createService({
    rules: [{
      targetType: 'space',
      targetId: 10n,
      action: 'edit',
      effect: 'allow',
      subjectType: 'group',
      subjectValue: 'trusted',
      reason: 'trusted_group'
    }],
    userGroups: [{ groupId: 2 }],
    groups: [{ id: 2, code: 'trusted' }]
  });

  const decision = await service.evaluate({
    actor: { accountId: 'account-1', profileId: 100n, status: 'active' },
    action: 'edit',
    resource: { pageId: 1n, spaceId: 10n },
    store: store as unknown as PrismaService
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'trusted_group');
});
