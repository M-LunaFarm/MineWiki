import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('custom server wiki hosts resolve through a fail-closed anonymous middleware boundary', async () => {
  const [middleware, route, layout, auth] = await Promise.all([
    readFile(new URL('../middleware.ts', import.meta.url), 'utf8'),
    readFile(new URL('../lib/server-wiki-public-route.ts', import.meta.url), 'utf8'),
    readFile(new URL('../app/layout.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/providers/auth-context.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(middleware, /request\.headers\.get\('host'\)/u);
  assert.doesNotMatch(middleware, /x-forwarded-host/u);
  assert.match(middleware, /\/v1\/wiki\/domain-routes\//u);
  assert.match(middleware, /cache: 'no-store'/u);
  assert.match(middleware, /requestHeaders\.delete\(header\)/u);
  for (const header of ['authorization', 'cookie', 'x-csrf-token']) assert.match(middleware, new RegExp(`'${header}'`, 'u'));
  assert.match(middleware, /return customDomainNotFound\(\)/u);
  assert.match(middleware, /pathname\.startsWith\('\/_tools\/'\)/u);
  assert.match(route, /serverWikiCanonicalUrl/u);
  assert.match(route, /rewriteServerWikiHtmlLinks/u);
  assert.match(route, /platformSearchPath/u);
  assert.match(route, /action === platformSearchPath/u);
  assert.match(middleware, /target\.pathname = `\/serverWiki\/\$\{encodeURIComponent\(route\.siteSlug\)\}\$\{suffix\}`/u);
  assert.match(layout, /<AuthProvider publicOnly=\{publicOnly\}>/u);
  assert.match(auth, /if \(!publicOnly\) void refresh\(\)/u);
});

test('custom domain settings expose DNS, TLS, optimistic version, and destructive confirmation states', async () => {
  const [settings, domain, page, article] = await Promise.all([
    readFile(new URL('../components/wiki/server-wiki-settings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/server-wiki-domain-settings.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../app/serverWiki/[[...path]]/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(settings, /<ServerWikiDomainSettings serverId=\{serverId\}/u);
  assert.match(domain, /expectedVersion: domain\?\.version \?\? 0/u);
  assert.match(domain, /wiki-domain\/verify/u);
  assert.match(domain, /domain\.challenge\.value/u);
  assert.match(domain, /domain\.tlsReadyAt/u);
  assert.match(domain, /disableConfirmation !== domain\.hostname/u);
  assert.match(page, /serverWikiCanonicalUrl\(routePath, routeContext\)/u);
  assert.match(article, /rewriteServerWikiHtmlLinks\(page\.html, routeContext\)/u);
  assert.match(article, /serverWikiPlatformUrl\(buildServerWikiToolPath/u);
});
