import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { publicWikiRecentChangeSummary, publicWikiRevisionEditSummary } from './wiki-revision-summary';

test('public revision serialization removes only a hidden edit summary', () => {
  assert.deepEqual(publicWikiRevisionEditSummary({
    editSummary: '민감한 원본 요약', editSummaryHidden: true
  }), {
    editSummary: null, editSummaryHidden: true
  });
  assert.deepEqual(publicWikiRevisionEditSummary({
    editSummary: '정상 요약', editSummaryHidden: false
  }), {
    editSummary: '정상 요약', editSummaryHidden: false
  });
});

test('recent-change summaries derive visibility from the source revision and fail closed when it is missing', () => {
  const visible = new Map([[10n, false], [11n, true]]);
  assert.deepEqual(publicWikiRecentChangeSummary({
    summary: '정상 요약', revisionId: 10n, hiddenByRevisionId: visible
  }), { summary: '정상 요약', summaryHidden: false });
  assert.deepEqual(publicWikiRecentChangeSummary({
    summary: '숨겨야 할 복사본', revisionId: 11n, hiddenByRevisionId: visible
  }), { summary: null, summaryHidden: true });
  assert.deepEqual(publicWikiRecentChangeSummary({
    summary: '고아 복사본', revisionId: 12n, hiddenByRevisionId: visible
  }), { summary: null, summaryHidden: true });
  assert.deepEqual(publicWikiRecentChangeSummary({
    summary: '판과 무관한 관리 기록', revisionId: null, hiddenByRevisionId: visible
  }), { summary: '판과 무관한 관리 기록', summaryHidden: false });
});

test('the MySQL migration is additive and preserves the original edit summary column', async () => {
  const migration = await readFile(
    new URL('../../../../prisma/migrations/20260717130000_wiki_revision_edit_summary_moderation/migration.sql', import.meta.url),
    'utf8'
  );
  for (const column of [
    'edit_summary_hidden',
    'edit_summary_moderation_version',
    'edit_summary_moderated_by',
    'edit_summary_moderated_at',
    'edit_summary_moderation_reason'
  ]) assert.match(migration, new RegExp('ADD COLUMN `' + column + '`'));
  assert.doesNotMatch(migration, /DROP|RENAME|UPDATE\s+`?page_revisions|MODIFY\s+`?edit_summary/iu);
});

test('the moderation endpoint inherits purpose-bound step-up, rate limits writes, and checks authority separately', async () => {
  const controller = await readFile(new URL('./wiki-admin.controller.ts', import.meta.url), 'utf8');
  assert.match(controller, /@RequireStepUp\('wiki_admin'\)[\s\S]*export class WikiAdminController/u);
  assert.match(controller, /@Patch\('revisions\/:id\/edit-summary'\)\s+@Throttle\(\{ default: \{ limit: 8, ttl: 60 \} \}\)/u);
  assert.match(controller, /assertRevisionSummaryModerator\(session\)/u);
  assert.match(controller, /permissions\?\.includes\('wiki\.admin'\)/u);
  const authorityBlock = controller.slice(controller.indexOf('private async assertRevisionSummaryModerator'));
  assert.doesNotMatch(authorityBlock, /isElevated/u);
});

test('search and notification response contracts do not carry revision edit summaries', async () => {
  const readService = await readFile(new URL('./wiki-read.service.ts', import.meta.url), 'utf8');
  const searchContract = readService.match(/export interface WikiSearchResult \{[\s\S]*?\n\}/u)?.[0] ?? '';
  assert.notEqual(searchContract, '');
  assert.doesNotMatch(searchContract, /summary/iu);
  const notifications = await readFile(new URL('./wiki-notification.service.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(notifications, /editSummary/u);
});
