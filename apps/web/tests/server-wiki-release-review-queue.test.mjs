import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('reviewers can discover and approve immutable server wiki candidates without knowing a server UUID', async () => {
  const [client, queuePage, detailPage, badge, header] = await Promise.all([
    readFile(new URL('../components/wiki/server-wiki-release-review-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/wiki/release-reviews/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/wiki/release-reviews/[candidateId]/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/layout/wiki-review-queue-badge.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/layout/site-header.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(client, /\/v1\/wiki\/release-reviews/u);
  assert.match(client, /candidateId: detail\.candidateId/u);
  assert.match(client, /candidateToken: detail\.candidateToken/u);
  assert.match(client, /본문 변경 비교/u);
  assert.match(client, /대기 중인 릴리스 검토가 없습니다/u);
  assert.match(client, /더 불러오기/u);
  assert.match(queuePage, /ServerWikiReleaseReviewQueueClient/u);
  assert.match(detailPage, /ServerWikiReleaseReviewDetailClient/u);
  assert.match(badge, /fetchServerWikiReleaseReviewSummary/u);
  assert.match(header, /href="\/wiki\/release-reviews"/u);
  assert.doesNotMatch(client, /변경사항 공개|비공개 전환/u);
});
