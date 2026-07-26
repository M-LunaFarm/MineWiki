import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const pageSource = await readFile(new URL('../app/search/page.tsx', import.meta.url), 'utf8');
const formSource = await readFile(
  new URL('../components/wiki/wiki-search-suggest-form.tsx', import.meta.url),
  'utf8',
);

test('search page exposes title suggestions before submitting the unified search', () => {
  assert.match(pageSource, /<WikiSearchSuggestForm query=\{query\} target=\{target\} namespace=\{namespace\}/u);
  assert.match(formSource, /fetchWikiSuggestions\(normalizedQuery\)/u);
  assert.match(formSource, /role="combobox"/u);
  assert.match(formSource, /aria-autocomplete="list"/u);
  assert.match(formSource, /role="listbox"/u);
  assert.match(formSource, /제목 일치/u);
  assert.match(formSource, /제목 일치 없음 · Enter로 내용 검색/u);
});

test('exact title and keyboard selection navigate directly to the wiki document', () => {
  assert.match(formSource, /activeIndex >= 0 \? suggestions\[activeIndex\] : exactMatch/u);
  assert.match(formSource, /window\.location\.assign\(selected\.routePath\)/u);
  assert.match(formSource, /event\.key === 'ArrowDown'/u);
  assert.match(formSource, /event\.key === 'ArrowUp'/u);
  assert.match(formSource, /event\.key === 'Escape'/u);
});
