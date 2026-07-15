import assert from 'node:assert/strict';
import test from 'node:test';

import {
  countWikiDiscussionStatuses,
  wikiDiscussionFilterCount,
  wikiDiscussionMatchesStatusFilter,
  wikiDiscussionStatusLabel,
} from '../lib/wiki-discussion-status.mjs';

test('paused discussions remain active but are distinct from open and closed', () => {
  assert.equal(wikiDiscussionStatusLabel('paused'), '일시 중지');
  assert.equal(wikiDiscussionMatchesStatusFilter('paused', 'active'), true);
  assert.equal(wikiDiscussionMatchesStatusFilter('paused', 'open'), false);
  assert.equal(wikiDiscussionMatchesStatusFilter('closed', 'active'), false);
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
