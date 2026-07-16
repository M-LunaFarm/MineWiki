import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('root layout advertises the MineWiki OpenSearch provider', async () => {
  const layout = await readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8');
  assert.match(layout, /rel="search"/u);
  assert.match(layout, /type="application\/opensearchdescription\+xml"/u);
  assert.match(layout, /href="\/opensearch\.xml"/u);
});

test('OpenSearch document targets unified search without exposing an API origin', async () => {
  const route = await readFile(new URL('../app/opensearch.xml/route.ts', import.meta.url), 'utf8');
  assert.match(route, /\/search\?q=\{searchTerms\}/u);
  assert.match(route, /support@minewiki\.kr/u);
  assert.match(route, /application\/opensearchdescription\+xml/u);
  assert.doesNotMatch(route, /INTERNAL_API_BASE_URL/u);
});
