import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { Prisma, type WikiPage, type WikiPageRevision } from '@prisma/client';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiPageSwapService } from './wiki-page-swap.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';

const session = { userId: 'account-1', requestIp: '192.0.2.40' } as SessionPayload;

test('atomically swaps two leaf titles and writes both indexes, recent changes, cache invalidation, and audit', async () => {
  const fixture = createFixture();

  const result = await fixture.service.swap(session, '20', {
    targetPageId: '10',
    expectedSourceRevisionId: '200',
    expectedTargetRevisionId: '100',
    reason: '문서 제목을 서로 교환합니다',
    sourceTitleConfirmation: '원본 문서',
    targetTitleConfirmation: '대상 문서',
  });

  assert.deepEqual(fixture.locks.slice(0, 2), [10n, 20n]);
  assert.deepEqual(fixture.isolationLevels, [Prisma.TransactionIsolationLevel.Serializable]);
  assert.equal(result.source.pageId, '20');
  assert.equal(result.source.title, '대상 문서');
  assert.equal(result.source.revisionId, '200');
  assert.equal(result.target.pageId, '10');
  assert.equal(result.target.title, '원본 문서');
  assert.equal(result.target.revisionId, '100');
  assert.equal(fixture.pages.get(20n)?.slug, 'target');
  assert.equal(fixture.pages.get(10n)?.slug, 'source');
  assert.deepEqual(fixture.updatedPageIds, [20n, 10n, 20n]);
  assert.deepEqual(fixture.invalidatedRenderPageIds, [20n, 10n]);
  assert.deepEqual(fixture.indexedPageIds, [20n, 10n]);
  assert.equal(fixture.recentChanges.length, 2);
  assert.deepEqual(fixture.recentChanges.map((row) => row.pageId), [20n, 10n]);
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.action, 'wiki.swap');
  assert.deepEqual(fixture.permissionChecks, [
    'read:20', 'move:20', 'read:10', 'move:10', 'create:대상 문서', 'create:원본 문서',
  ]);
});

test('rejects stale expected revisions before changing either page', async () => {
  const fixture = createFixture();

  await assert.rejects(
    () => fixture.service.swap(session, '20', {
      targetPageId: '10',
      expectedSourceRevisionId: '199',
      expectedTargetRevisionId: '100',
      reason: '문서 제목을 서로 교환합니다',
      sourceTitleConfirmation: '원본 문서',
      targetTitleConfirmation: '대상 문서',
    }),
    (error: unknown) => error instanceof ConflictException
      && (error.getResponse() as { code?: string }).code === 'wiki_swap_revision_stale',
  );

  assert.equal(fixture.updatedPageIds.length, 0);
  assert.equal(fixture.recentChanges.length, 0);
  assert.equal(fixture.audits.length, 0);
  assert.equal(fixture.pages.get(20n)?.title, '원본 문서');
  assert.equal(fixture.pages.get(10n)?.title, '대상 문서');
});

test('hides a target move denial as not found', async () => {
  const fixture = createFixture({ deniedMovePageId: 10n });

  await assert.rejects(
    () => fixture.service.swap(session, '20', {
      targetPageId: '10',
      expectedSourceRevisionId: '200',
      expectedTargetRevisionId: '100',
      reason: '문서 제목을 서로 교환합니다',
      sourceTitleConfirmation: '원본 문서',
      targetTitleConfirmation: '대상 문서',
    }),
    (error: unknown) => error instanceof NotFoundException,
  );

  assert.equal(fixture.updatedPageIds.length, 0);
});

test('maps a Serializable write conflict to a retryable swap conflict', async () => {
  const fixture = createFixture({ transactionErrorCode: 'P2034' });

  await assert.rejects(
    () => fixture.service.swap(session, '20', {
      targetPageId: '10',
      expectedSourceRevisionId: '200',
      expectedTargetRevisionId: '100',
      reason: '문서 제목을 서로 교환합니다',
      sourceTitleConfirmation: '원본 문서',
      targetTitleConfirmation: '대상 문서',
    }),
    (error: unknown) => error instanceof ConflictException
      && (error.getResponse() as { code?: string }).code === 'wiki_swap_concurrency_conflict',
  );
});

test('candidate search returns only readable, movable leaf articles with public current revisions', async () => {
  const hidden = wikiPage(30n, '숨김 대상', 'hidden', 300n);
  const parent = wikiPage(40n, '부모 대상', 'parent', 400n);
  const child = wikiPage(41n, '하위 문서', 'parent/child', 410n);
  const fixture = createFixture({
    extraPages: [hidden, parent, child],
    deniedMovePageId: 30n,
  });

  const response = await fixture.service.listCandidates(session, '20', '대상');

  assert.deepEqual(response.items, [{
    pageId: '10',
    title: '대상 문서',
    displayTitle: '대상 문서',
    currentRevisionId: '100',
  }]);
});

test('candidate search rejects queries shorter than the UI contract', async () => {
  const fixture = createFixture();

  await assert.rejects(
    () => fixture.service.listCandidates(session, '20', '대'),
    (error: unknown) => error instanceof BadRequestException,
  );
});

function createFixture(options: {
  readonly deniedMovePageId?: bigint;
  readonly transactionErrorCode?: string;
  readonly extraPages?: WikiPage[];
} = {}) {
  const pages = new Map<bigint, WikiPage>([
    [20n, wikiPage(20n, '원본 문서', 'source', 200n)],
    [10n, wikiPage(10n, '대상 문서', 'target', 100n)],
    ...(options.extraPages ?? []).map((page): [bigint, WikiPage] => [page.id, page]),
  ]);
  const revisions = new Map<bigint, WikiPageRevision>([
    [200n, wikiRevision(200n, 20n, 2, '[[./하위]] 원본 본문')],
    [100n, wikiRevision(100n, 10n, 3, '대상 본문')],
    ...(options.extraPages ?? []).flatMap((page): Array<[bigint, WikiPageRevision]> => page.currentRevisionId
      ? [[page.currentRevisionId, wikiRevision(page.currentRevisionId, page.id, 1, `${page.title} 본문`)]]
      : []),
  ]);
  const updatedPageIds: bigint[] = [];
  const invalidatedRenderPageIds: bigint[] = [];
  const indexedPageIds: bigint[] = [];
  const recentChanges: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const locks: bigint[] = [];
  const isolationLevels: string[] = [];
  const permissionChecks: string[] = [];

  const store = {
    wikiPage: {
      async findUnique({ where }: { where: { id: bigint } }) {
        return pages.get(where.id) ?? null;
      },
      async findMany(args: { where?: { id?: { not?: bigint }; namespaceId?: number; spaceId?: bigint; status?: string; pageType?: string; OR?: unknown[] }; orderBy?: unknown; take?: number }) {
        return [...pages.values()]
          .filter((page) => args.where?.id?.not === undefined || page.id !== args.where.id.not)
          .filter((page) => args.where?.namespaceId === undefined || page.namespaceId === args.where.namespaceId)
          .filter((page) => args.where?.spaceId === undefined || page.spaceId === args.where.spaceId)
          .filter((page) => args.where?.status === undefined || page.status === args.where.status)
          .filter((page) => args.where?.pageType === undefined || page.pageType === args.where.pageType)
          .filter((page) => !args.where?.OR || page.title.includes('대상') || page.displayTitle.includes('대상'))
          .sort((left, right) => left.title.localeCompare(right.title) || Number(left.id - right.id))
          .slice(0, args.take);
      },
      async findFirst(args: { where: { id: { not: bigint }; namespaceId: number; spaceId: bigint; localPath: { startsWith: string }; status: { not: string } } }) {
        return [...pages.values()].find((page) =>
          page.id !== args.where.id.not
          && page.namespaceId === args.where.namespaceId
          && page.spaceId === args.where.spaceId
          && page.localPath.startsWith(args.where.localPath.startsWith)
          && page.status !== args.where.status.not,
        ) ?? null;
      },
      async update({ where, data }: { where: { id: bigint }; data: Partial<WikiPage> }) {
        const current = pages.get(where.id);
        if (!current) throw new Error('page missing');
        const updated = { ...current, ...data };
        pages.set(where.id, updated);
        updatedPageIds.push(where.id);
        return updated;
      },
    },
    wikiNamespace: {
      async findUnique() { return { id: 1, code: 'main', displayName: '일반', pathPrefix: '', isContent: true }; },
    },
    wikiSpace: {
      async findUnique() {
        return { id: 1n, status: 'active', spaceType: 'global', rootPageId: 999n };
      },
    },
    wikiPageRevision: {
      async findUnique({ where }: { where: { id: bigint } }) { return revisions.get(where.id) ?? null; },
      async findMany({ where }: { where: { id: { in: bigint[] } } }) {
        return where.id.in.flatMap((id) => {
          const revision = revisions.get(id);
          return revision ? [revision] : [];
        });
      },
    },
    wikiPageRenderCache: {
      async deleteMany({ where }: { where: { pageId: { in: bigint[] } } }) {
        invalidatedRenderPageIds.push(...where.pageId.in);
        return { count: where.pageId.in.length };
      },
    },
    wikiRecentChange: {
      async createMany({ data }: { data: Array<Record<string, unknown>> }) {
        recentChanges.push(...data);
        return { count: data.length };
      },
    },
    auditEvent: {
      async create({ data }: { data: Record<string, unknown> }) {
        audits.push(data);
        return data;
      },
    },
    async $queryRaw(_parts: TemplateStringsArray, ...values: unknown[]) {
      if (typeof values[0] === 'bigint') locks.push(values[0]);
      return [];
    },
  };
  const prisma = {
    ...store,
    async $transaction<T>(callback: (tx: typeof store) => Promise<T>, transactionOptions?: { isolationLevel?: string }) {
      if (transactionOptions?.isolationLevel) isolationLevels.push(transactionOptions.isolationLevel);
      if (options.transactionErrorCode) throw { code: options.transactionErrorCode };
      return callback(store);
    },
  } as unknown as PrismaService;
  const profiles = {
    async ensureWikiProfile() { return { id: 7n, status: 'active' }; },
  } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession(receivedSession: SessionPayload, profile: { id: bigint; status: string }) {
      return { accountId: receivedSession.userId, profileId: profile.id, status: profile.status };
    },
    async assertCanReadPage({ page }: { page: WikiPage }) { permissionChecks.push(`read:${page.id}`); },
    async assertCanMutatePageAction({ page }: { page: WikiPage }) {
      permissionChecks.push(`move:${page.id}`);
      if (page.id === options.deniedMovePageId) throw new ForbiddenException('denied');
    },
    async assertCanCreatePage({ title }: { title: string }) { permissionChecks.push(`create:${title}`); },
  } as unknown as WikiPermissionService;
  const links = {
    async replaceForRevision(_store: unknown, pageId: bigint) { indexedPageIds.push(pageId); },
  } as unknown as WikiLinkIndexService;
  return {
    service: new WikiPageSwapService(prisma, profiles, permissions, links),
    pages,
    updatedPageIds,
    invalidatedRenderPageIds,
    indexedPageIds,
    recentChanges,
    audits,
    locks,
    isolationLevels,
    permissionChecks,
  };
}

function wikiPage(id: bigint, title: string, slug: string, currentRevisionId: bigint): WikiPage {
  const now = new Date('2026-07-18T00:00:00.000Z');
  return {
    id,
    namespaceId: 1,
    spaceId: 1n,
    localPath: slug,
    slug,
    title,
    displayTitle: title,
    currentRevisionId,
    pageType: 'article',
    protectionLevel: 'open',
    status: 'normal',
    currentContentSize: 0,
    currentCategoryCount: 0,
    createdBy: 7n,
    ownerProfileId: null,
    createdAt: now,
    updatedAt: now,
  };
}

function wikiRevision(id: bigint, pageId: bigint, revisionNo: number, contentRaw: string): WikiPageRevision {
  return {
    id,
    pageId,
    revisionNo,
    parentRevisionId: null,
    contentRaw,
    contentAst: null,
    contentHash: `hash-${id}`,
    contentSize: Buffer.byteLength(contentRaw),
    syntaxVersion: 'bwm-0.3',
    editSummary: null,
    editSummaryHidden: false,
    editSummaryModerationVersion: 0,
    editSummaryModeratedBy: null,
    editSummaryModeratedAt: null,
    editSummaryModerationReason: null,
    isMinor: false,
    editTags: null,
    createdBy: 7n,
    actorType: 'user',
    actorUserId: 7n,
    actorIp: null,
    actorIpText: null,
    actorIpHash: null,
    createdAt: new Date('2026-07-18T00:00:00.000Z'),
    visibility: 'public',
  };
}
