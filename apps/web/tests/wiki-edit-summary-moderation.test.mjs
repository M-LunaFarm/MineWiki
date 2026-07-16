import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('public wiki surfaces render the neutral hidden-summary label from explicit API state', async () => {
  const component = await readFile(new URL('../components/wiki/wiki-edit-summary.tsx', import.meta.url), 'utf8');
  assert.match(component, /편집 요약이 숨겨졌습니다\./u);
  assert.match(component, /if \(hidden\)/u);

  for (const path of [
    '../components/wiki/wiki-history-list-client.tsx',
    '../components/wiki/wiki-recent-changes-client.tsx',
    '../components/wiki/wiki-edit-request-queue-client.tsx',
    '../components/wiki/wiki-edit-requests-client.tsx',
    '../app/wiki/contributions/[profileId]/page.tsx',
    '../app/wiki/revision/[revisionId]/page.tsx'
  ]) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /WikiEditSummary/u);
    assert.match(source, /(editSummaryHidden|summaryHidden)/u);
  }
});

test('admin revision detail exposes an accessible summary-only moderation control with confirmation and bounded reason', async () => {
  const source = await readFile(new URL('../components/wiki/wiki-admin-revision-console.tsx', import.meta.url), 'utf8');
  assert.match(source, /원본 편집 요약 \(관리자 전용\)/u);
  assert.match(source, /editSummaryModeration\.moderatorName/u);
  assert.match(source, /editSummaryModeration\.reason/u);
  assert.match(source, /expectedVersion: revision\.editSummaryModerationVersion/u);
  assert.match(source, /maxLength=\{500\}/u);
  assert.match(source, /type="checkbox"/u);
  assert.match(source, /편집 요약만/u);
  assert.match(source, /min-h-11/u);
  assert.match(source, /aria-describedby="edit-summary-moderation-help"/u);
});

test('browser moderation API sends only summary state, optimistic version, and reason', async () => {
  const source = await readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');
  assert.match(source, /updateWikiAdminRevisionEditSummary/u);
  assert.match(source, /\/edit-summary`/u);
  assert.match(source, /hidden: input\.hidden/u);
  assert.match(source, /expectedVersion: input\.expectedVersion/u);
  assert.match(source, /reason: input\.reason/u);
});
