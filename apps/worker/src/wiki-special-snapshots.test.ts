import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWikiSpecialSnapshotRows, projectWikiSpecialSnapshotSources, type SnapshotPage } from './wiki-special-snapshots';

const now = new Date('2026-07-15T12:00:00.000Z');
const page = (id: bigint, namespaceId: number, slug: string, revisionId: bigint): SnapshotPage => ({
  id,
  namespaceId,
  spaceId: namespaceId === 2 ? 2n : 1n,
  localPath: slug,
  slug,
  title: slug,
  displayTitle: slug.replace(/_/g, ' '),
  currentRevisionId: revisionId,
  pageType: 'article',
  protectionLevel: 'open',
  status: 'normal',
  updatedAt: now
});

test('wiki special snapshots exclude generic guest-denied source pages and preserve category reachability', () => {
  const pages = [
    page(1n, 1, '대문', 11n),
    page(2n, 1, '공개_출처', 12n),
    page(3n, 1, '숨김_출처', 13n),
    page(4n, 2, '분류', 14n),
    page(5n, 2, '연결됨', 15n),
    page(6n, 2, '고립됨', 16n)
  ];
  const rows = buildWikiSpecialSnapshotRows({
    pages,
    links: [
      { sourcePageId: 2n, sourceRevisionId: 12n, targetNamespaceCode: 'main', targetSlug: '필요한_문서', linkType: 'link' },
      { sourcePageId: 2n, sourceRevisionId: 12n, targetNamespaceCode: 'category', targetSlug: '가이드', linkType: 'category' },
      { sourcePageId: 3n, sourceRevisionId: 13n, targetNamespaceCode: 'main', targetSlug: '비밀_문서', linkType: 'link' },
      { sourcePageId: 3n, sourceRevisionId: 13n, targetNamespaceCode: 'category', targetSlug: '비밀', linkType: 'category' },
      { sourcePageId: 5n, sourceRevisionId: 15n, targetNamespaceCode: 'category', targetSlug: '분류', linkType: 'category' }
    ],
    namespaces: [{ id: 1, code: 'main' }, { id: 2, code: 'category' }],
    activeSpaceIds: new Set([1n, 2n]),
    rootPageIds: new Set([1n, 4n]),
    serverRouteBySpaceId: new Map(),
    aclRules: [{
      targetType: 'page', targetId: 3n, subjectType: 'perm', subjectValue: 'guest',
      effect: 'deny', sortOrder: 0
    }],
    generatedAt: now,
    generation: 'test-generation'
  });

  const globalWanted = rows.find((row) => row.type === 'wanted' && row.namespaceCode === '');
  const globalCategories = rows.find((row) => row.type === 'categories' && row.namespaceCode === '');
  const orphanedCategories = rows.find((row) => row.type === 'orphaned_categories' && row.namespaceCode === '');
  assert.deepEqual(globalWanted?.items.map((item) => item.title), ['필요한_문서']);
  assert.deepEqual(globalCategories?.items.map((item) => [item.title, item.value]), [['가이드', 1], ['분류', 1]]);
  assert.deepEqual(orphanedCategories?.items.map((item) => item.pageId), ['6']);
  assert.equal(rows.every((row) => row.generation === 'test-generation'), true);
});

test('server wiki special snapshots use released identities and pinned revision links instead of live drafts', () => {
  const ordinary = page(1n, 1, '대문', 11n);
  const draftServerPage: SnapshotPage = {
    ...page(20n, 7, 'luna/draft-guide', 201n),
    spaceId: 40n,
    localPath: 'luna/draft-guide',
    title: 'luna/draft-guide',
    displayTitle: '비공개 초안 가이드',
  };
  const unpublishedServerPage: SnapshotPage = {
    ...page(30n, 7, 'hidden/draft', 301n),
    spaceId: 50n,
    localPath: 'hidden/draft',
    title: 'hidden/draft',
    displayTitle: '미발행 초안',
  };
  const projection = projectWikiSpecialSnapshotSources({
    pages: [ordinary, draftServerPage, unpublishedServerPage],
    links: [
      { sourcePageId: 1n, sourceRevisionId: 11n, targetNamespaceCode: 'main', targetSlug: '일반_누락', linkType: 'link' },
      { sourcePageId: 20n, sourceRevisionId: 201n, targetNamespaceCode: 'server', targetSlug: 'luna/SECRET_ROADMAP', linkType: 'link' },
      { sourcePageId: 20n, sourceRevisionId: 201n, targetNamespaceCode: 'category', targetSlug: 'SECRET_LAUNCH', linkType: 'category' },
      { sourcePageId: 30n, sourceRevisionId: 301n, targetNamespaceCode: 'server', targetSlug: 'hidden/SECRET', linkType: 'link' },
    ],
    namespaces: [{ id: 1, code: 'main' }, { id: 7, code: 'server' }],
    serverWikis: [
      { id: 50n, spaceId: 40n, slug: 'luna', siteSlug: 'luna-docs', status: 'active', publicationStatus: 'published', publishedReleaseId: 70n },
      { id: 60n, spaceId: 50n, slug: 'hidden', siteSlug: null, status: 'active', publicationStatus: 'draft', publishedReleaseId: null },
    ],
    releaseItems: [{
      releaseId: 70n,
      serverWikiId: 50n,
      spaceId: 40n,
      namespaceId: 7,
      pageId: 20n,
      revisionId: 200n,
      localPath: 'luna/guide',
      slug: 'luna/guide',
      title: 'luna/guide',
      displayTitle: '공개 가이드',
      pageType: 'article',
      protectionLevel: 'open',
      pageStatus: 'normal',
      pageUpdatedAt: now,
    }],
    releaseRevisions: [{
      id: 200n,
      pageId: 20n,
      visibility: 'public',
      contentRaw: '[[공개_대상]]\n[[분류:공개_분류]]',
    }],
  });

  assert.deepEqual(projection.pages.map((candidate) => [candidate.id, candidate.currentRevisionId, candidate.title]), [
    [1n, 11n, '대문'],
    [20n, 200n, 'luna/guide'],
  ]);
  assert.deepEqual(projection.links.map((link) => [link.sourceRevisionId, link.targetNamespaceCode, link.targetSlug]), [
    [11n, 'main', '일반_누락'],
    [200n, 'server', 'luna/공개_대상'],
    [200n, 'category', '공개_분류'],
  ]);
  assert.equal(JSON.stringify(projection, (_, value) => typeof value === 'bigint' ? value.toString() : value).includes('SECRET'), false);

  const rows = buildWikiSpecialSnapshotRows({
    pages: projection.pages,
    links: projection.links,
    namespaces: [{ id: 1, code: 'main' }, { id: 7, code: 'server' }],
    activeSpaceIds: new Set([1n, 40n, 50n]),
    rootPageIds: new Set([1n]),
    serverRouteBySpaceId: projection.serverRouteBySpaceId,
    aclRules: [],
    generatedAt: now,
    generation: 'release-projection',
  });
  const serverOrphaned = rows.find((row) => row.type === 'orphaned' && row.namespaceCode === 'server');
  const serverWanted = rows.find((row) => row.type === 'wanted' && row.namespaceCode === 'server');
  assert.deepEqual(serverOrphaned?.items.map((item) => [item.displayTitle, item.routePath]), [
    ['공개 가이드', '/serverWiki/luna-docs/guide'],
  ]);
  assert.deepEqual(serverWanted?.items.map((item) => item.title), ['luna/공개_대상']);
});

test('server wiki special snapshots fail closed for an incomplete release revision set', () => {
  const projection = projectWikiSpecialSnapshotSources({
    pages: [],
    links: [],
    namespaces: [{ id: 7, code: 'server' }],
    serverWikis: [{
      id: 50n,
      spaceId: 40n,
      slug: 'luna',
      siteSlug: 'luna-docs',
      status: 'active',
      publicationStatus: 'published',
      publishedReleaseId: 70n,
    }],
    releaseItems: [200n, 201n].map((revisionId, index) => ({
      releaseId: 70n,
      serverWikiId: 50n,
      spaceId: 40n,
      namespaceId: 7,
      pageId: BigInt(20 + index),
      revisionId,
      localPath: `luna/page-${index}`,
      slug: `luna/page-${index}`,
      title: `luna/page-${index}`,
      displayTitle: `Page ${index}`,
      pageType: 'article',
      protectionLevel: 'open',
      pageStatus: 'normal',
      pageUpdatedAt: now,
    })),
    releaseRevisions: [{ id: 200n, pageId: 20n, visibility: 'public', contentRaw: 'public' }],
  });

  assert.deepEqual(projection.pages, []);
  assert.deepEqual(projection.links, []);
  assert.equal(projection.serverRouteBySpaceId.size, 0);
});

test('page-specific guest allow overrides a broader site deny in public snapshots', () => {
  const allowed = page(10n, 1, '공개', 100n);
  const denied = page(11n, 1, '차단', 110n);
  const rows = buildWikiSpecialSnapshotRows({
    pages: [allowed, denied],
    links: [],
    namespaces: [{ id: 1, code: 'main' }],
    activeSpaceIds: new Set([1n]),
    rootPageIds: new Set(),
    serverRouteBySpaceId: new Map(),
    aclRules: [
      { targetType: 'site', targetId: null, subjectType: 'perm', subjectValue: 'guest', effect: 'deny', sortOrder: 0 },
      { targetType: 'page', targetId: 10n, subjectType: 'perm', subjectValue: 'guest', effect: 'allow', sortOrder: 0 }
    ],
    generatedAt: now,
    generation: 'acl-generation'
  });

  const orphaned = rows.find((row) => row.type === 'orphaned' && row.namespaceCode === '');
  assert.deepEqual(orphaned?.items.map((item) => item.pageId), ['10']);
});

test('aggregate snapshots preserve source counts beyond the legacy five-hundred contribution cutoff', () => {
  const pages = Array.from({ length: 501 }, (_, index) =>
    page(BigInt(index + 1), 1, `출처_${index + 1}`, BigInt(index + 1001))
  );
  const rows = buildWikiSpecialSnapshotRows({
    pages,
    links: pages.map((source) => ({
      sourcePageId: source.id,
      sourceRevisionId: source.currentRevisionId!,
      targetNamespaceCode: 'main',
      targetSlug: '공통_대상',
      linkType: 'link'
    })),
    namespaces: [{ id: 1, code: 'main' }],
    activeSpaceIds: new Set([1n]),
    rootPageIds: new Set(),
    serverRouteBySpaceId: new Map(),
    aclRules: [],
    generatedAt: now,
    generation: 'bounded-generation'
  });

  const wanted = rows.find((row) => row.type === 'wanted' && row.namespaceCode === '');
  assert.equal(wanted?.items[0]?.value, 501);
  assert.equal(wanted?.items[0]?.sourceContributions?.length, 501);
  assert.equal(wanted?.items[0]?.sourceContributionsComplete, true);
  assert.deepEqual(wanted?.items[0]?.sourceContributions?.slice(0, 2), [
    { pageId: '1', count: 1 },
    { pageId: '2', count: 1 }
  ]);
});
