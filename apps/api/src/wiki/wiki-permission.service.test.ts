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

test('ordinary editors can revert but cannot move or delete without explicit ACL', async () => {
  const service = createService();
  const ordinaryEditor = actor({ profileId: 200n });
  const target = page({ createdBy: 100n });

  await service.assertCanMutatePageAction({ actor: ordinaryEditor, action: 'revert', page: target });
  await assert.rejects(
    service.assertCanMutatePageAction({ actor: ordinaryEditor, action: 'move', page: target }),
    /manager/i
  );
  await assert.rejects(
    service.assertCanMutatePageAction({ actor: ordinaryEditor, action: 'delete', page: target }),
    /manager/i
  );
});

test('page creator can move and delete an editable page', async () => {
  const service = createService();
  const creator = actor({ profileId: 100n });
  const target = page({ createdBy: 100n });

  await service.assertCanMutatePageAction({ actor: creator, action: 'move', page: target });
  await service.assertCanMutatePageAction({ actor: creator, action: 'delete', page: target });
});

test('explicit move ACL can grant a non-manager editor access', async () => {
  const service = createService({
    acl: {
      async evaluate(input) {
        return input.action === 'move'
          ? { matched: true, allowed: true, reason: 'acl_move' }
          : { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  });

  await service.assertCanMutatePageAction({
    actor: actor({ profileId: 200n }),
    action: 'move',
    page: page({ createdBy: 100n })
  });
});

test('deleted page restore is limited to its manager even without an ACL rule', async () => {
  const service = createService();
  const deletedPage = page({ status: 'deleted', createdBy: 100n });

  await service.assertCanRestorePage({ actor: actor({ profileId: 100n }), page: deletedPage });
  await assert.rejects(
    service.assertCanRestorePage({ actor: actor({ profileId: 200n }), page: deletedPage }),
    /not allowed/i
  );
});

test('normal editor cannot change an admin-only section lock', async () => {
  const service = createService();
  const allowed = await service.canEditSectionLock({
    actor: actor({ profileId: 200n }),
    page: page({ createdBy: 100n }),
    lock: { lockType: 'admin_only' }
  });

  assert.equal(allowed, false);
});

test('elevated editor can change a locked section', async () => {
  const service = createService();
  const allowed = await service.canEditSectionLock({
    actor: actor({ profileId: 200n, isElevated: true }),
    page: page({ createdBy: 100n }),
    lock: { lockType: 'locked' }
  });

  assert.equal(allowed, true);
});

test('trusted section lock accepts trusted group and rejects ordinary member', async () => {
  const service = createService();
  const trusted = await service.canEditSectionLock({
    actor: actor({ profileId: 200n, groups: ['trusted'] }),
    page: page(),
    lock: { lockType: 'trusted_only' }
  });
  const member = await service.canEditSectionLock({
    actor: actor({ profileId: 200n, groups: ['member'] }),
    page: page(),
    lock: { lockType: 'trusted_only' }
  });

  assert.equal(trusted, true);
  assert.equal(member, false);
});

test('section owner group can edit its locked section', async () => {
  const service = createService();
  const allowed = await service.canEditSectionLock({
    actor: actor({ profileId: 200n, groups: ['documentation'] }),
    page: page(),
    lock: { lockType: 'admin_only', ownerGroup: 'documentation' }
  });

  assert.equal(allowed, true);
});

test('owner-only section accepts linked server owner', async () => {
  const service = createService({
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'account-1' }
  });
  const allowed = await service.canEditSectionLock({
    actor: actor({ profileId: 200n }),
    page: page({ createdBy: 300n }),
    lock: { lockType: 'owner_only' }
  });

  assert.equal(allowed, true);
});

test('page ACL management defaults to page and space managers', async () => {
  const service = createService();
  const target = page({ createdBy: 100n });

  assert.equal((await service.canManagePageAcl({ actor: actor({ profileId: 100n }), page: target })).allowed, true);
  assert.equal((await service.canManagePageAcl({ actor: actor({ profileId: 200n }), page: target })).allowed, false);
});

test('explicit ACL rule can grant or deny page ACL management', async () => {
  let allowed = true;
  const service = createService({
    acl: {
      async evaluate(input) {
        return input.action === 'acl'
          ? { matched: true, allowed, reason: allowed ? 'delegated_acl_manager' : 'acl_manager_denied' }
          : { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  });
  const manager = actor({ profileId: 100n });
  const ordinary = actor({ profileId: 200n });
  const target = page({ createdBy: 100n });

  assert.equal((await service.canManagePageAcl({ actor: ordinary, page: target })).allowed, true);
  allowed = false;
  assert.equal((await service.canManagePageAcl({ actor: manager, page: target })).allowed, false);
});

test('elevated wiki admin cannot be locked out by a page ACL deny rule', async () => {
  const service = createService({
    acl: {
      async evaluate() {
        return { matched: true, allowed: false, reason: 'deny_everyone' };
      }
    } as WikiAclService
  });

  const decision = await service.canManagePageAcl({
    actor: actor({ profileId: 200n, permissions: ['wiki.admin'] }),
    page: page({ createdBy: 100n })
  });
  assert.equal(decision.allowed, true);
  assert.equal(decision.reason, 'admin_acl');
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
