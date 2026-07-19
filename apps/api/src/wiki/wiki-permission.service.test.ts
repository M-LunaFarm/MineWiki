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
    rootPageId?: bigint | null;
    rootNamespaceCode?: string;
  } | null;
  readonly roles?: string[];
  readonly serverWiki?: {
    id?: bigint;
    spaceId?: bigint;
    voteServerId: string | null;
    createdBy: bigint | null;
    slug?: string;
    status?: string;
    publicationStatus?: string;
    publishedReleaseId?: bigint | null;
    serverName?: string;
    host?: string | null;
  } | null;
  readonly server?: {
    id?: string;
    name?: string;
    joinHost?: string;
    ownerAccountId: string | null;
    wikiSpaceId?: bigint | null;
    wikiPageId?: bigint | null;
    wikiSlug?: string | null;
    listingStatus?: string;
    ownershipChallengeSuspendedAt?: Date | null;
  } | null;
  readonly accounts?: readonly {
    id: string;
    canonicalAccountId: string | null;
    lifecycleStatus: string;
  }[];
  readonly modWiki?: { verifiedBy: bigint | null } | null;
  readonly acl?: WikiAclService;
  readonly profile?: { id: bigint; username: string; status: string } | null;
} = {}) {
  const defaultSpace = {
    id: 10n,
    status: 'active',
    ownerUserId: null,
    createdBy: null,
    spaceType: 'basic',
    rootPageId: 1n,
    rootNamespaceCode: 'server'
  };
  const normalizedSpace = options.space === undefined
    ? defaultSpace
    : options.space
      ? { ...defaultSpace, ...options.space }
      : null;
  const normalizedServerWiki = options.serverWiki
    ? {
        id: 20n,
        spaceId: 10n,
        slug: 'server-one',
        status: 'active',
        publicationStatus: 'published',
        publishedReleaseId: 30n,
        publishedRelease: { version: 2 },
        serverName: 'Server One',
        host: 'play.server-one.test',
        ...options.serverWiki,
      }
    : null;
  const normalizedServer = options.server
    ? {
        id: 'server-1',
        name: 'Server One',
        joinHost: 'play.server-one.test',
        wikiSpaceId: 10n,
        wikiPageId: 1n,
        wikiSlug: 'server-one',
        listingStatus: 'active',
        ...options.server,
      }
    : null;
  const accounts = options.accounts ?? [
    { id: 'account-1', canonicalAccountId: null, lifecycleStatus: 'active' },
    { id: 'account-2', canonicalAccountId: null, lifecycleStatus: 'active' }
  ];
  const store = {
    account: {
      async findMany(input: { where: { id: { in: string[] } } }) {
        return accounts.filter((account) => input.where.id.in.includes(account.id));
      }
    },
    wikiProfile: {
      async findUnique() {
        return options.profile ?? null;
      }
    },
    wikiSpace: {
      async findUnique() {
        return normalizedSpace;
      },
      async findMany() {
        return normalizedSpace ? [normalizedSpace] : [];
      }
    },
    subwikiRole: {
      async findMany() {
        return (options.roles ?? []).map((role) => ({ role }));
      }
    },
    serverWiki: {
      async findFirst() {
        return normalizedServerWiki;
      },
      async findMany() {
        return normalizedServerWiki ? [normalizedServerWiki] : [];
      }
    },
    server: {
      async findUnique() {
        return normalizedServer;
      },
      async findMany() {
        return normalizedServer ? [normalizedServer] : [];
      }
    },
    serverWikiReleaseItem: {
      async findFirst(input: { where: { pageId: bigint; revisionId?: bigint; releaseId?: bigint; release?: unknown } }) {
        if (input.where.pageId !== 1n) return null;
        if (input.where.releaseId === 30n) return { revisionId: 11n };
        if (input.where.revisionId === 10n && input.where.release) return { revisionId: 10n };
        return null;
      },
      async findMany(input: { where: { pageId: bigint | { in: bigint[] } } }) {
        if (typeof input.where.pageId === 'bigint') {
          return input.where.pageId === 1n
            ? [
                { releaseId: 30n, serverWikiId: 20n, spaceId: 10n, pageId: 1n, revisionId: 11n },
                { releaseId: 28n, serverWikiId: 20n, spaceId: 10n, pageId: 1n, revisionId: 11n },
                { releaseId: 29n, serverWikiId: 20n, spaceId: 10n, pageId: 1n, revisionId: 10n },
              ]
            : [];
        }
        return input.where.pageId.in.includes(1n) ? [{ spaceId: 10n, pageId: 1n }] : [];
      },
    },
    modWiki: {
      async findFirst() {
        return options.modWiki ?? null;
      },
      async findMany() {
        return options.modWiki ? [{ spaceId: 10n, ...options.modWiki }] : [];
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

test('protected documents stay publicly readable while official-only editing remains restricted', async () => {
  const service = createService();
  const protectedPage = page({ status: 'protected', protectionLevel: 'official_only' });

  const read = await service.canReadPage({
    accountId: null,
    page: protectedPage,
    revision: { visibility: 'public' }
  });
  const edit = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: protectedPage
  });

  assert.deepEqual(read, { allowed: true, reason: 'public_read' });
  assert.deepEqual(edit, { allowed: false, reason: 'owner_required' });
});

test('user documents bind creation and edits to immutable profile ownership', async () => {
  const service = createService({ profile: { id: 100n, username: 'owner_name', status: 'active' } });
  const owner = actor({ profileId: 100n });
  const stranger = actor({ profileId: 200n });
  const ownedPage = page({ title: 'owner_name/작업실', ownerProfileId: 100n, createdBy: 200n });

  assert.deepEqual(
    await service.canCreatePage({ actor: owner, namespaceCode: 'user', spaceId: 10n, title: 'owner_name/작업실' }),
    { allowed: true, reason: 'user_document_owner_create' }
  );
  assert.deepEqual(
    await service.canCreatePage({ actor: stranger, namespaceCode: 'user', spaceId: 10n, title: 'owner_name/작업실' }),
    { allowed: false, reason: 'user_document_owner_required' }
  );
  assert.deepEqual(
    await service.canEditPage({ actor: stranger, page: ownedPage }),
    { allowed: false, reason: 'user_document_owner_required' }
  );
  assert.equal((await service.canEditPage({ actor: owner, page: ownedPage })).allowed, true);

  const admin = actor({ profileId: 999n, permissions: ['wiki.admin'] });
  assert.deepEqual(
    await service.canCreatePage({ actor: admin, namespaceCode: 'user', spaceId: 10n, title: 'owner_name/관리' }),
    { allowed: true, reason: 'admin_user_document_create' }
  );
  assert.deepEqual(
    await service.canEditPage({ actor: admin, page: ownedPage }),
    { allowed: true, reason: 'admin_edit' }
  );
});

test('a user document ACL allow cannot grant a stranger edit ownership', async () => {
  const service = createService({
    acl: {
      async evaluate() {
        return { matched: true, allowed: true, reason: 'acl_trusted_editor' };
      }
    } as WikiAclService
  });
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ ownerProfileId: 100n, createdBy: 200n })
  });
  assert.deepEqual(decision, { allowed: false, reason: 'user_document_owner_required' });
});

test('user document ownership remains subject to explicit ACL denies', async () => {
  const service = createService({
    profile: { id: 100n, username: 'owner_name', status: 'active' },
    acl: {
      async evaluate() {
        return { matched: true, allowed: false, reason: 'acl_user_document_locked' };
      }
    } as WikiAclService
  });
  const owner = actor({ profileId: 100n });
  const ownedPage = page({ title: 'owner_name/작업실', ownerProfileId: 100n });

  assert.deepEqual(
    await service.canEditPage({ actor: owner, page: ownedPage }),
    { allowed: false, reason: 'acl_user_document_locked' }
  );
  assert.deepEqual(
    await service.canCreatePage({
      actor: owner, namespaceCode: 'user', spaceId: 10n, title: 'owner_name/새_문서'
    }),
    { allowed: false, reason: 'acl_user_document_locked' }
  );
});

test('a user document owner can review a create request only inside the active user space', async () => {
  const service = createService({ profile: { id: 100n, username: 'owner_name', status: 'active' } });
  assert.equal(await service.canManageCreateTarget({
    actor: actor({ profileId: 100n }),
    namespaceId: 7,
    namespaceCode: 'user',
    spaceId: 10n,
    title: 'owner_name/제안'
  }), true);
  assert.equal(await service.canManageCreateTarget({
    actor: actor({ profileId: 200n }),
    namespaceId: 7,
    namespaceCode: 'user',
    spaceId: 10n,
    title: 'owner_name/제안'
  }), false);
});

test('closed profile roots cannot receive new user documents', async () => {
  const service = createService({ profile: { id: 100n, username: 'closed_user', status: 'closed' } });
  assert.deepEqual(
    await service.canCreatePage({
      actor: actor({ profileId: 100n }), namespaceCode: 'user', spaceId: 10n, title: 'closed_user/문서'
    }),
    { allowed: false, reason: 'user_document_owner_missing' }
  );
});

test('user document owner lookup rejects Unicode aliases that do not match the canonical username', async () => {
  const service = createService({ profile: { id: 100n, username: 'owner_name', status: 'active' } });
  const decision = await service.canCreatePage({
    actor: actor(), namespaceCode: 'user', spaceId: 10n, title: 'ｏｗｎｅｒ＿ｎａｍｅ/위조'
  });
  assert.deepEqual(decision, { allowed: false, reason: 'user_document_owner_missing' });
});

test('page read denial remains an absolute boundary even for a wiki admin thread reader', async () => {
  const acl = {
    async evaluateReadBatch() {
      return new Map([[1n, { matched: true, allowed: false, reason: 'page_private' }]]);
    },
    async evaluateThreadBatch() {
      return new Map([[30n, { matched: true, allowed: true, reason: 'thread_allow' }]]);
    }
  } as unknown as WikiAclService;
  const service = createService({ acl });
  const rows = await service.filterReadableThreads({
    accountId: 'account-1',
    actor: actor({ permissions: ['wiki.admin'] }),
    items: [{ thread: { id: 30n, pageId: 1n, status: 'open' }, page: page() }]
  });
  assert.deepEqual(rows, []);
});

test('actual space owner recovers thread read and comment write without bypassing page read', async () => {
  const store = {
    wikiProfile: { async findUnique() { return null; } },
    wikiSpace: {
      async findUnique() { return { id: 10n, status: 'active' }; },
      async findMany() { return [{ id: 10n, status: 'active', ownerUserId: 100n, createdBy: null }]; }
    },
    subwikiRole: { async findMany() { return []; } },
    serverWiki: { async findMany() { return []; } },
    server: { async findMany() { return []; } },
    modWiki: { async findMany() { return []; } }
  };
  const acl = {
    async evaluate() { return { matched: false, allowed: false, reason: 'acl_no_match' }; },
    async evaluateReadBatch() { return new Map([[1n, { matched: false, allowed: false, reason: 'acl_no_match' }]]); },
    async evaluateThreadBatch() { return new Map([[30n, { matched: true, allowed: false, reason: 'closed' }]]); }
  } as unknown as WikiAclService;
  const service = new WikiPermissionService(store as unknown as PrismaService, acl);
  const owner = actor();
  const targetPage = page();
  const visible = await service.filterReadableThreads({
    accountId: owner.accountId, actor: owner,
    items: [{ thread: { id: 30n, pageId: targetPage.id, status: 'open' }, page: targetPage }]
  });
  assert.equal(visible.length, 1);
  await assert.doesNotReject(service.assertCanWriteThreadComment({ actor: owner, page: targetPage, threadId: 30n }));
});

test('delegated page ACL manager can manage thread ACL without being the thread author', async () => {
  const store = {
    wikiProfile: { async findUnique() { return null; } },
    wikiSpace: {
      async findUnique() { return { id: 10n, status: 'active' }; },
      async findMany() { return [{ id: 10n, status: 'active', ownerUserId: null, createdBy: null }]; }
    },
    subwikiRole: { async findMany() { return []; } },
    serverWiki: { async findMany() { return []; } },
    server: { async findMany() { return []; } },
    modWiki: { async findMany() { return []; } }
  };
  const acl = {
    async evaluate(input: { action: string }) {
      return input.action === 'acl'
        ? { matched: true, allowed: true, reason: 'delegated_acl' }
        : { matched: false, allowed: false, reason: 'acl_no_match' };
    }
  } as unknown as WikiAclService;
  const service = new WikiPermissionService(store as unknown as PrismaService, acl);
  const decision = await service.canManageThreadAcl({
    actor: actor({ profileId: 999n }),
    thread: { id: 30n, pageId: 1n, status: 'open' },
    page: page()
  });
  assert.equal(decision.allowed, true);
  assert.match(decision.reason, /delegated_acl/);
});

test('batch page visibility loads ACL decisions once and preserves candidate order', async () => {
  let batchCalls = 0;
  let receivedRequestIp: string | null | undefined;
  const service = createService({
    acl: {
      async evaluateReadBatch(input: { requestIp?: string | null }) {
        batchCalls += 1;
        receivedRequestIp = input.requestIp;
        return new Map([
          [1n, { matched: false, allowed: false, reason: 'acl_no_match' }],
          [2n, { matched: true, allowed: false, reason: 'private_page' }]
        ]);
      }
    } as WikiAclService
  });

  const result = await service.filterReadablePages({
    pages: [page({ id: 1n }), page({ id: 2n }), page({ id: 3n, status: 'deleted' })],
    requestIp: ''
  });

  assert.deepEqual(result.map((item) => item.id), [1n]);
  assert.equal(batchCalls, 1);
  assert.equal(receivedRequestIp, '');
});

test('single-page ACL fallback preserves explicit neutral address context', async () => {
  let receivedRequestIp: string | null | undefined;
  const service = createService({
    roles: ['owner'],
    acl: {
      async evaluate(input: { requestIp?: string | null }) {
        receivedRequestIp = input.requestIp;
        return { matched: false, allowed: false, reason: 'acl_no_match' };
      },
      async evaluateReadBatch() { return new Map(); }
    } as unknown as WikiAclService
  });

  const result = await service.filterReadablePages({
    actor: actor(),
    pages: [page({ protectionLevel: 'custom_restricted' })],
    requestIp: ''
  });

  assert.deepEqual(result.map((item) => item.id), [1n]);
  assert.equal(receivedRequestIp, '');
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

test('page action ACL evaluates the complete browser actor and explicit request address', async () => {
  const evaluations: Array<{ action: string; actor: WikiPermissionActor | null; requestIp?: string | null }> = [];
  const browserActor = actor({
    groups: ['admin'],
    permissions: ['wiki.history.private'],
    requestIp: '198.51.100.9'
  });
  const service = createService({
    acl: {
      async evaluate(input: { action: string; actor: WikiPermissionActor | null; requestIp?: string | null }) {
        evaluations.push(input);
        return input.action === 'history'
          ? { matched: true, allowed: true, reason: 'session_claim_allow' }
          : { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as unknown as WikiAclService
  });

  const decision = await service.canUsePageAction({
    accountId: browserActor.accountId,
    actor: browserActor,
    requestIp: browserActor.requestIp,
    action: 'history',
    page: page()
  });

  assert.deepEqual(decision, { allowed: true, reason: 'session_claim_allow' });
  assert.equal(evaluations.length, 2);
  assert.equal(evaluations.every((input) => input.actor === browserActor), true);
  assert.equal(evaluations.every((input) => input.requestIp === '198.51.100.9'), true);
});

test('edit-request ACL preserves the readable default and enforces an explicit create-target deny', async () => {
  const activeActor = actor({ profileId: 200n });
  const openService = createService({
    acl: {
      async evaluate() {
        return { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  });
  await openService.assertCanUseCreateTargetAction({
    actor: activeActor,
    action: 'edit_request',
    namespaceId: 1,
    namespaceCode: 'guide',
    spaceId: 10n,
    title: '새 문서'
  });

  const deniedService = createService({
    acl: {
      async evaluate(input: { action: string }) {
        return input.action === 'edit_request'
          ? { matched: true, allowed: false, reason: 'requests_closed' }
          : { matched: false, allowed: false, reason: 'acl_no_match' };
      }
    } as WikiAclService
  });
  await assert.rejects(
    deniedService.assertCanUseCreateTargetAction({
      actor: activeActor,
      action: 'edit_request',
      namespaceId: 1,
      namespaceCode: 'guide',
      spaceId: 10n,
      title: '새 문서'
    }),
    (error: unknown) => error instanceof ForbiddenException && error.message.includes('requests_closed')
  );
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
    space: { id: 10n, status: 'active', spaceType: 'server_wiki' },
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'account-1' }
  });
  const decision = await service.canEditPage({
    actor: actor({ profileId: 200n }),
    page: page({ protectionLevel: 'owner_only', createdBy: 300n })
  });

  assert.equal(decision.allowed, true);
});

test('server wiki publication hides drafts while preserving owner and collaborator preview', async () => {
  const linked = {
    space: { id: 10n, status: 'active', spaceType: 'server_wiki', rootPageId: 1n },
    serverWiki: { voteServerId: 'server-1', createdBy: 300n, publicationStatus: 'draft' },
    server: { ownerAccountId: 'account-1' }
  } as const;
  const target = page();

  assert.deepEqual(
    await createService(linked).canReadPage({ actor: null, page: target }),
    { allowed: false, reason: 'server_wiki_not_published' }
  );
  assert.equal((await createService(linked).canReadPage({
    actor: actor({ accountId: 'account-2', profileId: 200n }),
    page: target
  })).allowed, false);
  assert.equal((await createService(linked).canReadPage({
    actor: actor({ accountId: 'account-1', profileId: 300n }),
    page: target
  })).allowed, true);
  assert.equal((await createService({ ...linked, roles: ['reviewer'] }).canReadPage({
    actor: actor({ accountId: 'account-2', profileId: 200n }),
    page: target
  })).allowed, true);
  assert.equal((await createService(linked).canReadPage({
    actor: actor({ accountId: 'account-2', profileId: 200n, permissions: ['server.admin'] }),
    page: target
  })).allowed, true);
});

test('batch page visibility applies the same publication gate as direct reads', async () => {
  const options = {
    space: { id: 10n, status: 'active', spaceType: 'server_wiki', rootPageId: 1n },
    serverWiki: { voteServerId: 'server-1', createdBy: 300n, publicationStatus: 'unpublished' },
    server: { ownerAccountId: 'account-1' }
  } as const;
  const target = page();

  assert.deepEqual(await createService(options).filterReadablePages({ actor: null, pages: [target] }), []);
  assert.deepEqual(
    await createService({ ...options, roles: ['editor'] }).filterReadablePages({
      actor: actor({ accountId: 'account-2', profileId: 200n }),
      pages: [target]
    }),
    [target]
  );
});

test('published server wiki stays private without a canonical active ranking parent', async () => {
  const target = page();
  const base = {
    space: { id: 10n, status: 'active', spaceType: 'server_wiki', rootPageId: 1n },
    serverWiki: { voteServerId: 'server-1', createdBy: 300n, publicationStatus: 'published' },
    server: { ownerAccountId: 'account-1' }
  } as const;

  assert.equal((await createService(base).canReadPage({ actor: null, page: target })).allowed, true);
  assert.deepEqual(
    await createService({ ...base, serverWiki: { ...base.serverWiki, voteServerId: null } })
      .canReadPage({ actor: null, page: target }),
    { allowed: false, reason: 'server_wiki_not_published' }
  );
  assert.deepEqual(
    await createService({ ...base, server: { ...base.server, listingStatus: 'suspended' } })
      .filterReadablePages({ actor: null, pages: [target] }),
    []
  );
  assert.deepEqual(
    await createService({ ...base, server: { ...base.server, wikiPageId: 999n } })
      .canReadPage({ actor: null, page: target }),
    { allowed: false, reason: 'server_wiki_not_published' }
  );
});

test('published server wiki hides pages and revisions absent from the active release', async () => {
  const service = createService({
    space: { id: 10n, status: 'active', spaceType: 'server_wiki', rootPageId: 1n },
    serverWiki: { voteServerId: 'server-1', createdBy: 300n, publicationStatus: 'published' },
    server: { ownerAccountId: 'account-1' },
  });

  const scope = await service.resolvePublishedRevisionScope({ actor: null, page: page() });
  assert.deepEqual(scope?.revisionItems.map((item) => item.revisionId), [11n, 10n]);

  assert.deepEqual(
    await service.canReadPage({ actor: null, page: page({ id: 2n }), revision: { id: 12n, visibility: 'public' } }),
    { allowed: false, reason: 'server_wiki_page_not_released' },
  );
  assert.deepEqual(
    await service.canReadPage({ actor: null, page: page(), revision: { id: 12n, visibility: 'public' } }),
    { allowed: false, reason: 'server_wiki_page_not_released' },
  );
  assert.equal((await service.canReadPage({
    actor: null,
    page: page(),
    revision: { id: 11n, visibility: 'public' },
  })).allowed, true);
  assert.equal((await service.canReadPage({
    actor: null,
    page: page(),
    revision: { id: 10n, visibility: 'public' },
  })).allowed, true);
});

test('linked server wiki authority ignores provenance and follows active canonical server ownership', async () => {
  const linked = {
    space: {
      id: 10n,
      status: 'active',
      spaceType: 'server_wiki',
      rootPageId: 1n,
      ownerUserId: 300n,
      createdBy: 300n
    },
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'canonical-owner' },
    accounts: [
      { id: 'old-creator', canonicalAccountId: null, lifecycleStatus: 'active' },
      { id: 'canonical-owner', canonicalAccountId: null, lifecycleStatus: 'active' },
      { id: 'owner-alias', canonicalAccountId: 'canonical-owner', lifecycleStatus: 'active' },
      { id: 'manager-account', canonicalAccountId: null, lifecycleStatus: 'active' }
    ]
  } as const;
  const historicalPage = page({ createdBy: 300n, ownerProfileId: 300n, protectionLevel: 'owner_only' });
  const thread = { id: 50n, pageId: historicalPage.id, status: 'open' };
  const createTarget = { namespaceId: 1, namespaceCode: 'server', spaceId: 10n, title: '운영 규칙' };
  const oldCreator = actor({ accountId: 'old-creator', profileId: 300n });
  const owner = actor({ accountId: 'canonical-owner', profileId: 400n });
  const ownerAlias = actor({ accountId: 'owner-alias', profileId: 401n });
  const manager = actor({ accountId: 'manager-account', profileId: 500n });

  const service = createService(linked);
  assert.equal(await service.canManagePage({ actor: oldCreator, page: historicalPage }), false);
  assert.equal(await service.canManageSpace({ actor: oldCreator, spaceId: 10n }), false);
  assert.equal(await service.canManageCreateTarget({ actor: oldCreator, ...createTarget }), false);
  assert.equal((await service.canEditPage({ actor: oldCreator, page: historicalPage })).allowed, false);
  assert.equal((await service.canCreatePage({ actor: oldCreator, ...createTarget })).allowed, false);
  assert.equal((await service.canManageThreadAcl({ actor: oldCreator, page: historicalPage, thread })).allowed, false);

  for (const currentOwner of [owner, ownerAlias]) {
    assert.equal(await service.canManagePage({ actor: currentOwner, page: historicalPage }), true);
    assert.equal(await service.canManageSpace({ actor: currentOwner, spaceId: 10n }), true);
    assert.equal(await service.canManageCreateTarget({ actor: currentOwner, ...createTarget }), true);
    assert.equal((await service.canEditPage({ actor: currentOwner, page: historicalPage })).allowed, true);
    assert.equal((await service.canCreatePage({ actor: currentOwner, ...createTarget })).allowed, true);
    assert.equal((await service.canManageThreadAcl({ actor: currentOwner, page: historicalPage, thread })).allowed, true);
  }

  const managerService = createService({ ...linked, roles: ['manager'] });
  assert.equal(await managerService.canManagePage({ actor: manager, page: historicalPage }), true);
  assert.equal(await managerService.canManageSpace({ actor: manager, spaceId: 10n }), true);
  assert.equal(await managerService.canManageCreateTarget({ actor: manager, ...createTarget }), true);
  assert.equal((await managerService.canEditPage({ actor: manager, page: historicalPage })).allowed, true);
  assert.equal((await managerService.canManageThreadAcl({ actor: manager, page: historicalPage, thread })).allowed, true);
});

test('linked server wiki management fails closed when the canonical linkage invariant is broken', async () => {
  const inconsistent = createService({
    space: {
      id: 10n,
      status: 'active',
      spaceType: 'server_wiki',
      rootPageId: 1n,
      ownerUserId: 300n,
      createdBy: 300n
    },
    roles: ['manager'],
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'account-1', wikiPageId: 999n }
  });
  const historicalPage = page({ createdBy: 300n, ownerProfileId: 300n, protectionLevel: 'owner_only' });

  assert.equal(await inconsistent.canManagePage({ actor: actor({ profileId: 300n }), page: historicalPage }), false);
  assert.equal(await inconsistent.canManageSpace({ actor: actor(), spaceId: 10n }), false);
  assert.equal((await inconsistent.canEditPage({ actor: actor(), page: historicalPage })).allowed, false);
  assert.equal(await inconsistent.canManagePage({
    actor: actor({ profileId: 999n, permissions: ['wiki.admin'] }),
    page: historicalPage
  }), true);

  const archivedLink = createService({
    space: { id: 10n, status: 'active', spaceType: 'server_wiki', ownerUserId: 300n, createdBy: 300n },
    roles: ['manager'],
    serverWiki: { voteServerId: 'server-1', createdBy: 300n, status: 'archived' },
    server: { ownerAccountId: 'account-1' }
  });
  assert.equal(await archivedLink.canManagePage({ actor: actor({ profileId: 300n }), page: historicalPage }), false);

  const archivedSpace = createService({
    space: { id: 10n, status: 'archived', spaceType: 'server_wiki', ownerUserId: 300n, createdBy: 300n },
    roles: ['manager'],
    serverWiki: { voteServerId: null, createdBy: 300n, status: 'archived' }
  });
  assert.equal(await archivedSpace.canManagePage({ actor: actor({ profileId: 300n }), page: historicalPage }), false);

  const identityCollision = createService({
    space: { id: 10n, status: 'active', spaceType: 'server_wiki', rootPageId: 1n },
    roles: ['manager'],
    serverWiki: {
      voteServerId: 'server-1',
      createdBy: 300n,
      serverName: 'LunaFarm',
      host: 'lunaf.kr',
    },
    server: {
      ownerAccountId: 'account-1',
      name: 'CreeperWiki',
      joinHost: 'creeper.wiki',
    },
  });
  assert.equal(await identityCollision.canManagePage({ actor: actor(), page: historicalPage }), false);
  assert.equal(await identityCollision.canManageSpace({ actor: actor(), spaceId: 10n }), false);
  assert.equal((await identityCollision.canEditPage({ actor: actor(), page: historicalPage })).allowed, false);
});

test('ownership challenge blocks linked owner, provenance, and delegated manager authority', async () => {
  const service = createService({
    space: {
      id: 10n,
      status: 'active',
      spaceType: 'server_wiki',
      rootPageId: 1n,
      ownerUserId: 300n,
      createdBy: 300n,
    },
    roles: ['manager'],
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: {
      ownerAccountId: 'account-1',
      ownershipChallengeSuspendedAt: new Date('2026-07-19T00:00:00.000Z'),
    },
  });
  const protectedPage = page({ createdBy: 300n, protectionLevel: 'owner_only' });

  assert.equal(await service.canManagePage({ actor: actor({ accountId: 'account-1', profileId: 300n }), page: protectedPage }), false);
  assert.equal(await service.canManageSpace({ actor: actor({ accountId: 'account-1', profileId: 300n }), spaceId: 10n }), false);
  assert.equal(await service.canManagePage({ actor: actor({ accountId: 'manager', profileId: 500n }), page: protectedPage }), false);
  assert.equal((await service.canEditPage({ actor: actor({ accountId: 'account-1', profileId: 300n }), page: protectedPage })).allowed, false);
});

test('legacy unlinked server wiki keeps its narrow provenance fallback', async () => {
  const legacySpaceOwner = createService({
    space: {
      id: 10n,
      status: 'active',
      spaceType: 'server_wiki',
      ownerUserId: 200n,
      createdBy: 999n
    },
    serverWiki: { voteServerId: null, createdBy: 300n }
  });
  const legacyWikiCreator = createService({
    space: {
      id: 10n,
      status: 'active',
      spaceType: 'server_wiki',
      ownerUserId: 999n,
      createdBy: 999n
    },
    serverWiki: { voteServerId: null, createdBy: 300n }
  });

  assert.equal(await legacySpaceOwner.canManageSpace({
    actor: actor({ profileId: 200n }),
    spaceId: 10n
  }), true);
  assert.equal(await legacyWikiCreator.canManagePage({
    actor: actor({ profileId: 300n }),
    page: page({ createdBy: 999n, ownerProfileId: null })
  }), true);
  assert.equal((await legacyWikiCreator.canCreatePage({
    actor: actor({ profileId: 300n }),
    namespaceCode: 'server',
    spaceId: 10n,
    title: '레거시 문서'
  })).allowed, true);
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

test('read-denied pages cannot be moved, deleted, or reverted through direct mutation calls', async () => {
  const service = createService({
    acl: {
      async evaluate(input) {
        if (input.action === 'read') {
          return { matched: true, allowed: false, reason: 'hidden_page' };
        }
        return { matched: true, allowed: true, reason: `allowed_${input.action}` };
      }
    } as WikiAclService
  });
  const editor = actor({ profileId: 200n });
  const target = page({ createdBy: 100n });

  for (const action of ['move', 'delete', 'revert'] as const) {
    await assert.rejects(
      service.assertCanMutatePageAction({ actor: editor, action, page: target }),
      /not found/i
    );
  }
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
    space: { id: 10n, status: 'active', spaceType: 'server_wiki' },
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

test('anonymous discussion creation requires explicit guest-compatible ACL allows', async () => {
  const allowed = createService({
    acl: {
      async evaluate(input) {
        if (input.action === 'read') return { matched: false, allowed: false, reason: 'acl_no_match' };
        return { matched: true, allowed: true, reason: 'guest_allow' };
      },
    } as WikiAclService,
  });
  await allowed.assertCanCreateThread({ actor: null, page: page(), requestIp: '192.0.2.20' });

  const noRule = createService({
    acl: {
      async evaluate(input) {
        return { matched: false, allowed: false, reason: `no_${input.action}` };
      },
    } as WikiAclService,
  });
  await assert.rejects(
    noRule.assertCanCreateThread({ actor: null, page: page(), requestIp: '192.0.2.20' }),
    ForbiddenException,
  );
});

test('anonymous discussion ACL evaluation preserves the validated request address', async () => {
  const observed: Array<string | null | undefined> = [];
  const service = createService({
    acl: {
      async evaluate(input) {
        if (input.action !== 'read') observed.push(input.requestIp);
        return input.action === 'read'
          ? { matched: false, allowed: false, reason: 'acl_no_match' }
          : { matched: true, allowed: false, reason: 'blocked_ip_group' };
      },
    } as WikiAclService,
  });
  await assert.rejects(
    service.assertCanWriteThreadComment({ actor: null, page: page(), requestIp: '198.51.100.7' }),
    /blocked_ip_group/,
  );
  assert.deepEqual(observed, ['198.51.100.7']);
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

test('space management preserves active owner, subwiki, server, mod, and admin authority', async () => {
  const spaceId = 10n;

  assert.equal(await createService({
    space: { id: spaceId, status: 'active', ownerUserId: 100n, createdBy: 300n }
  }).canManageSpace({ actor: actor(), spaceId }), true);
  assert.equal(await createService({ roles: ['manager'] }).canManageSpace({ actor: actor(), spaceId }), true);
  assert.equal(await createService({
    space: { id: spaceId, status: 'active', spaceType: 'server_wiki' },
    serverWiki: { voteServerId: 'server-1', createdBy: 300n },
    server: { ownerAccountId: 'account-1' }
  }).canManageSpace({ actor: actor({ profileId: 200n }), spaceId }), true);
  assert.equal(await createService({
    modWiki: { verifiedBy: 100n }
  }).canManageSpace({ actor: actor(), spaceId }), true);
  assert.equal(await createService().canManageSpace({
    actor: actor({ profileId: 200n, permissions: ['wiki.admin'] }), spaceId
  }), true);
  assert.equal(await createService().canManageSpace({ actor: actor({ profileId: 200n }), spaceId }), false);
  assert.equal(await createService({
    space: { id: spaceId, status: 'deleted', ownerUserId: 100n, createdBy: 100n }
  }).canManageSpace({ actor: actor({ permissions: ['wiki.admin'] }), spaceId }), false);
});

test('wiki roles keep reviewer least-privileged while editor and manager retain their distinct duties', async () => {
  const target = page({ createdBy: 999n, protectionLevel: 'trusted_only' });
  const reviewer = actor({ profileId: 200n });
  const editor = actor({ profileId: 200n });
  const manager = actor({ profileId: 200n });
  const reviewerService = createService({
    roles: ['reviewer'],
    space: { id: 10n, status: 'active', ownerUserId: 999n, createdBy: 999n, spaceType: 'server_wiki' },
    serverWiki: { voteServerId: 'server-1', createdBy: 999n },
    server: { ownerAccountId: 'account-2' }
  });
  const editorService = createService({
    roles: ['editor'],
    space: { id: 10n, status: 'active', ownerUserId: 999n, createdBy: 999n, spaceType: 'server_wiki' },
    serverWiki: { voteServerId: 'server-1', createdBy: 999n },
    server: { ownerAccountId: 'account-2' }
  });
  const managerService = createService({
    roles: ['manager'],
    space: { id: 10n, status: 'active', ownerUserId: 999n, createdBy: 999n, spaceType: 'server_wiki' },
    serverWiki: { voteServerId: 'server-1', createdBy: 999n },
    server: { ownerAccountId: 'account-2' }
  });
  const createTarget = {
    namespaceId: 1,
    namespaceCode: 'server',
    spaceId: 10n,
    title: '규칙'
  };

  assert.equal((await reviewerService.canEditPage({ actor: reviewer, page: target })).allowed, false);
  assert.equal((await reviewerService.canCreatePage({ actor: reviewer, ...createTarget })).allowed, false);
  assert.equal(await reviewerService.canReviewPage({ actor: reviewer, page: target }), true);
  assert.equal(await reviewerService.canReviewCreateTarget({ actor: reviewer, ...createTarget }), true);
  assert.equal(await reviewerService.canModeratePage({ actor: reviewer, page: target }), true);
  assert.equal(await reviewerService.canManagePage({ actor: reviewer, page: target }), false);
  assert.equal(await reviewerService.canManageCreateTarget({ actor: reviewer, ...createTarget }), false);
  assert.equal(await reviewerService.canManageSpace({ actor: reviewer, spaceId: 10n }), false);
  assert.equal((await reviewerService.canManagePageAcl({ actor: reviewer, page: target })).allowed, false);
  await assert.rejects(
    reviewerService.assertCanMutatePageAction({ actor: reviewer, action: 'move', page: target }),
    ForbiddenException
  );
  await assert.rejects(
    reviewerService.assertCanMutatePageAction({ actor: reviewer, action: 'delete', page: target }),
    ForbiddenException
  );

  assert.equal((await editorService.canEditPage({ actor: editor, page: target })).allowed, true);
  assert.equal((await editorService.canCreatePage({ actor: editor, ...createTarget })).allowed, true);
  assert.equal(await editorService.canReviewPage({ actor: editor, page: target }), false);
  assert.equal(await editorService.canModeratePage({ actor: editor, page: target }), false);
  assert.equal(await editorService.canManagePage({ actor: editor, page: target }), false);

  assert.equal((await managerService.canEditPage({ actor: manager, page: target })).allowed, true);
  assert.equal((await managerService.canCreatePage({ actor: manager, ...createTarget })).allowed, true);
  assert.equal(await managerService.canReviewPage({ actor: manager, page: target }), true);
  assert.equal(await managerService.canReviewCreateTarget({ actor: manager, ...createTarget }), true);
  assert.equal(await managerService.canModeratePage({ actor: manager, page: target }), true);
  assert.equal(await managerService.canManagePage({ actor: manager, page: target }), true);
  assert.equal(await managerService.canManageCreateTarget({ actor: manager, ...createTarget }), true);
  assert.equal(await managerService.canManageSpace({ actor: manager, spaceId: 10n }), true);
  assert.equal((await managerService.canManagePageAcl({ actor: manager, page: target })).allowed, true);
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
