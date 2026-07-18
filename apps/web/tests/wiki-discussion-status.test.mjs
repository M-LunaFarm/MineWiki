import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countWikiDiscussionStatuses,
  wikiDiscussionFilterCount,
  wikiDiscussionMatchesStatusFilter,
  wikiDiscussionStatusLabel,
  normalizeWikiRecentDiscussionFilters,
  wikiRecentDiscussionHref,
  wikiRecentDiscussionQuery,
} from '../lib/wiki-discussion-status.mjs';

test('paused discussions remain active but are distinct from open and closed', () => {
  assert.equal(wikiDiscussionStatusLabel('paused'), '일시 중지');
  assert.equal(wikiDiscussionMatchesStatusFilter('paused', 'active'), true);
  assert.equal(wikiDiscussionMatchesStatusFilter('paused', 'open'), false);
  assert.equal(wikiDiscussionMatchesStatusFilter('closed', 'active'), false);
});

test('recent discussion filters serialize status, order and cursor without losing scope', () => {
  assert.deepEqual(normalizeWikiRecentDiscussionFilters({ status: 'deleted', sort: 'popular' }), { status: 'all', sort: 'newest' });
  assert.equal(wikiRecentDiscussionQuery({ status: 'paused', sort: 'oldest', cursor: 'signed.cursor' }), 'limit=30&status=paused&sort=oldest&cursor=signed.cursor');
  assert.equal(wikiRecentDiscussionHref('closed', 'oldest'), '/wiki/discussions?status=closed&sort=oldest');
  assert.equal(wikiRecentDiscussionHref('all', 'newest'), '/wiki/discussions');
});

test('status counts preserve unknown rolling-deployment values in the total', () => {
  const counts = countWikiDiscussionStatuses([
    { status: 'open' },
    { status: 'paused' },
    { status: 'paused' },
    { status: 'closed' },
    { status: 'future-status' },
    { status: 'deleted' },
  ]);
  assert.deepEqual(counts, { total: 5, open: 1, paused: 2, closed: 1 });
  assert.equal(wikiDiscussionFilterCount(counts, 'active'), 3);
  assert.equal(wikiDiscussionStatusLabel('future-status'), '상태 확인 필요');
});
