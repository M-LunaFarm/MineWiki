import assert from 'node:assert/strict';
import test from 'node:test';

import { formatCombinedSearchSummary, formatWikiResultBadge } from '../lib/search-result-count.mjs';

test('search totals are exact only when the wiki cursor is exhausted', () => {
  assert.equal(formatCombinedSearchSummary({ serverTotal: 8, wikiShown: 12, wikiHasMore: false, continued: false }), '검색 결과 20개');
  assert.equal(formatCombinedSearchSummary({ serverTotal: 8, wikiShown: 30, wikiHasMore: true, continued: false }), '검색 결과 38개 이상');
  assert.equal(formatWikiResultBadge({ wikiShown: 30, wikiHasMore: true, continued: false }), '30+');
});

test('continued cursor pages label only the visible result batch', () => {
  assert.equal(formatCombinedSearchSummary({ serverTotal: 8, wikiShown: 17, wikiHasMore: true, continued: true }), '위키 검색을 이어서 보는 중 · 현재 17개');
  assert.equal(formatWikiResultBadge({ wikiShown: 17, wikiHasMore: true, continued: true }), '17');
});
