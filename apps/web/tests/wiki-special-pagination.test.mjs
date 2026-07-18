import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const pageSource = await readFile(new URL('../app/wiki/special/page.tsx', import.meta.url), 'utf8');
const apiSource = await readFile(new URL('../lib/wiki-server-api.ts', import.meta.url), 'utf8');

test('special document screen preserves a scope-bound cursor and labels page-local counts', () => {
  assert.match(pageSource, /query\.cursor\?\.trim\(\)/u);
  assert.match(pageSource, /fetchWikiSpecial\(\{ type, namespace: namespace \|\| undefined, limit: 100, cursor \}\)/u);
  assert.match(pageSource, /이번 페이지 \{result\.items\.length\}개/u);
  assert.match(pageSource, /result\.nextCursor/u);
  assert.match(pageSource, /다음 페이지/u);
  assert.match(pageSource, /if \(cursor\) params\.set\('cursor', cursor\)/u);
});

test('server wiki client forwards special document cursors to the API', () => {
  assert.match(apiSource, /readonly cursor\?: string/u);
  assert.match(apiSource, /if \(input\.cursor\) params\.set\('cursor', input\.cursor\)/u);
});
