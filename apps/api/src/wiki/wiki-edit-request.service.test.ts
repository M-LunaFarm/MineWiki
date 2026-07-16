import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiEditService } from './wiki-edit.service';
import { WikiEditRequestService } from './wiki-edit-request.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import type { WikiRoutePathResolver } from './wiki-route-path.resolver';
import type { WikiContributionPolicyService } from './wiki-contribution-policy.service';

const session = { userId: 'account-1' } as SessionPayload;
const page = {
  id: 10n, namespaceId: 1, spaceId: 2n, localPath: 'guide', slug: 'guide', title: 'Guide', displayTitle: 'Guide',
  currentRevisionId: 30n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 20n,
  createdAt: new Date('2026-01-01T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z')
};
const request = {
  id: 40n, pageId: page.id, baseRevisionId: 30n, proposedContent: 'next', editSummary: 'update', isMinor: false,
  status: 'pending', createdBy: 99n, reviewedBy: null, reviewNote: null, acceptedRevisionId: null,
  contributionPolicyVersion: null,
  createdAt: new Date('2026-01-02T00:00:00Z'), updatedAt: new Date('2026-01-02T00:00:00Z'), reviewedAt: null
};

function createService(canManage = false) {
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    async $queryRaw() { return [{ id: page.id }]; },
    wikiPage: { async findUnique() { return page; } },
    wikiEditRequest: {
      async findUnique() { return request; },
      async findFirst() { return null; },
      async create() { throw new Error('create should not run'); }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction() {},
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async canManagePage() { return canManage; }
  } as unknown as WikiPermissionService;
  return new WikiEditRequestService(prisma, profiles, permissions, {} as WikiEditService);
}

test('edit request creation rejects a stale base revision before persistence', async () => {
  await assert.rejects(
    createService().create(session, page.id.toString(), {
      baseRevisionId: '29', contentRaw: 'new content', editSummary: 'change'
    }),
    ConflictException
  );
});

test('new-page edit requests persist an immutable target under a namespace lock', async () => {
  let namespaceLocks = 0;
  let storedData: Record<string, unknown> | null = null;
  let readableSpace: bigint | null = null;
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    async $queryRaw() { namespaceLocks += 1; return [{ id: 7 }]; },
    wikiPage: { async findUnique() { return null; } },
    wikiEditRequest: {
      async findFirst() { return null; },
      async create(args: { data: Record<string, unknown> }) {
        storedData = args.data;
        return { id: 71n, reviewedBy: null, reviewNote: null, acceptedRevisionId: null, reviewedAt: null, ...args.data };
      }
    },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 99n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 99n, status: 'active' }; },
    async assertCanReadCreateTarget(input: { spaceId: bigint }) { readableSpace = input.spaceId; }
  } as unknown as WikiPermissionService;
  const edits = {
    async resolveCreatePageTarget() {
      return {
        namespaceId: 7, namespaceCode: 'server', spaceId: 8n, title: 'sample/규칙', slug: 'sample/규칙',
        displayTitle: '규칙', pageType: 'server'
      };
    }
  } as unknown as WikiEditService;
  const contributionPolicies = {
    async assertAccepted(_spaceId: bigint, acceptance: { accepted?: boolean; version?: number }) {
      assert.deepEqual(acceptance, { accepted: true, version: 6 });
      return 6;
    },
  } as unknown as WikiContributionPolicyService;
  const service = new WikiEditRequestService(
    prisma,
    profiles,
    permissions,
    edits,
    undefined,
    undefined,
    undefined,
    contributionPolicies,
  );

  const result = await service.createForNewPage(session, {
    namespace: 'server', title: 'sample/규칙', contentRaw: '규칙 초안', editSummary: '규칙 문서 제안',
    policyAcceptance: { accepted: true, version: 6 },
  });

  assert.equal(namespaceLocks, 1);
  assert.equal(readableSpace, 8n);
  assert.equal(storedData?.requestKind, 'create');
  assert.equal(storedData?.pageId, null);
  assert.equal(storedData?.baseRevisionId, null);
  assert.equal(storedData?.targetNamespaceId, 7);
  assert.equal(storedData?.targetSpaceId, 8n);
  assert.equal(storedData?.targetSlug, 'sample/규칙');
  assert.equal(storedData?.contributionPolicyVersion, 6);
  assert.equal(result.requestKind, 'create');
  assert.equal(result.pageId, null);
  assert.equal(result.targetDisplayTitle, '규칙');
  assert.equal(Number.isNaN(Date.parse(result.createdAt)), false);
});

test('new-page edit requests reject a title that appeared before the namespace lock was acquired', async () => {
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    async $queryRaw() { return [{ id: 7 }]; },
    wikiPage: { async findUnique() { return { id: 123n }; } },
    wikiEditRequest: { async create() { throw new Error('create should not run'); } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 99n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 99n, status: 'active' }; },
    async assertCanReadCreateTarget() {}
  } as unknown as WikiPermissionService;
  const edits = {
    async resolveCreatePageTarget() {
      return { namespaceId: 7, namespaceCode: 'guide', spaceId: 8n, title: 'Guide', slug: 'guide', displayTitle: 'Guide', pageType: 'article' };
    }
  } as unknown as WikiEditService;

  await assert.rejects(
    new WikiEditRequestService(prisma, profiles, permissions, edits).createForNewPage(session, {
      namespace: 'guide', title: 'Guide', contentRaw: '초안', editSummary: '새 문서'
    }),
    ConflictException
  );
});

test('accepting a new-page request delegates atomic page creation and preserves request attribution', async () => {
  const createRequest = {
    ...request,
    requestKind: 'create',
    pageId: null,
    baseRevisionId: null,
    targetNamespaceId: 7,
    targetNamespaceCode: 'guide',
    targetSpaceId: 8n,
    targetTitle: '새 문서',
    targetSlug: '새_문서',
    targetDisplayTitle: '새 문서',
    targetPageType: 'article'
  };
  const accepted = { ...createRequest, pageId: 55n, status: 'accepted', reviewedBy: 20n, acceptedRevisionId: 66n };
  let acceptedId: bigint | null = null;
  const prisma = {
    wikiEditRequest: { async findUnique() { return createRequest; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }, { id: 20n, displayName: '검토자' }]; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const edits = {
    async acceptCreateEditRequest(_session: SessionPayload, input: { requestId: bigint }) {
      acceptedId = input.requestId;
      return { request: accepted, mutation: { pageId: '55', revisionId: '66', revisionNo: 1, namespace: 'guide', title: '새 문서', slug: '새_문서' } };
    }
  } as unknown as WikiEditService;

  const result = await new WikiEditRequestService(prisma, profiles, {} as WikiPermissionService, edits).accept(session, '40');

  assert.equal(acceptedId, 40n);
  assert.equal(result.pageId, '55');
  assert.equal(result.createdBy, '99');
  assert.equal(result.reviewedBy, '20');
});

test('edit request detail enforces page visibility and returns the exact request', async () => {
  let readChecked = false;
  let rawChecked = false;
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiEditRequest: { async findUnique() { return request; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() { readChecked = true; },
    async assertCanUsePageAction(input: { action: string }) {
      assert.equal(input.action, 'raw');
      rawChecked = true;
    }
  } as unknown as WikiPermissionService;

  const result = await new WikiEditRequestService(prisma, {} as WikiProfileService, permissions, {} as WikiEditService).get('40');

  assert.equal(result.id, '40');
  assert.equal(result.pageId, '10');
  assert.equal(result.createdByName, '작성자');
  assert.equal(readChecked, true);
  assert.equal(rawChecked, true);
});

test('global edit request queue resolves readable pages and reviewer capability', async () => {
  let namespaceCode = 'guide';
  const prisma = {
    wikiEditRequest: { async findMany() { return [request]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: namespaceCode }]; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const actions: string[] = [];
  let reviewAllowed = true;
  const permissions = {
    async assertCanReadPage() { actions.push('read'); },
    async assertCanUsePageAction(input: { action: string }) { actions.push(input.action); },
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async canManagePage() { return reviewAllowed; }
  } as unknown as WikiPermissionService;
  const routes = {
    async preload() {
      return {
        routePath() { return namespaceCode === 'server' ? '/server/luna/guide' : '/guide/guide'; },
        serverSlug() { return namespaceCode === 'server' ? 'luna' : undefined; }
      };
    }
  } as unknown as WikiRoutePathResolver;
  const service = new WikiEditRequestService(
    prisma,
    profiles,
    permissions,
    {} as WikiEditService,
    undefined,
    undefined,
    routes
  );

  const result = await service.listGlobal(session, { status: 'open', namespace: 'guide' });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.routePath, '/guide/guide');
  assert.equal(result.items[0]?.detailPath, '/wiki/edit-requests/10?request=40&returnTo=%2Fguide%2Fguide');
  assert.equal(result.items[0]?.canReview, true);
  assert.equal(result.items[0]?.namespace, 'guide');
  assert.equal(result.viewerProfileId, '20');
  assert.deepEqual(actions, ['read', 'raw']);

  const reviewable = await service.listGlobal(session, { status: 'open', scope: 'reviewable' });
  assert.equal(reviewable.items.length, 1);
  assert.equal(reviewable.items[0]?.id, request.id.toString());

  reviewAllowed = false;
  const hidden = await service.listGlobal(session, { status: 'open', scope: 'reviewable' });
  assert.equal(hidden.items.length, 0);

  reviewAllowed = true;
  namespaceCode = 'server';
  const serverQueue = await service.listGlobal(session, { status: 'open', scope: 'reviewable' });
  assert.equal(serverQueue.items[0]?.detailPath, '/server/luna/_tools/requests/guide?request=40');
});

test('reviewable summary follows the permission-filtered queue until it is exhausted', async () => {
  const service = createService();
  const cursors: Array<string | undefined> = [];
  service.listGlobal = async (_session, input) => {
    cursors.push(input.cursor);
    if (!input.cursor) {
      return {
        items: Array.from({ length: 50 }, (_, index) => ({ id: `${index + 1}` })) as never,
        viewerProfileId: '20',
        nextCursor: '50'
      };
    }
    return {
      items: [{ id: '51' }, { id: '52' }] as never,
      viewerProfileId: '20',
      nextCursor: null
    };
  };

  const result = await service.reviewableSummary(session);

  assert.deepEqual(result, { count: 52, capped: false });
  assert.deepEqual(cursors, [undefined, '50']);
});

test('reviewable queue scans past a full non-reviewable batch before returning an eligible request', async () => {
  const hiddenRequests = Array.from({ length: 100 }, (_, index) => ({
    ...request,
    id: BigInt(300 - index),
    pageId: BigInt(300 - index)
  }));
  const eligibleRequest = { ...request, id: 100n, pageId: 999n };
  const prisma = {
    wikiEditRequest: {
      async findMany(args: { where: { id?: { lt?: bigint } } }) {
        return args.where.id?.lt ? [eligibleRequest] : hiddenRequests;
      }
    },
    wikiPage: {
      async findMany(args: { where: { id: { in: bigint[] } } }) {
        return args.where.id.in.map((id) => ({ ...page, id, title: `Page ${id}`, displayTitle: `Page ${id}` }));
      }
    },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'guide' }]; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction() {},
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async canManagePage({ page: target }: { page: { id: bigint } }) { return target.id === 999n; }
  } as unknown as WikiPermissionService;
  const service = new WikiEditRequestService(prisma, profiles, permissions, {} as WikiEditService);

  const result = await service.listGlobal(session, { status: 'open', scope: 'reviewable', limit: 1 });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.id, '100');
  assert.equal(result.nextCursor, null);
});

test('reviewable summary distinguishes exact counts from a capped result', async () => {
  for (const [total, expected] of [
    [99, { count: 99, capped: false }],
    [100, { count: 100, capped: false }],
    [101, { count: 100, capped: true }]
  ] as const) {
    const service = createService();
    service.listGlobal = async (_session, input) => {
      const offset = Number(input.cursor ?? 0);
      const count = Math.min(50, total - offset);
      const nextOffset = offset + count;
      return {
        items: Array.from({ length: count }, (_, index) => ({ id: `${offset + index + 1}` })) as never,
        viewerProfileId: '20',
        nextCursor: nextOffset < total ? nextOffset.toString() : null
      };
    };

    assert.deepEqual(await service.reviewableSummary(session), expected);
  }
});

test('reviewable queue requires an authenticated wiki profile', async () => {
  await assert.rejects(
    createService().listGlobal(null, { status: 'open', scope: 'reviewable' }),
    ForbiddenException
  );
});

test('reviewable queue includes an authorized new-page request with its canonical detail link', async () => {
  const createRequest = {
    ...request,
    id: 71n,
    requestKind: 'create',
    pageId: null,
    baseRevisionId: null,
    targetNamespaceId: 7,
    targetNamespaceCode: 'server',
    targetSpaceId: 8n,
    targetTitle: 'luna/규칙',
    targetSlug: 'luna/규칙',
    targetDisplayTitle: '규칙',
    targetPageType: 'server',
    targetOwnerProfileId: null
  };
  const prisma = {
    wikiEditRequest: { async findMany() { return [createRequest]; } },
    wikiPage: { async findMany() { return []; } },
    wikiNamespace: { async findMany() { return []; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async assertCanReadCreateTarget() {},
    async canManageCreateTarget() { return true; }
  } as unknown as WikiPermissionService;
  const service = new WikiEditRequestService(prisma, profiles, permissions, {} as WikiEditService);

  const result = await service.listGlobal(session, { status: 'open', scope: 'reviewable' });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.requestKind, 'create');
  assert.equal(result.items[0]?.detailPath, '/wiki/edit-requests/request/71?returnTo=%2Fserver%2Fluna%2F%25EA%25B7%259C%25EC%25B9%2599');
});

test('only a page manager can reject an edit request', async () => {
  await assert.rejects(
    createService(false).reject(session, request.id.toString(), 'not accepted'),
    ForbiddenException
  );
});

test('the author can rebase, close, and reopen an edit request', async () => {
  const stored = {
    ...request,
    status: 'stale',
    baseRevisionId: 29n,
    proposedContent: '== 소개 ==\n내 변경\n\n== 접속 ==\nold.example.kr\n'
  };
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    async $queryRaw() { return [{ id: page.id }]; },
    wikiPage: { async findUnique() { return page; } },
    wikiProfile: { async findMany() { return [{ id: 99n, displayName: '작성자' }]; } },
    wikiPageRevision: {
      async findUnique(args: { where: { id: bigint } }) {
        if (args.where.id === 29n) {
          return {
            id: 29n,
            pageId: page.id,
            revisionNo: 1,
            visibility: 'public',
            contentRaw: '== 소개 ==\n기준\n\n== 접속 ==\nold.example.kr\n'
          };
        }
        if (args.where.id === 30n) {
          return {
            id: 30n,
            pageId: page.id,
            revisionNo: 2,
            visibility: 'public',
            contentRaw: '== 소개 ==\n기준\n\n== 접속 ==\nplay.example.kr\n'
          };
        }
        return null;
      }
    },
    wikiEditRequest: {
      async findUnique() { return { ...stored }; },
      async findUniqueOrThrow() { return { ...stored }; },
      async findFirst() { return null; },
      async updateMany(args: { where: { status: string }; data: Record<string, unknown> }) {
        if (stored.status !== args.where.status) return { count: 0 };
        Object.assign(stored, args.data);
        return { count: 1 };
      }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 99n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction() {}
  } as unknown as WikiPermissionService;
  const service = new WikiEditRequestService(prisma, profiles, permissions, {} as WikiEditService);

  const updated = await service.rebase(session, '40');
  assert.equal(updated.status, 'pending');
  assert.equal(updated.baseRevisionId, '30');
  assert.match(updated.proposedContent, /내 변경/);
  assert.match(updated.proposedContent, /play\.example\.kr/);

  assert.equal((await service.close(session, '40')).status, 'closed');
  assert.equal((await service.reopen(session, '40')).status, 'pending');
});

test('edit request diff is calculated from the exact base revision', async () => {
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiEditRequest: { async findUnique() { return request; } },
    wikiPageRevision: { async findUnique() { return { id: 30n, pageId: page.id, visibility: 'public', contentRaw: 'before' }; } }
  } as unknown as PrismaService;
  let rawChecked = false;
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction(input: { action: string }) {
      assert.equal(input.action, 'raw');
      rawChecked = true;
    }
  } as unknown as WikiPermissionService;
  let compared: [string, string] | null = null;
  const edits = { diffText(left: string, right: string) { compared = [left, right]; return [{ type: 'removed' as const, line: left, leftLine: 1, rightLine: null }]; } } as unknown as WikiEditService;
  const service = new WikiEditRequestService(prisma, {} as WikiProfileService, permissions, edits);

  const diff = await service.diff('40');
  assert.deepEqual(compared, ['before', 'next']);
  assert.equal(diff.baseRevisionId, '30');
  assert.equal(rawChecked, true);
});
