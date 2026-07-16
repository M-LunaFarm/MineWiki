import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('reviewable edit requests are discoverable from the responsive site header', async () => {
  const [header, badge, api, queuePage, detail, queue] = await Promise.all([
    readFile(new URL('../components/layout/site-header.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/layout/wiki-review-queue-badge.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/wiki/edit-requests/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/wiki-edit-requests-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/wiki-edit-request-queue-client.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(header, /<WikiReviewQueueBadge/u);
  assert.match(badge, /fetchWikiEditRequestReviewableSummary/u);
  assert.match(badge, /\/wiki\/edit-requests\?status=open&scope=reviewable/u);
  assert.match(badge, /size-10/u);
  assert.doesNotMatch(badge, /\bhidden\b/u);
  assert.match(badge, /wiki:edit-request-changed/u);
  assert.match(api, /\/v1\/wiki\/edit-requests\/reviewable-summary/u);
  assert.match(queuePage, /value="reviewable"/u);
  assert.match(detail, /dispatchEvent\(new Event\('wiki:edit-request-changed'\)\)/u);
  assert.match(queue, /href=\{item\.detailPath\}/u);
  assert.doesNotMatch(queue, /buildServerWikiToolPath/u);
});
