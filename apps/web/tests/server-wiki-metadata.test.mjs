import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('server wiki metadata uses the public release path without forwarding preview cookies', async () => {
  const [page, api] = await Promise.all([
    readFile(new URL('../app/serverWiki/[[...path]]/page.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../lib/wiki-server-api.ts', import.meta.url), 'utf8'),
  ]);
  assert.match(page, /export async function generateMetadata/u);
  assert.match(page, /fetchPublicWikiPageByPath/u);
  assert.match(page, /fetchPublicServerWikiPresentation/u);
  assert.match(page, /presentation\?\.seoTitle/u);
  assert.match(page, /presentation\?\.seoDescription/u);
  assert.match(page, /presentation\?\.seoIndexingEnabled === false/u);
  assert.match(page, /publicationStatus !== 'published'/u);
  assert.match(page, /page\.displayTitle/u);
  assert.match(page, /directoryOverview\?\.shortDescription/u);
  assert.match(page, /path\[1\] === '_search'/u);
  assert.match(page, /parseServerWikiToolRoute\(path\)/u);
  assert.match(api, /fetchPublicWikiPageByPath/u);
  assert.match(api, /cache: 'no-store'/u);
  const publicFetch = api.slice(api.indexOf('export async function fetchPublicWikiPageByPath'), api.indexOf('export async function fetchServerWikiPresentation'));
  assert.doesNotMatch(publicFetch, /cookies\(\)/u);
  assert.doesNotMatch(publicFetch, /cookieHeader/u);
  const publicPresentationFetch = api.slice(api.indexOf('export async function fetchPublicServerWikiPresentation'), api.indexOf('export async function fetchServerWikiPresentation'));
  assert.doesNotMatch(publicPresentationFetch, /cookies\(\)/u);
  assert.doesNotMatch(publicPresentationFetch, /cookieHeader/u);
});
