import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const toolsSource = await readFile(new URL('../components/wiki/wiki-page-tools.tsx', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');
const articleSource = await readFile(new URL('../components/wiki/wiki-article-view.tsx', import.meta.url), 'utf8');
const serverArticleSource = await readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8');

test('document move UI forwards namespace and preserves the current space for local moves', () => {
  assert.match(toolsSource, /namespace: nextNamespace/);
  assert.match(toolsSource, /spaceId: nextNamespace === namespace \? spaceId : undefined/);
  assert.match(apiSource, /namespace\?: string; spaceId\?: string/);
  assert.match(apiSource, /readonly previousNamespace: string;[\s\S]*readonly movedPageCount: number/);
  assert.match(apiSource, /namespace: input\.namespace,[\s\S]*spaceId: input\.spaceId/);
  assert.match(articleSource, /namespace=\{page\.namespace\}[\s\S]*spaceId=\{page\.spaceId\}/);
  assert.match(serverArticleSource, /namespace=\{page\.namespace\}[\s\S]*spaceId=\{page\.spaceId\}/);
});

test('special identity and file namespaces cannot be selected as generic destinations', () => {
  const standardOptions = toolsSource.slice(
    toolsSource.indexOf('const STANDARD_MOVE_NAMESPACES'),
    toolsSource.indexOf('function moveNamespaceOptions'),
  );
  assert.match(toolsSource, /namespace === 'user'\) return \[\{ code: 'user'/);
  assert.match(toolsSource, /namespace === 'file'\) return \[\{ code: 'file'/);
  assert.doesNotMatch(standardOptions, /code: 'user'/);
  assert.doesNotMatch(standardOptions, /code: 'file'/);
  assert.match(toolsSource, /min-h-11/);
});
