import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('server wiki settings exposes a mobile-safe publication lifecycle', async () => {
  const [settings, publication] = await Promise.all([
    readFile(new URL('../components/wiki/server-wiki-settings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/server-wiki-publication-settings.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(settings, /<ServerWikiPublicationSettings serverId=\{serverId\} \/>/u);
  assert.match(publication, /wiki-publication/u);
  assert.match(publication, /expectedVersion: publication\.version/u);
  assert.match(publication, /status, expectedVersion: publication\.version, reason: reason\.trim\(\)/u);
  assert.match(publication, /publication\.readiness\.ready/u);
  for (const blocker of [
    'missing_required_documents',
    'incomplete_introduction',
    'placeholder_rules',
    'missing_official_channel',
    'search_index_not_ready',
  ]) assert.match(publication, new RegExp(blocker, 'u'));
  assert.match(publication, /confirmation !== '비공개'/u);
  assert.match(publication, /min-h-11 w-full/u);
  assert.match(publication, /aria-live="polite"/u);
});

test('server wiki SSR is request-scoped and preview pages carry a persistent status banner', async () => {
  const [siteRoute, rankingChildRoute, article] = await Promise.all([
    readFile(new URL('../app/serverWiki/[[...path]]/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/server/[[...path]]/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8'),
  ]);

  for (const route of [siteRoute, rankingChildRoute]) {
    assert.match(route, /export const dynamic = 'force-dynamic'/u);
    assert.doesNotMatch(route, /export const revalidate/u);
  }
  assert.match(article, /wiki\.publicationStatus !== 'published'/u);
  assert.match(article, /권한이 있는 협업자에게만 표시됩니다/u);
  assert.match(article, /role="status"/u);
});
