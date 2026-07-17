import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [page, client, api, tools] = await Promise.all([
  readFile(new URL('../app/wiki/upload/page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/wiki-upload-client.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/wiki-page-tools.tsx', import.meta.url), 'utf8'),
]);

test('standalone upload resolves a wiki space and is discoverable from document tools', () => {
  assert.match(page, /fetchWikiPageByPath\('\/wiki'\)/u);
  assert.match(page, /<WikiUploadClient spaceId=\{spaceId\}/u);
  assert.match(page, /space-y-7 px-4 py-10 sm:px-6 lg:px-0/u);
  assert.match(tools, /href=\{`\/wiki\/upload\?spaceId=\$\{encodeURIComponent\(spaceId\)\}`\}/u);
});

test('standalone upload sends space-scoped ACL context and required attribution', () => {
  assert.match(client, /spaceId,/u);
  assert.match(client, /license,/u);
  assert.match(client, /sourceRequired && !sourceUrl\.trim\(\)/u);
  assert.match(client, /wikiDocumentPath/u);
  assert.match(api, /linkedResourceType: input\.pageId \? 'wiki_page' : 'wiki_space'/u);
  assert.match(api, /Boolean\(input\.pageId\) === Boolean\(input\.spaceId\)/u);
});
