import assert from 'node:assert/strict';
import test from 'node:test';

import {
  parseCollapsedServerWikiNavigation,
  serverWikiAncestorIds,
  serverWikiDocumentTitle,
  visibleServerWikiNavigation,
} from '../lib/server-wiki-navigation.mjs';

const items = [
  { id: 'root', depth: 0, hasChildren: true },
  { id: 'guide', depth: 0, hasChildren: true },
  { id: 'install', depth: 1, hasChildren: true },
  { id: 'paper', depth: 2, hasChildren: false },
  { id: 'rules', depth: 0, hasChildren: false },
];

test('collapsed server wiki branches hide only their descendants', () => {
  assert.deepEqual(
    visibleServerWikiNavigation(items, new Set(['guide'])).map((item) => item.id),
    ['root', 'guide', 'rules'],
  );
  assert.deepEqual(
    visibleServerWikiNavigation(items, new Set(['install'])).map((item) => item.id),
    ['root', 'guide', 'install', 'rules'],
  );
});

test('server wiki document titles hide internal tenant prefixes', () => {
  assert.equal(serverWikiDocumentTitle('example/접속 방법', ['example', 'content-root'], '크리퍼타운 SMP'), '접속 방법');
  assert.equal(serverWikiDocumentTitle('example', ['example'], '크리퍼타운 SMP'), '크리퍼타운 SMP');
  assert.equal(serverWikiDocumentTitle('다른 문서', ['example'], '크리퍼타운 SMP'), '다른 문서');
});

test('current document ancestors are derived from the flat navigation tree', () => {
  assert.deepEqual(serverWikiAncestorIds(items, 'paper'), ['install', 'guide']);
  assert.deepEqual(serverWikiAncestorIds(items, 'rules'), []);
  assert.deepEqual(serverWikiAncestorIds(items, 'missing'), []);
});

test('stored collapsed branches are parsed defensively and pruned', () => {
  assert.deepEqual([...parseCollapsedServerWikiNavigation('["guide","rules",4]', items)], ['guide']);
  assert.deepEqual([...parseCollapsedServerWikiNavigation('{broken', items)], []);
});
