import assert from 'node:assert/strict';
import test from 'node:test';
import {
  addServerWikiGroup,
  emptyServerWikiGroupIds,
  indentServerWikiNode,
  moveServerWikiNode,
  outdentServerWikiNode,
  removeServerWikiGroup,
  renameServerWikiGroup,
  serverWikiNodeControls,
  serverWikiNodeDepth,
} from '../lib/server-wiki-navigation-editor.mjs';

const nodes = [
  { id: 'page:1', kind: 'page', pageId: '1', parentId: null },
  { id: 'page:2', kind: 'page', pageId: '2', parentId: 'page:1' },
  { id: 'page:3', kind: 'page', pageId: '3', parentId: 'page:1' },
  { id: 'page:4', kind: 'page', pageId: '4', parentId: 'page:3' },
];

test('navigation editor moves complete sibling subtrees', () => {
  const moved = moveServerWikiNode(nodes, 'page:3', 'up');
  assert.deepEqual(moved.map((node) => node.id), ['page:1', 'page:3', 'page:4', 'page:2']);
});

test('navigation editor indents and outdents without changing page identity', () => {
  const indented = indentServerWikiNode(nodes, 'page:3');
  assert.equal(indented.find((node) => node.id === 'page:3')?.parentId, 'page:2');
  assert.deepEqual(indented.map((node) => node.id), ['page:1', 'page:2', 'page:3', 'page:4']);
  const outdented = outdentServerWikiNode(indented, 'page:3');
  assert.equal(outdented.find((node) => node.id === 'page:3')?.parentId, 'page:1');
});

test('navigation editor creates, renames and removes virtual groups while preserving children', () => {
  const added = addServerWikiGroup(nodes, 'group:start', '시작하기');
  const renamed = renameServerWikiGroup(added, 'group:start', ' 첫걸음 ');
  const grouped = indentServerWikiNode(moveServerWikiNode(renamed, 'group:start', 'up'), 'page:3');
  const removed = removeServerWikiGroup(grouped, 'group:start');
  assert.equal(renamed.find((node) => node.id === 'group:start')?.title, '첫걸음');
  assert.equal(removed.some((node) => node.id === 'group:start'), false);
  assert.equal(removed.length, nodes.length);
});

test('navigation editor protects the root and exposes keyboard button availability', () => {
  assert.deepEqual(serverWikiNodeControls(nodes, 'page:1', 'page:1'), { up: false, down: false, indent: false, outdent: false });
  assert.deepEqual(serverWikiNodeControls(nodes, 'page:3', 'page:1'), { up: true, down: false, indent: true, outdent: true });
});

test('navigation editor reports depth and empty groups before save', () => {
  const withGroup = addServerWikiGroup(nodes, 'group:empty', '빈 그룹');
  assert.equal(serverWikiNodeDepth(nodes, 'page:4'), 2);
  assert.deepEqual(emptyServerWikiGroupIds(withGroup), ['group:empty']);
  const nestedGroup = indentServerWikiNode(withGroup, 'group:empty');
  const populated = indentServerWikiNode(moveServerWikiNode(nestedGroup, 'group:empty', 'up'), 'page:3');
  assert.deepEqual(emptyServerWikiGroupIds(populated), []);
});
