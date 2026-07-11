import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../common/prisma.service';
import type { WikiAclService } from './wiki-acl.service';
import { WikiPermissionService, type WikiPermissionActor, type WikiPermissionPage } from './wiki-permission.service';

function createService(options: {
  readonly space?: {
    id: bigint;
    status: string;
    ownerUserId?: bigint | null;
    createdBy?: bigint | null;
    spaceType?: string;
  } | null;
  readonly roles?: string[];
  readonly serverWiki?: { voteServerId: string | null; createdBy: bigint | null } | null;
  readonly server?: { ownerAccountId: string | null } | null;
  readonly modWiki?: { verifiedBy: bigint | null } | null;
  readonly acl?: WikiAclService;
} = {}) {
  const store = {
    wikiProfile: {
      async findUnique() {
        return null;
      }
    },
    wikiSpace: {
      async findUnique() {
        return options.space === undefined
          ? { id: 10n, status: 'active', ownerUserId: null, createdBy: null, spaceType: 'basic' }
          : options.space;
      }
    },
    subwikiRole: {
      async findMany() {
        return (options.roles ?? []).map((role) => ({ role }));
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
        return options.modWiki ?? null;
      }
    }
  };
  return new WikiPermissionService(store as unknown as PrismaService, options.acl);
}

function page(overrides: Partial<WikiPermissionPage> = {}): WikiPermissionPage {
  return {
    id: 1n,
    spaceId: 10n,
    title: '대문',
    protectionLevel: 'open',
    status: 'normal',
    createdBy: 100n,
    ...overrides
  };
}

function actor(overrides: Partial<WikiPermissionActor> = {}): WikiPermissionActor {
  return {
    accountId: 'account-1',
    profileId: 100n,
    status: 'active',
    ...overrides
  };
}

test('anonymous public read is allowed', async () => {
  const service = createService();
  const decision = await service.canReadPage({
    accountId: null,
    page: page(),
    revision: { visibility: 'public' }
  });

  assert.equal(decision.allowed, true);
});

test('hidden and deleted pages are denied for read', async () => {
  const service = createService();

  const hidden = await service.canReadPage({
    accountId: null,
    page: page({ status: 'hidden' }),
    revision: { visibility: 'public' }
  });
  const deleted = await service.canReadPage({
    accountId: null,
    page: page({ status: 'deleted' }),
    revision: { visibility: 'public' }
  });

  assert.equal(hidden.allowed, false);
  assert.equal(deleted.allowed, false);
});

test('ACL deny read overrides public page read', async () => {
  const service = createService({
    acl: {
      async evaluate() {
        return { matched: true, allowed: false, reason: 'acl_private' };
      }
    } as WikiAclService
  });
  const decision = await service.canReadPage({
    accountId: null,
    page: page(),
    revision: { visibility: 'public' }
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'acl_private');
});

test('logged-in active user can edit open page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ createdBy: 100n })
  });

  assert.equal(decision.allowed, true);
});

test('normal user cannot edit locked page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ protectionLevel: 'locked', createdBy: 100n })
  });

  assert.equal(decision.allowed, false);
});

test('elevated user can edit locked page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ isElevated: true, profileId: 200n }),
    page: page({ protectionLevel: 'locked', createdBy: 100n })
  });

  assert.equal(decision.allowed, true);
});

test('normal user cannot edit admin-only page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ protectionLevel: 'admin_only', createdBy: 100n })
  });

  assert.equal(decision.allowed, false);
});

test('ACL allow can grant edit before protection fallback', async () => {
  const service = createService({
    acl: {
      async evaluate() {
        return { matched: true, allowed: true, reason: 'acl_trusted_editor' };
      }
    } as WikiAclService
  });
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ protectionLevel: 'locked', createdBy: 100n })
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'acl_trusted_editor');
});

test('wiki admin permission can edit admin-only page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ permissions: ['wiki.admin'], profileId: 200n }),
    page: page({ protectionLevel: 'admin_only', createdBy: 100n })
  });

  assert.equal(decision.allowed, true);
});

test('locked editor can edit a locked page after ACL evaluation', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ permissions: ['wiki.edit.locked'], profileId: 200n }),
    page: page({ protectionLevel: 'locked', createdBy: 100n })
  });

  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'locked_editor');
});

test('ACL deny still blocks a locked editor', async () => {
  const service = createService({
    acl: {
      async evaluate() {
        return { matched: true, allowed: false, reason: 'acl_denied' };
      }
    } as WikiAclService
  });
  const decision = await service.canEditPage({
    actor: actor({ permissions: ['wiki.edit.locked'], profileId: 200n }),
    page: page({ protectionLevel: 'locked', createdBy: 100n })
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'acl_denied');
});

test('linked server owner can edit owner-only server wiki page', async () => {
  const service = createService({
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'account-1' }
  });
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ protectionLevel: 'owner_only', createdBy: 300n })
  });

  assert.equal(decision.allowed, true);
});

test('blocked wiki profile cannot edit open page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ status: 'blocked' }),
    page: page()
  });

  assert.equal(decision.allowed, false);
});

test('active user can create in a basic wiki space', async () => {
  const service = createService();
  const decision = await service.canCreatePage({
    actor: actor({ profileId: 200n }),
    namespaceCode: 'main',
    spaceId: 10n,
    title: '새 문서'
  });

  assert.equal(decision.allowed, true);
});

test('unrelated user cannot create in server wiki space', async () => {
  const service = createService({
    space: { id: 10n, status: 'active', ownerUserId: 300n, createdBy: 300n, spaceType: 'server_wiki' },
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'account-2' }
  });
  const decision = await service.canCreatePage({
    actor: actor({ profileId: 200n }),
    namespaceCode: 'server',
    spaceId: 10n,
    title: '서버 문서'
  });

  assert.equal(decision.allowed, false);
});

test('server owner can create in server wiki space', async () => {
  const service = createService({
    space: { id: 10n, status: 'active', ownerUserId: 300n, createdBy: 300n, spaceType: 'server_wiki' },
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'account-1' }
  });
  const decision = await service.canCreatePage({
    actor: actor({ profileId: 200n }),
    namespaceCode: 'server',
    spaceId: 10n,
    title: '서버 문서'
  });

  assert.equal(decision.allowed, true);
});

test('subwiki editor can create in server wiki space', async () => {
  const service = createService({
    space: { id: 10n, status: 'active', ownerUserId: 300n, createdBy: 300n, spaceType: 'server_wiki' },
    roles: ['editor']
  });
  const decision = await service.canCreatePage({
    actor: actor({ profileId: 200n }),
    namespaceCode: 'server',
    spaceId: 10n,
    title: '서버 문서'
  });

  assert.equal(decision.allowed, true);
});

test('elevated user can create in restricted namespace', async () => {
  const service = createService();
  const decision = await service.canCreatePage({
    actor: actor({ isElevated: true, profileId: 200n }),
    namespaceCode: 'template',
    spaceId: 10n,
    title: '틀 문서'
  });

  assert.equal(decision.allowed, true);
});

test('locked editor cannot create in a restricted namespace', async () => {
  const service = createService();
  const decision = await service.canCreatePage({
    actor: actor({ permissions: ['wiki.edit.locked'], profileId: 200n }),
    namespaceCode: 'template',
    spaceId: 10n,
    title: '틀 문서'
  });

  assert.equal(decision.allowed, false);
  assert.equal(decision.reason, 'restricted_namespace');
});

test('blocked wiki profile cannot create a page', async () => {
  const service = createService();
  const decision = await service.canCreatePage({
    actor: actor({ status: 'blocked' }),
    namespaceCode: 'main',
    spaceId: 10n,
    title: '새 문서'
  });

  assert.equal(decision.allowed, false);
});
