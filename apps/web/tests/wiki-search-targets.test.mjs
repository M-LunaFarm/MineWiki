import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pageSource = await readFile(new URL('../app/search/page.tsx', import.meta.url), 'utf8');
const browserApiSource = await readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');
const serverApiSource = await readFile(new URL('../lib/wiki-server-api.ts', import.meta.url), 'utf8');

test('unified search preserves target filters across server requests and pagination', () => {
  assert.match(pageSource, /name="target"/u);
  assert.match(pageSource, /<option value="title">제목만<\/option>/u);
  assert.match(pageSource, /<option value="content">본문만<\/option>/u);
  assert.match(pageSource, /target=\$\{encodeURIComponent\(target\)\}/u);
  assert.match(browserApiSource, /params\.set\('target', input\.target\)/u);
  assert.match(serverApiSource, /params\.set\('target', input\.target\)/u);
});

test('wiki result highlights render structured ranges without raw HTML injection', () => {
  assert.match(pageSource, /<HighlightedText value=\{result\.displayTitle\}/u);
  assert.match(pageSource, /<HighlightedText value=\{result\.snippet\}/u);
  assert.doesNotMatch(pageSource, /dangerouslySetInnerHTML/u);
});
