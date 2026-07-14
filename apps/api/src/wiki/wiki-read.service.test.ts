import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
import type { PrismaService } from '../common/prisma.service';
import type { WikiPermissionService } from './wiki-permission.service';
import { buildServerWikiNavigation, buildServerWikiPagePath, buildServerWikiToolPath, encodeWikiSearchCursor, parseWikiSearchCursor, serverWikiNavigationDepth, WikiReadService } from './wiki-read.service';

test('server wiki navigation removes the duplicated space slug', () => {
  assert.equal(buildServerWikiPagePath('luna-main', 'luna-main'), '/server/luna-main');
  assert.equal(buildServerWikiPagePath('luna-main', 'luna-main/규칙'), '/server/luna-main/%EA%B7%9C%EC%B9%99');
  assert.equal(buildServerWikiPagePath('luna-main', 'FAQ'), '/server/luna-main/FAQ');
});

test('server wiki navigation derives a stable document tree depth', () => {
  assert.equal(serverWikiNavigationDepth('luna-main', 'luna-main'), 0);
  assert.equal(serverWikiNavigationDepth('luna-main', 'luna-main/시작하기'), 0);
  assert.equal(serverWikiNavigationDepth('luna-main', 'luna-main/가이드/설치'), 1);
  assert.equal(serverWikiNavigationDepth('luna-main', '운영/권한/ACL'), 2);
});

test('server wiki API deep links use the reserved tool prefix', () => {
  assert.equal(buildServerWikiToolPath('luna', 'luna', 'discuss'), '/server/luna/_tools/discuss');
  assert.equal(
    buildServerWikiToolPath('luna', 'luna/API/requests', 'discuss'),
    '/server/luna/_tools/discuss/API/requests'
  );
});

test('server wiki navigation keeps every document beyond the former 100 item cap', () => {
  const pages = Array.from({ length: 150 }, (_, index) => ({
    id: BigInt(index + 1),
    localPath: index === 0 ? 'luna' : `luna/guide/doc-${String(index).padStart(3, '0')}`,
    displayTitle: `문서 ${index}`,
  }));
  const navigation = buildServerWikiNavigation('luna', pages, 150n);
  assert.equal(navigation.length, 150);
  assert.equal(navigation[0]?.path, '/server/luna');
  assert.equal(navigation[0]?.hasChildren, true);
  assert.equal(navigation.at(-1)?.current, true);
});

test('wiki search cursor is stable and rejects tampering', () => {
  const date = new Date('2026-07-13T12:34:56.000Z');
  const cursor = encodeWikiSearchCursor(date, 42n);
  assert.deepEqual(parseWikiSearchCursor(cursor), { updatedAt: date, id: 42n });
  assert.throws(() => parseWikiSearchCursor('not-a-cursor'), /cursor is invalid/);
});

test('wiki search batches current revisions and returns a continuation cursor', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const pages = Array.from({ length: 6 }, (_, index) => ({
    id: BigInt(10 - index), namespaceId: 1, spaceId: 1n, localPath: `doc-${index}`, slug: `doc-${index}`,
    title: `검색 문서 ${index}`, displayTitle: `검색 문서 ${index}`, currentRevisionId: BigInt(100 - index),
    pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n,
    createdAt: now, updatedAt: new Date(now.getTime() - index * 1000)
  }));
  let revisionQueryCount = 0;
  const prisma = {
    wikiNamespace: {
      async findUnique() { return null; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    },
    wikiPage: { async findMany() { return pages; } },
    wikiPageRevision: {
      async findMany(args: { select?: unknown }) {
        revisionQueryCount += 1;
        if (args.select) return [];
        return pages.map((page) => ({ id: page.currentRevisionId, pageId: page.id, revisionNo: 1, visibility: 'public', contentRaw: `본문 검색 ${page.id}`, createdAt: now }));
      }
    }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).search({ q: '검색', limit: 2 });
  assert.equal(revisionQueryCount, 2);
  assert.equal(result.items.length, 2);
  assert.ok(result.nextCursor);
});

test('wiki suggestions rank exact and prefix title matches without reading document bodies', async () => {
  const now = new Date('2026-07-14T00:00:00Z');
  const pages = [
    { id: 2n, namespaceId: 1, spaceId: 1n, localPath: '대문 안내', slug: '대문 안내', title: '대문 안내', displayTitle: '대문 안내', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now },
    { id: 1n, namespaceId: 1, spaceId: 1n, localPath: '대문', slug: '대문', title: '대문', displayTitle: '대문', currentRevisionId: 11n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: new Date('2025-01-01T00:00:00Z') },
    { id: 3n, namespaceId: 2, spaceId: 2n, localPath: '대문', slug: '대문', title: '대문', displayTitle: '대문', currentRevisionId: 13n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now }
  ];
  let pageQuery: unknown;
  const prisma = {
    wikiPage: { async findMany(args: unknown) { pageQuery = args; return pages; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }, { id: 2, code: 'help' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).suggest({ q: '대문', limit: 8 });

  assert.equal(result.exactMatch?.pageId, '1');
  assert.deepEqual(result.items.map((item) => item.pageId), ['1', '3', '2']);
  assert.equal(JSON.stringify(pageQuery).includes('contentRaw'), false);
});

test('revision history uses a stable revision number cursor beyond the first page', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  let revisionWhere: unknown;
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'doc', slug: 'doc', title: '문서', displayTitle: '문서', currentRevisionId: 4n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const makeRevision = (revisionNo: number) => ({ id: BigInt(revisionNo), pageId: 1n, revisionNo, editSummary: null, isMinor: false, createdBy: 1n, createdAt: now, contentHash: String(revisionNo), contentSize: revisionNo });
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: { async findMany(args: { where: unknown }) { revisionWhere = args.where; return [makeRevision(4), makeRevision(3), makeRevision(2)]; } },
    wikiProfile: { async findMany() { return [{ id: 1n, displayName: 'editor' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {}, async assertCanUsePageAction() {} } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).getRevisions('1', null, '5', 2);
  assert.deepEqual(revisionWhere, { pageId: 1n, visibility: 'public', revisionNo: { lt: 5 } });
  assert.deepEqual(result.items.map((item) => item.revisionNo), [4, 3]);
  assert.equal(result.nextCursor, '3');
});

test('recent changes use filters, a stable cursor, and one page visibility check per document', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const readablePage = { id: 1n, namespaceId: 1, spaceId: 1n, title: '공개 문서', createdBy: 1n, protectionLevel: 'open', status: 'normal' };
  const hiddenPage = { ...readablePage, id: 2n, title: '비공개 문서' };
  let recentQuery: unknown;
  let pageQueryCount = 0;
  const change = (id: bigint, pageId: bigint, title: string) => ({ id, pageId, revisionId: id + 100n, actorId: 3n, changeType: 'edit', title, namespaceCode: 'server', summary: null, isMinor: false, createdAt: now });
  const prisma = {
    wikiRecentChange: {
      async findMany(args: unknown) {
        recentQuery = args;
        return [change(10n, 1n, '공개 문서'), change(9n, 2n, '비공개 문서'), change(8n, 1n, '공개 문서')];
      }
    },
    wikiPage: {
      async findMany() {
        pageQueryCount += 1;
        return [readablePage, hiddenPage];
      }
    }
  } as unknown as PrismaService;
  const checked = new Map<bigint, number>();
  const permissions = {
    async assertCanReadPage({ page }: { page: { id: bigint } | null }) {
      if (!page) throw new Error('missing');
      checked.set(page.id, (checked.get(page.id) ?? 0) + 1);
      if (page.id === 2n) throw new Error('hidden');
    }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getRecent({ cursor: '11', limit: 2, changeType: 'edit', namespace: 'server', minor: 'false' });

  assert.deepEqual(recentQuery, {
    where: { id: { lt: 11n }, changeType: 'edit', namespaceCode: 'server', isMinor: false },
    orderBy: [{ id: 'desc' }],
    take: 9
  });
  assert.equal(pageQueryCount, 1);
  assert.deepEqual([...checked.entries()], [[1n, 1], [2n, 1]]);
  assert.deepEqual(result.items.map((item) => item.id), ['10', '8']);
  assert.equal(result.items[0]?.routePath, '/server/%EA%B3%B5%EA%B0%9C_%EB%AC%B8%EC%84%9C');
  assert.equal(result.nextCursor, '8');
});

test('blocked profiles keep their public contribution ledger', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 7n, username: 'blocked', displayName: '차단 사용자', status: 'blocked', createdAt: now, updatedAt: now }; } },
    wikiRecentChange: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const result = await new WikiReadService(prisma, {} as WikiPermissionService).getContributions({ profileId: '7' });
  assert.equal(result.profile.status, 'blocked');
  assert.deepEqual(result.items, []);
});

test('special long documents are sorted by current public source size', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const pages = [
    { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'short', slug: 'short', title: '짧음', displayTitle: '짧음', currentRevisionId: 11n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now },
    { id: 2n, namespaceId: 1, spaceId: 1n, localPath: 'long', slug: 'long', title: '김', displayTitle: '김', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now }
  ];
  let pageQuery: unknown;
  const prisma = {
    wikiPage: { async findMany(args: unknown) { pageQuery = args; return pages; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
    wikiPageRevision: { async findMany() { return [{ id: 11n, contentRaw: 'short', contentSize: 5 }, { id: 12n, contentRaw: 'long content', contentSize: 500 }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'long' });

  assert.deepEqual(result.items.map((item) => [item.pageId, item.value]), [['2', 500], ['1', 5]]);
  assert.equal(Object.hasOwn(pageQuery as object, 'take'), false);
});

test('special old documents are sorted by the oldest current update first', async () => {
  const old = new Date('2025-01-01T00:00:00Z');
  const recent = new Date('2026-07-13T00:00:00Z');
  const pages = [
    { id: 2n, namespaceId: 1, spaceId: 1n, localPath: 'recent', slug: 'recent', title: '최근', displayTitle: '최근', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: recent, updatedAt: recent },
    { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'old', slug: 'old', title: '오래됨', displayTitle: '오래됨', currentRevisionId: 11n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: old, updatedAt: old }
  ];
  const prisma = {
    wikiPage: { async findMany() { return pages; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'old' });

  assert.deepEqual(result.items.map((item) => [item.pageId, item.updatedAt]), [
    ['1', old.toISOString()], ['2', recent.toISOString()]
  ]);
});

test('special wanted documents aggregate unresolved current links', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'source', slug: 'source', title: '출처', displayTitle: '출처', currentRevisionId: 11n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  let linkQuery: unknown;
  const prisma = {
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
    wikiPageRevision: { async findMany() { return [{ id: 11n, contentRaw: '[[없는 문서]]', contentSize: 8 }]; } },
    wikiPageLink: { async findMany(args: unknown) { linkQuery = args; return [
      { sourcePageId: 1n, sourceRevisionId: 11n, targetNamespaceCode: 'main', targetSlug: '없는 문서', linkType: 'link' },
      { sourcePageId: 1n, sourceRevisionId: 11n, targetNamespaceCode: 'main', targetSlug: '없는 문서', linkType: 'link' },
      { sourcePageId: 1n, sourceRevisionId: 11n, targetNamespaceCode: 'category', targetSlug: '가이드', linkType: 'category' },
      { sourcePageId: 1n, sourceRevisionId: 10n, targetNamespaceCode: 'main', targetSlug: '오래된 링크', linkType: 'link' }
    ]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'wanted' });

  assert.equal(result.items[0]?.title, '없는 문서');
  assert.equal(result.items[0]?.value, 2);
  assert.equal(Object.hasOwn(linkQuery as object, 'take'), false);
});

test('special category list counts only current categories from readable documents', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const readable = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'source', slug: 'source', title: '출처', displayTitle: '출처', currentRevisionId: 11n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const hidden = { ...readable, id: 2n, currentRevisionId: 21n, slug: 'hidden', title: '비공개', displayTitle: '비공개' };
  const prisma = {
    wikiPage: { async findMany() { return [readable, hidden]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
    wikiPageRevision: { async findMany() { return [{ id: 11n, contentRaw: '[[분류:가이드]]', contentSize: 9 }]; } },
    wikiPageLink: { async findMany() { return [
      { sourcePageId: 1n, sourceRevisionId: 11n, targetNamespaceCode: 'category', targetSlug: '가이드', linkType: 'category' },
      { sourcePageId: 1n, sourceRevisionId: 11n, targetNamespaceCode: 'category', targetSlug: '초보자', linkType: 'category' },
      { sourcePageId: 1n, sourceRevisionId: 10n, targetNamespaceCode: 'category', targetSlug: '과거', linkType: 'category' },
      { sourcePageId: 2n, sourceRevisionId: 21n, targetNamespaceCode: 'category', targetSlug: '비공개', linkType: 'category' }
    ]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage({ page }: { page: { id: bigint } }) { if (page.id === 2n) throw new Error('hidden'); } } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'categories' });

  assert.deepEqual(result.items.map((item) => [item.title, item.value, item.routePath]), [
    ['가이드', 1, '/wiki/category/%EA%B0%80%EC%9D%B4%EB%93%9C'],
    ['초보자', 1, '/wiki/category/%EC%B4%88%EB%B3%B4%EC%9E%90']
  ]);
});

test('blame keeps attribution for lines preserved across later revisions', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'doc', slug: 'doc', title: '문서', displayTitle: '문서', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: {
      async count() { return 2; },
      async findMany() { return [
        { id: 11n, revisionNo: 1, contentRaw: 'alpha\nbeta', createdBy: 1n, createdAt: now },
        { id: 12n, revisionNo: 2, contentRaw: 'new\nalpha\nbeta', createdBy: 2n, createdAt: new Date('2026-07-13T01:00:00Z') }
      ]; }
    },
    wikiProfile: { async findMany() { return [{ id: 1n, displayName: 'first' }, { id: 2n, displayName: 'second' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {}, async assertCanUsePageAction() {} } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).getBlame('1');

  assert.deepEqual(result.lines.map((line) => [line.content, line.revisionNo, line.createdByName]), [
    ['new', 2, 'second'], ['alpha', 1, 'first'], ['beta', 1, 'first']
  ]);
});

test('backlinks expose only links from the current readable source revision', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const target = {
    id: 10n, namespaceId: 1, spaceId: 1n, slug: '대문', title: '대문', displayTitle: '대문',
    currentRevisionId: 100n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 1n, createdAt: now, updatedAt: now, localPath: '대문'
  };
  const currentSource = { ...target, id: 20n, slug: '현재', title: '현재', displayTitle: '현재', currentRevisionId: 200n };
  const staleSource = { ...target, id: 30n, slug: '과거', title: '과거', displayTitle: '과거', currentRevisionId: 301n };
  const prisma = {
    wikiPage: {
      async findUnique() { return target; },
      async findMany() { return [currentSource, staleSource]; }
    },
    wikiNamespace: {
      async findUnique() { return { id: 1, code: 'main' }; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    },
    wikiPageLink: {
      async findMany() {
        return [
          { id: 2n, sourcePageId: 20n, sourceRevisionId: 200n, linkType: 'link' },
          { id: 1n, sourcePageId: 30n, sourceRevisionId: 300n, linkType: 'link' }
        ];
      }
    }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {}
  } as unknown as WikiPermissionService;

  const response = await new WikiReadService(prisma, permissions).getBacklinks({ pageId: '10' });

  assert.equal(response.items.length, 1);
  assert.equal(response.items[0]?.sourcePageId, '20');
  assert.equal(response.items[0]?.routePath, '/wiki/%ED%98%84%EC%9E%AC');
});

test('category membership exposes only current readable documents', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const current = { id: 20n, namespaceId: 1, spaceId: 1n, slug: '가이드', title: '가이드', displayTitle: '가이드', currentRevisionId: 200n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now, localPath: '가이드' };
  const stale = { ...current, id: 30n, slug: '과거', title: '과거', displayTitle: '과거', currentRevisionId: 301n };
  const hidden = { ...current, id: 40n, slug: '비공개', title: '비공개', displayTitle: '비공개', currentRevisionId: 400n };
  const prisma = {
    wikiPageLink: {
      async findMany(args: { take?: number }) {
        if (args.take === 501) return [];
        return [
          { id: 3n, sourcePageId: 20n, sourceRevisionId: 200n },
          { id: 2n, sourcePageId: 30n, sourceRevisionId: 300n },
          { id: 1n, sourcePageId: 40n, sourceRevisionId: 400n }
        ];
      }
    },
    wikiPage: {
      async findUnique() { return null; },
      async findMany() { return [current, stale, hidden]; }
    },
    wikiNamespace: {
      async findUnique() { return { id: 2, code: 'category' }; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage({ page }: { page: { id: bigint } }) { if (page.id === 40n) throw new Error('hidden'); } } as unknown as WikiPermissionService;

  const response = await new WikiReadService(prisma, permissions).getCategoryMembers({ category: '초보자', limit: 30 });

  assert.equal(response.category, '초보자');
  assert.deepEqual(response.items.map((item) => item.pageId), ['20']);
  assert.equal(response.items[0]?.routePath, '/wiki/%EA%B0%80%EC%9D%B4%EB%93%9C');
});

test('category hierarchy exposes its document, parents, and current readable subcategories', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const category = { id: 101n, namespaceId: 2, spaceId: 2n, slug: '몹', title: '몹', displayTitle: '몹', currentRevisionId: 1001n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now, localPath: '몹' };
  const child = { ...category, id: 102n, slug: '적대적_몹', title: '적대적 몹', displayTitle: '적대적 몹', currentRevisionId: 1002n };
  const member = { ...category, id: 20n, namespaceId: 1, spaceId: 1n, slug: '좀비', title: '좀비', displayTitle: '좀비', currentRevisionId: 200n };
  const parentLink = { id: 10n, sourcePageId: 101n, sourceRevisionId: 1001n, targetSlug: '분류' };
  const childLink = { id: 9n, sourcePageId: 102n, sourceRevisionId: 1002n, targetSlug: '몹' };
  const memberLink = { id: 8n, sourcePageId: 20n, sourceRevisionId: 200n, targetSlug: '몹' };
  const prisma = {
    wikiNamespace: {
      async findUnique() { return { id: 2, code: 'category' }; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    },
    wikiPage: {
      async findUnique() { return category; },
      async findMany(args: { where: { namespaceId?: number | { not: number } } }) {
        return typeof args.where.namespaceId === 'number' ? [child] : [member];
      }
    },
    wikiPageLink: {
      async findMany(args: { where: { sourcePageId?: bigint }; take?: number }) {
        if (args.where.sourcePageId === category.id) return [parentLink];
        return [childLink, memberLink];
      }
    }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const response = await new WikiReadService(prisma, permissions).getCategoryMembers({ category: '몹' });

  assert.deepEqual(response.document, { pageId: '101', routePath: '/wiki/category/%EB%AA%B9' });
  assert.deepEqual(response.parents, [{ category: '분류', routePath: '/wiki/category/%EB%B6%84%EB%A5%98' }]);
  assert.deepEqual(response.subcategories.map((item) => item.pageId), ['102']);
  assert.deepEqual(response.items.map((item) => item.pageId), ['20']);
  assert.equal(response.isOrphan, false);
});

test('category hierarchy detects a cycle that cannot reach the root', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const categoryA = { id: 101n, namespaceId: 2, spaceId: 2n, slug: 'A', title: 'A', displayTitle: 'A', currentRevisionId: 1001n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now, localPath: 'A' };
  const categoryB = { ...categoryA, id: 102n, slug: 'B', title: 'B', displayTitle: 'B', currentRevisionId: 1002n };
  const linkAtoB = { id: 10n, sourcePageId: 101n, sourceRevisionId: 1001n, targetSlug: 'B' };
  const linkBtoA = { id: 9n, sourcePageId: 102n, sourceRevisionId: 1002n, targetSlug: 'A' };
  const prisma = {
    wikiNamespace: {
      async findUnique() { return { id: 2, code: 'category' }; },
      async findMany() { return []; }
    },
    wikiPage: {
      async findUnique(args: { where: { namespaceId_slug: { slug: string } } }) {
        return args.where.namespaceId_slug.slug === 'B' ? categoryB : categoryA;
      },
      async findMany(args: { where: { namespaceId?: number | { not: number } } }) {
        return typeof args.where.namespaceId === 'number' ? [categoryB] : [];
      }
    },
    wikiPageLink: {
      async findMany(args: { where: { sourcePageId?: bigint }; take?: number }) {
        if (args.where.sourcePageId === categoryA.id) return [linkAtoB];
        if (args.where.sourcePageId === categoryB.id) return [linkBtoA];
        return [linkBtoA];
      }
    }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const response = await new WikiReadService(prisma, permissions).getCategoryMembers({ category: 'A' });

  assert.equal(response.isOrphan, true);
});

test('special orphaned categories excludes descendants reachable from the root', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = (id: bigint, slug: string, revisionId: bigint) => ({
    id, namespaceId: 2, spaceId: 2n, slug, title: slug, displayTitle: slug,
    currentRevisionId: revisionId, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 1n, createdAt: now, updatedAt: now, localPath: slug
  });
  const pages = [page(1n, '분류', 11n), page(2n, '연결됨', 12n), page(3n, '고립_A', 13n), page(4n, '고립_B', 14n)];
  const prisma = {
    wikiNamespace: { async findUnique() { return { id: 2, code: 'category' }; } },
    wikiPage: { async findMany() { return pages; } },
    wikiPageLink: { async findMany() { return [
      { sourcePageId: 2n, sourceRevisionId: 12n, targetSlug: '분류' },
      { sourcePageId: 3n, sourceRevisionId: 13n, targetSlug: '고립_B' },
      { sourcePageId: 4n, sourceRevisionId: 14n, targetSlug: '고립_A' }
    ]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'orphaned_categories' });

  assert.deepEqual(result.items.map((item) => item.pageId), ['3', '4']);
  assert.deepEqual(result.items.map((item) => item.routePath), [
    '/wiki/category/%EA%B3%A0%EB%A6%BD_A',
    '/wiki/category/%EA%B3%A0%EB%A6%BD_B'
  ]);
});

test('contributions resolve public changes to stable document routes', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = {
    id: 20n, namespaceId: 1, spaceId: 1n, slug: '기여_문서', title: '기여 문서', displayTitle: '기여 문서',
    currentRevisionId: 200n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, createdAt: now, updatedAt: now, localPath: '기여_문서'
  };
  const prisma = {
    wikiProfile: {
      async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; }
    },
    wikiRecentChange: {
      async findMany() {
        return [{ id: 9n, pageId: 20n, revisionId: 200n, changeType: 'edit', namespaceCode: 'main', summary: '보강', isMinor: false, createdAt: now }];
      }
    },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getContributions({ profileId: '5' });

  assert.equal(result.profile.displayName, '편집자');
  assert.equal(result.items[0]?.routePath, '/wiki/%EA%B8%B0%EC%97%AC_%EB%AC%B8%EC%84%9C');
  assert.equal(result.items[0]?.summary, '보강');
});

test('contribution tabs expose discussion, edit-request, and reviewer ledgers', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = {
    id: 20n, namespaceId: 1, spaceId: 1n, slug: '기여_문서', title: '기여 문서', displayTitle: '기여 문서',
    currentRevisionId: 200n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, createdAt: now, updatedAt: now, localPath: '기여_문서'
  };
  const editRequest = {
    id: 31n, pageId: 20n, baseRevisionId: 200n, proposedContent: '내용', editSummary: '수정 제안', isMinor: false,
    status: 'accepted', createdBy: 5n, reviewedBy: 5n, reviewNote: '승인함', acceptedRevisionId: 201n,
    createdAt: now, updatedAt: now, reviewedAt: now
  };
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; } },
    wikiDiscussionComment: { async findMany() { return [{ id: 41n, threadId: 40n, content: '토론 의견', status: 'normal', createdBy: 5n, createdAt: now, updatedAt: null }]; } },
    wikiDiscussionThread: { async findMany() { return [{ id: 40n, pageId: 20n, title: '문서 방향', status: 'open', createdBy: 5n, createdAt: now, updatedAt: now, pinnedCommentId: null }]; } },
    wikiEditRequest: { async findMany() { return [editRequest]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const discussions = await service.getContributions({ profileId: '5', activity: 'discussions' });
  assert.equal(discussions.activity, 'discussions');
  assert.equal(discussions.items[0]?.href, '/wiki/discuss/20?thread=40&comment=41');
  assert.equal(discussions.items[0]?.summary, '토론 의견');

  const requests = await service.getContributions({ profileId: '5', activity: 'edit-requests' });
  assert.equal(requests.items[0]?.kind, 'edit_request');
  assert.equal(requests.items[0]?.status, 'accepted');
  assert.equal(requests.items[0]?.summary, '수정 제안');

  const reviews = await service.getContributions({ profileId: '5', activity: 'reviews' });
  assert.equal(reviews.items[0]?.kind, 'review');
  assert.equal(reviews.items[0]?.summary, '승인함');
  assert.equal(reviews.items[0]?.createdAt, now.toISOString());
});

function createReadService(options: {
  readonly cacheHtml?: string | null;
  readonly contentRaw?: string;
  readonly onCacheLookup?: (where: unknown) => void;
  readonly onCacheCreate?: (data: unknown) => void;
  readonly files?: ReadonlyArray<{ filename: string; publicPath: string; mimeType: string; originalName: string | null }>;
}) {
  const now = new Date('2026-07-05T00:00:00.000Z');
  const prisma = {
    wikiNamespace: {
      async findUnique() {
        return { id: 1, code: 'main' };
      }
    },
    wikiPage: {
      async findUnique() {
        return {
          id: 10n,
          spaceId: 20n,
          slug: '대문',
          title: '대문',
          displayTitle: '대문',
          currentRevisionId: 30n,
          pageType: 'article',
          protectionLevel: 'open',
          status: 'normal',
          updatedAt: now
        };
      }
    },
    wikiPageRevision: {
      async findFirst() {
        return {
          id: 30n,
          pageId: 10n,
          revisionNo: 1,
          contentHash: 'a'.repeat(64),
          contentRaw: options.contentRaw ?? "'''현재''' 문서",
          createdAt: now,
          createdBy: 40n,
          visibility: 'public'
        };
      }
    },
    wikiPageRenderCache: {
      async findUnique(args: { where: unknown }) {
        options.onCacheLookup?.(args.where);
        return options.cacheHtml ? { html: options.cacheHtml } : null;
      },
      async create(args: { data: unknown }) {
        options.onCacheCreate?.(args.data);
        return { id: 1n };
      }
    },
    uploadedFile: {
      async findMany() { return options.files ?? []; }
    },
    serverWiki: {
      async findFirst() {
        return null;
      }
    },
    server: {
      async findUnique() {
        return null;
      }
    }
  };
  const permissions = {
    async assertCanReadPage() {
      return undefined;
    }
  };
  return new WikiReadService(
    prisma as unknown as PrismaService,
    permissions as unknown as WikiPermissionService
  );
}

test('wiki read uses matching renderer cache version', async () => {
  let lookupWhere: unknown;
  let created = false;
  const service = createReadService({
    cacheHtml: '<p>cached current renderer</p>',
    onCacheLookup(where) {
      lookupWhere = where;
    },
    onCacheCreate() {
      created = true;
    }
  });

  const page = await service.getPage('main', '대문');

  assert.equal(page.html, '<p>cached current renderer</p>');
  assert.deepEqual(lookupWhere, {
    revisionId_rendererVersion: {
      revisionId: 30n,
      rendererVersion: WIKI_RENDERER_VERSION
    }
  });
  assert.equal(created, false);
});

test('wiki read ignores stale renderer cache and writes current version', async () => {
  let createdData: unknown;
  const service = createReadService({
    cacheHtml: null,
    onCacheCreate(data) {
      createdData = data;
    }
  });

  const page = await service.getPage('main', '대문');

  assert.notEqual(page.html, '<p>legacy renderer</p>');
  assert.equal(page.html.includes('<strong>현재</strong> 문서'), true);
  const data = createdData as {
    pageId: bigint;
    revisionId: bigint;
    rendererVersion: string;
    html: string;
    createdAt: Date;
  };
  assert.equal(data.pageId, 10n);
  assert.equal(data.revisionId, 30n);
  assert.equal(data.rendererVersion, WIKI_RENDERER_VERSION);
  assert.equal(data.html, page.html);
  assert.equal(data.createdAt instanceof Date, true);
});

test('wiki read ignores persistent render caches for file-dependent revisions', async () => {
  let lookedUpCache = false;
  let createdCache = false;
  const service = createReadService({
    cacheHtml: '<p>파일 없음: logo.png</p>',
    contentRaw: '[[파일:logo.png|섬네일|서버 로고]]',
    files: [{ filename: 'logo.png', publicPath: '/files/logo.png', mimeType: 'image/png', originalName: 'logo.png' }],
    onCacheLookup() { lookedUpCache = true; },
    onCacheCreate() { createdCache = true; }
  });
  const page = await service.getPage('main', '대문');
  assert.equal(lookedUpCache, false);
  assert.equal(createdCache, false);
  assert.match(page.html, /<img src="\/files\/logo\.png"/);
  assert.equal(page.html.includes('파일 없음'), false);
});

function createRedirectReadService(pages: Record<string, { id: bigint; title: string; contentRaw: string }>) {
  const now = new Date('2026-07-05T00:00:00.000Z');
  let currentSlug = '대문';
  const prisma = {
    wikiNamespace: {
      async findUnique() {
        return { id: 1, code: 'main' };
      }
    },
    wikiPage: {
      async findUnique(args: { where: { namespaceId_slug: { slug: string } } }) {
        currentSlug = args.where.namespaceId_slug.slug;
        const page = pages[currentSlug];
        if (!page) {
          return null;
        }
        return {
          id: page.id,
          spaceId: 20n,
          slug: currentSlug,
          title: page.title,
          displayTitle: page.title,
          currentRevisionId: page.id + 100n,
          pageType: 'article',
          protectionLevel: 'open',
          status: 'normal',
          updatedAt: now
        };
      }
    },
    wikiPageRevision: {
      async findFirst() {
        const page = pages[currentSlug];
        return page
          ? {
              id: page.id + 100n,
              pageId: page.id,
              revisionNo: 1,
              contentHash: 'b'.repeat(64),
              contentRaw: page.contentRaw,
              createdAt: now,
              createdBy: 40n,
              visibility: 'public'
            }
          : null;
      }
    },
    wikiPageRenderCache: {
      async findUnique() {
        return null;
      },
      async create() {
        return { id: 1n };
      }
    },
    uploadedFile: {
      async findMany() {
        return [];
      }
    },
    serverWiki: {
      async findFirst() {
        return null;
      }
    },
    server: {
      async findUnique() {
        return null;
      }
    }
  };
  const permissions = {
    async assertCanReadPage() {
      return undefined;
    },
    async assertCanUsePageAction() {
      return undefined;
    }
  };
  return new WikiReadService(
    prisma as unknown as PrismaService,
    permissions as unknown as WikiPermissionService
  );
}

test('wiki read follows redirect pages by default', async () => {
  const service = createRedirectReadService({
    대문: { id: 10n, title: '대문', contentRaw: '#REDIRECT [[목표]]' },
    목표: { id: 11n, title: '목표', contentRaw: "'''목표''' 문서" }
  });

  const page = await service.getPage('main', '대문');

  assert.equal(page.id, '11');
  assert.equal(page.redirectTarget, null);
  assert.deepEqual(page.redirectedFrom, {
    namespace: 'main',
    title: '대문',
    path: '/wiki/%EB%8C%80%EB%AC%B8'
  });
});

test('wiki read can return redirect page when redirect is disabled', async () => {
  const service = createRedirectReadService({
    대문: { id: 10n, title: '대문', contentRaw: '#REDIRECT [[목표]]' },
    목표: { id: 11n, title: '목표', contentRaw: "'''목표''' 문서" }
  });

  const page = await service.getPage('main', '대문', null, { followRedirects: false });

  assert.equal(page.id, '10');
  assert.equal(page.redirectTarget, '목표');
  assert.equal(page.redirectedFrom, null);
});

test('wiki read detects redirect loops', async () => {
  const service = createRedirectReadService({
    대문: { id: 10n, title: '대문', contentRaw: '#REDIRECT [[목표]]' },
    목표: { id: 11n, title: '목표', contentRaw: '#REDIRECT [[대문]]' }
  });

  await assert.rejects(() => service.getPage('main', '대문'), /redirect loop/i);
});
