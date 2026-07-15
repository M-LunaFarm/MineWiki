import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
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
      },
      async findMany() {
        const space = options.space === undefined
          ? { id: 10n, status: 'active', ownerUserId: null, createdBy: null, spaceType: 'basic' }
          : options.space;
        return space ? [space] : [];
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

test('batch page visibility loads ACL decisions once and preserves candidate order', async () => {
  let batchCalls = 0;
  const service = createService({
    acl: {
      async evaluateReadBatch() {
        batchCalls += 1;
        return new Map([
          [1n, { matched: false, allowed: false, reason: 'acl_no_match' }],
          [2n, { matched: true, allowed: false, reason: 'private_page' }]
        ]);
      }
    } as WikiAclService
  });

  const result = await service.filterReadablePages({
    pages: [page({ id: 1n }), page({ id: 2n }), page({ id: 3n, status: 'deleted' })]
  });

  assert.deepEqual(result.map((item) => item.id), [1n]);
  assert.equal(batchCalls, 1);
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

test('elevation without wiki authority cannot edit a locked page', async () => {
  const service = createService();
  const decision = await service.canEditPage({
    actor: actor({ isElevated: true, profileId: 200n }),
    page: page({ protectionLevel: 'locked', createdBy: 100n })
  });

  assert.equal(decision.allowed, false);
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

test('elevation without wiki authority cannot change a locked section', async () => {
  const service = createService();
  const allowed = await service.canEditSectionLock({
    actor: actor({ profileId: 200n, isElevated: true }),
    page: page({ createdBy: 100n }),
    lock: { lockType: 'locked' }
  });

  assert.equal(allowed, false);
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

test('explicit wiki admin cannot be locked out by a page ACL deny rule', async () => {
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

test('legacy discuss deny blocks both new discussion actions when no specific rule exists', async () => {
  const service = createService({
    acl: {
      async evaluate(input) {
        return input.action === 'discuss'
          ? { matched: true, allowed: false, reason: 'legacy_discussion_deny' }
          : { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  });

  await assert.rejects(service.assertCanWriteThreadComment({ actor: actor(), page: page() }), ForbiddenException);
  await assert.rejects(service.assertCanCreateThread({ actor: actor(), page: page() }), ForbiddenException);
});

test('specific discussion allows override a legacy discuss deny', async () => {
  const service = createService({
    acl: {
      async evaluate(input) {
        if (input.action === 'create_thread' || input.action === 'write_thread_comment') {
          return { matched: true, allowed: true, reason: 'specific_allow' };
        }
        if (input.action === 'discuss') return { matched: true, allowed: false, reason: 'legacy_deny' };
        return { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  });

  await service.assertCanWriteThreadComment({ actor: actor(), page: page() });
  await service.assertCanCreateThread({ actor: actor(), page: page() });
});

test('new thread creation requires both comment and create-thread permission', async () => {
  const service = createService({
    acl: {
      async evaluate(input) {
        if (input.action === 'write_thread_comment') return { matched: true, allowed: false, reason: 'comments_disabled' };
        if (input.action === 'create_thread') return { matched: true, allowed: true, reason: 'creation_enabled' };
        return { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  });

  await assert.rejects(service.assertCanCreateThread({ actor: actor(), page: page() }), ForbiddenException);
});

test('create-thread deny still permits replies when comment permission allows them', async () => {
  const service = createService({
    acl: {
      async evaluate(input) {
        if (input.action === 'write_thread_comment') return { matched: true, allowed: true, reason: 'comments_enabled' };
        if (input.action === 'create_thread') return { matched: true, allowed: false, reason: 'creation_disabled' };
        return { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  });

  await service.assertCanWriteThreadComment({ actor: actor(), page: page() });
  await assert.rejects(service.assertCanCreateThread({ actor: actor(), page: page() }), ForbiddenException);
});

test('blocked profile cannot use discussion actions even with explicit ACL allows', async () => {
  const service = createService({
    acl: {
      async evaluate() {
        return { matched: true, allowed: true, reason: 'allow_everyone' };
      }
    } as WikiAclService
  });

  await assert.rejects(service.assertCanWriteThreadComment({ actor: actor({ status: 'blocked' }), page: page() }), ForbiddenException);
  await assert.rejects(service.assertCanCreateThread({ actor: actor({ status: 'blocked' }), page: page() }), ForbiddenException);
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

test('elevation without wiki authority cannot create in a restricted namespace', async () => {
  const service = createService();
  const decision = await service.canCreatePage({
    actor: actor({ isElevated: true, profileId: 200n }),
    namespaceCode: 'template',
    spaceId: 10n,
    title: '틀 문서'
  });

  assert.equal(decision.allowed, false);
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

test('category creation requires an explicit trusted ACL or wiki authority', async () => {
  const denied = await createService().canCreatePage({
    actor: actor({ profileId: 200n }),
    namespaceCode: 'category',
    spaceId: 10n,
    title: '게임 플레이'
  });
  const allowed = await createService({
    acl: {
      async evaluate(input) {
        return input.action === 'create'
          ? { matched: true, allowed: true, reason: 'trusted_category_editor' }
          : { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  }).canCreatePage({
    actor: actor({ profileId: 200n, groups: ['trusted'] }),
    namespaceCode: 'category',
    spaceId: 10n,
    title: '게임 플레이'
  });

  assert.deepEqual(denied, { allowed: false, reason: 'restricted_namespace' });
  assert.deepEqual(allowed, { allowed: true, reason: 'trusted_category_editor' });
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

test('space ownership grants review authority for a new-page edit request target', async () => {
  const ownerService = createService({
    space: { id: 10n, status: 'active', ownerUserId: 200n, createdBy: 300n, spaceType: 'basic' }
  });
  const unrelatedService = createService({
    space: { id: 10n, status: 'active', ownerUserId: 300n, createdBy: 300n, spaceType: 'basic' }
  });
  const input = { namespaceId: 1, namespaceCode: 'main', spaceId: 10n, title: '제안 문서' };

  assert.equal(await ownerService.canManageCreateTarget({ actor: actor({ profileId: 200n }), ...input }), true);
  assert.equal(await unrelatedService.canManageCreateTarget({ actor: actor({ profileId: 200n }), ...input }), false);
});

test('target-specific read ACL hides a new-page request before the page exists', async () => {
  const service = createService({
    acl: {
      async evaluate(input) {
        return input.action === 'read' && input.resource.title === '비공개 제안'
          ? { matched: true, allowed: false, reason: 'private_target' }
          : { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  });

  await assert.rejects(service.assertCanReadCreateTarget({
    accountId: null,
    namespaceId: 1,
    namespaceCode: 'main',
    spaceId: 10n,
    title: '비공개 제안'
  }), /Wiki page not found/);
});
