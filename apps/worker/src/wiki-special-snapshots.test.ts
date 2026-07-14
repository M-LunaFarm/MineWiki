import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildWikiSpecialSnapshotRows, type SnapshotPage } from './wiki-special-snapshots';

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
    serverSlugBySpaceId: new Map(),
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

test('page-specific guest allow overrides a broader site deny in public snapshots', () => {
  const allowed = page(10n, 1, '공개', 100n);
  const denied = page(11n, 1, '차단', 110n);
  const rows = buildWikiSpecialSnapshotRows({
    pages: [allowed, denied],
    links: [],
    namespaces: [{ id: 1, code: 'main' }],
    activeSpaceIds: new Set([1n]),
    rootPageIds: new Set(),
    serverSlugBySpaceId: new Map(),
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
