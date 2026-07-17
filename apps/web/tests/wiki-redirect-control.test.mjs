import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const routeSource = readFileSync(new URL('../app/wiki/[[...path]]/page.tsx', import.meta.url), 'utf8');
const pageSource = readFileSync(new URL('../components/wiki/wiki-route-page.tsx', import.meta.url), 'utf8');
const apiSource = readFileSync(new URL('../lib/wiki-server-api.ts', import.meta.url), 'utf8');

test('the wiki route forwards redirect inspection controls to the page API', () => {
  assert.match(routeSource, /redirect !== '0'/);
  assert.match(routeSource, /noRedirect !== '1'/);
  assert.match(routeSource, /noRedirect !== 'true'/);
  assert.match(routeSource, /followRedirects={followRedirects}/);
  assert.match(pageSource, /fetchWikiPageByPath\(routePath, \{ followRedirects \}\)/);
  assert.match(apiSource, /options\.followRedirects === false/);
  assert.match(apiSource, /params\.set\('redirect', '0'\)/);
});
