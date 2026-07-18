import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeServerWikiNavigationDocument,
  resolveServerWikiNavigationTree,
  validateServerWikiNavigationDocument,
} from './server-wiki-navigation-order';

const pages = [
  { id: 1n, title: 'luna', localPath: '대문', displayTitle: '루나 서버' },
  { id: 2n, title: 'luna/guide', localPath: '가이드', displayTitle: '가이드' },
  { id: 3n, title: 'luna/guide/install', localPath: '가이드/설치', displayTitle: '설치' },
  { id: 4n, title: 'luna/rules', localPath: '규칙', displayTitle: '규칙' },
  { id: 5n, title: 'luna/faq', localPath: 'FAQ', displayTitle: 'FAQ' },
];

test('default navigation preserves the canonical root and page hierarchy', () => {
  const tree = resolveServerWikiNavigationTree('luna', pages, null);
  assert.deepEqual(tree.map((node) => [node.kind, node.kind === 'page' ? node.page.id : node.id, node.depth]), [
    ['page', 1n, 0],
    ['page', 2n, 1],
    ['page', 3n, 2],
    ['page', 4n, 1],
    ['page', 5n, 1],
  ]);
});

test('versioned navigation supports virtual groups and URL-independent page hierarchy', () => {
  const tree = resolveServerWikiNavigationTree('luna', pages, {
    version: 1,
    nodes: [
      { id: 'page:1', kind: 'page', pageId: '1', parentId: null },
      { id: 'group:start', kind: 'group', title: '시작하기', parentId: 'page:1' },
      { id: 'page:5', kind: 'page', pageId: '5', parentId: 'group:start' },
      { id: 'page:2', kind: 'page', pageId: '2', parentId: 'group:start' },
      { id: 'page:3', kind: 'page', pageId: '3', parentId: 'page:2' },
      { id: 'page:4', kind: 'page', pageId: '4', parentId: 'page:1' },
    ],
  });
  assert.deepEqual(tree.map((node) => [node.kind, node.id, node.parentId, node.depth]), [
    ['page', 'page:1', null, 0],
    ['group', 'group:start', 'page:1', 1],
    ['page', 'page:5', 'group:start', 2],
    ['page', 'page:2', 'group:start', 2],
    ['page', 'page:3', 'page:2', 3],
    ['page', 'page:4', 'page:1', 1],
  ]);
});

test('legacy page id arrays remain readable and never lose new pages', () => {
  assert.deepEqual(decodeServerWikiNavigationDocument(['4', '4', 2, '-1', '2'])?.nodes, [
    { id: 'page:4', kind: 'page', pageId: '4', parentId: null },
    { id: 'page:2', kind: 'page', pageId: '2', parentId: null },
  ]);
  const tree = resolveServerWikiNavigationTree('luna', pages, ['4', '2']);
  assert.equal(tree.filter((node) => node.kind === 'page').length, pages.length);
  assert.deepEqual(tree.filter((node) => node.kind === 'page').map((node) => node.page.id), [1n, 4n, 2n, 3n, 5n]);
});

test('hidden parent pages promote readable children and empty groups disappear', () => {
  const tree = resolveServerWikiNavigationTree('luna', [pages[0]!, pages[3]!], {
    version: 1,
    nodes: [
      { id: 'page:1', kind: 'page', pageId: '1', parentId: null },
      { id: 'group:private', kind: 'group', title: '비공개 그룹', parentId: 'page:1' },
      { id: 'page:2', kind: 'page', pageId: '2', parentId: 'group:private' },
      { id: 'page:4', kind: 'page', pageId: '4', parentId: 'page:2' },
      { id: 'group:empty', kind: 'group', title: '빈 그룹', parentId: 'page:1' },
    ],
  });
  assert.deepEqual(tree.map((node) => node.kind === 'page' ? node.page.id : node.title), [1n, '비공개 그룹', 4n]);
  assert.equal(tree.at(-1)?.depth, 2);
});

test('corrupt cycles fail safe during reads and strict writes reject invalid trees', () => {
  const corrupt = {
    version: 1,
    nodes: [
      { id: 'page:1', kind: 'page', pageId: '1', parentId: null },
      { id: 'page:2', kind: 'page', pageId: '2', parentId: 'page:3' },
      { id: 'page:3', kind: 'page', pageId: '3', parentId: 'page:2' },
      { id: 'page:4', kind: 'page', pageId: '4', parentId: 'page:1' },
      { id: 'page:5', kind: 'page', pageId: '5', parentId: 'page:1' },
    ],
  };
  assert.equal(resolveServerWikiNavigationTree('luna', pages, corrupt).filter((node) => node.kind === 'page').length, pages.length);
  assert.throws(() => validateServerWikiNavigationDocument(corrupt, pages.map((page) => page.id.toString())), /CYCLE/u);
  assert.throws(() => validateServerWikiNavigationDocument({ version: 1, nodes: corrupt.nodes.slice(0, 4) }, pages.map((page) => page.id.toString())), /PAGE_SET_MISMATCH/u);
});

test('strict navigation validation rejects missing parents, foreign pages and excessive depth', () => {
  const base = {
    version: 1,
    nodes: pages.map((page, index) => ({
      id: `page:${page.id}`,
      kind: 'page',
      pageId: page.id.toString(),
      parentId: index === 0 ? null : `page:${pages[index - 1]!.id}`,
    })),
  };
  assert.throws(() => validateServerWikiNavigationDocument({ ...base, nodes: base.nodes.map((node, index) => index === 1 ? { ...node, parentId: 'group:missing' } : node) }, pages.map((page) => page.id.toString())), /INVALID_PARENT/u);
  assert.throws(() => validateServerWikiNavigationDocument(base, [...pages.map((page) => page.id.toString()), '999']), /PAGE_SET_MISMATCH/u);
  assert.throws(() => validateServerWikiNavigationDocument(base, pages.map((page) => page.id.toString()), 2), /TOO_DEEP/u);
  assert.throws(() => validateServerWikiNavigationDocument({ ...base, nodes: [...base.nodes, base.nodes[1]] }, pages.map((page) => page.id.toString())), /INVALID_NODE/u);
  assert.throws(() => validateServerWikiNavigationDocument({ version: 1, nodes: [
    ...base.nodes,
    { id: 'group:empty', kind: 'group', title: '빈 그룹', parentId: 'page:1' },
  ] }, pages.map((page) => page.id.toString())), /EMPTY_GROUP/u);
  assert.throws(() => validateServerWikiNavigationDocument({ ...base, nodes: base.nodes.map((node, index) => index === 0 ? { ...node, parentId: 'page:2' } : index === 1 ? { ...node, parentId: null } : node) }, pages.map((page) => page.id.toString()), 8, '1'), /INVALID_ROOT/u);
});
