import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { serverWikiOwnerProgress } from '../lib/server-wiki-owner-progress.mjs';

test('owner progress points each draft lifecycle state at one concrete next action', () => {
  const serverId = '11111111-1111-4111-8111-111111111111';
  assert.equal(serverWikiOwnerProgress({ status: 'unlinked' }, serverId)?.href, '#server-wiki-management');
  assert.match(serverWikiOwnerProgress({ status: 'repair_required' }, serverId)?.href ?? '', /category=server_claim/u);
  assert.deepEqual(
    serverWikiOwnerProgress({
      status: 'needs_attention', completedChecks: 4, totalChecks: 6,
      wikiUrl: '/serverWiki/demo', nextAction: { href: '/serverWiki/demo/_tools/edit', label: '서버 소개 보강하기' },
    }, serverId),
    {
      tone: 'attention', eyebrow: 'Draft Documentation', title: '서버 위키 초안을 계속 완성하세요',
      description: '4/6개 공개 준비 항목을 완료했습니다. 다음 한 단계부터 이어서 작성할 수 있습니다.',
      href: '/serverWiki/demo/_tools/edit', action: '서버 소개 보강하기',
    },
  );
  assert.equal(serverWikiOwnerProgress({ status: 'ready' }, serverId)?.href, `/servers/${serverId}/wiki-layouts`);
});

test('server detail exposes the owner-only progress entry above the main content grid', async () => {
  const [detail, progress] = await Promise.all([
    readFile(new URL('../components/servers/server-detail-showcase.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/servers/server-wiki-owner-progress.tsx', import.meta.url), 'utf8'),
  ]);
  assert.ok(detail.indexOf('<ServerWikiOwnerProgress') < detail.indexOf('xl:grid-cols-[minmax(0,1fr)_360px]'));
  assert.match(progress, /if \(!account \|\| publicWikiUrl\) return/u);
  assert.match(progress, /\/ownership/u);
  assert.match(progress, /\/wiki-readiness/u);
  assert.match(progress, /aria-live="polite"/u);
});
