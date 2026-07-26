import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const readerHydratorSource = await readFile(
  new URL('../components/wiki/wiki-reader-interaction-hydrator.tsx', import.meta.url),
  'utf8',
);
const searchHydratorSource = await readFile(
  new URL('../components/wiki/wiki-search-suggestion-hydrator.ts', import.meta.url),
  'utf8',
);
const styleSource = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('rendered front-page search is upgraded with live title suggestions', () => {
  assert.match(readerHydratorSource, /hydrateWikiSearchSuggestions\(root\)/u);
  assert.match(readerHydratorSource, /cleanupSearchSuggestions\(\)/u);
  assert.match(searchHydratorSource, /fetchWikiSuggestions\(query\)/u);
  assert.match(searchHydratorSource, /role', 'combobox'/u);
  assert.match(searchHydratorSource, /role', 'listbox'/u);
  assert.match(searchHydratorSource, /제목 일치 없음 · Enter로 내용 검색/u);
  assert.match(searchHydratorSource, /badge\.textContent = '제목 일치'/u);
});

test('front-page exact title and keyboard selection navigate directly', () => {
  assert.match(searchHydratorSource, /activeIndex >= 0 \? available\[activeIndex\] : exactMatch/u);
  assert.match(searchHydratorSource, /window\.location\.assign\(selected\.routePath\)/u);
  assert.match(searchHydratorSource, /event\.key === 'ArrowDown'/u);
  assert.match(searchHydratorSource, /event\.key === 'ArrowUp'/u);
  assert.match(searchHydratorSource, /event\.key === 'Escape'/u);
  assert.match(styleSource, /\.front-wiki-search-suggest-results/u);
});
