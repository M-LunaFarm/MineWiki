import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const reportButtonSource = await readFile(
  new URL('../components/wiki/wiki-report-button.tsx', import.meta.url),
  'utf8',
);
const wikiApiSource = await readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');
const moderationSource = await readFile(
  new URL('../components/wiki/wiki-report-admin-client.tsx', import.meta.url),
  'utf8',
);

test('public wiki report receipts do not reveal aggregate moderation signals', () => {
  assert.match(reportButtonSource, /운영진이 보존된 증거와 함께 검토합니다/u);
  assert.doesNotMatch(reportButtonSource, /reportCount\.toLocaleString/u);
  assert.match(wikiApiSource, /readonly reportCount: 1/u);
});

test('moderation UI renders anonymized reporter submissions without a synthetic identity', () => {
  assert.match(wikiApiSource, /reporterProfileId: string \| null/u);
  assert.match(moderationSource, /탈퇴한 신고자/u);
});
