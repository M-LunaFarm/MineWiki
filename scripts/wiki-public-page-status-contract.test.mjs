import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const require = createRequire(import.meta.url);
const {
  PUBLIC_WIKI_PAGE_STATUSES,
  PUBLIC_WIKI_PAGE_STATUS_SQL_LIST,
  isPublicWikiPageStatus,
} = require('../packages/wiki-core/page-status.js');

const [readService, permissionService, publicationService, backfill, validation] = await Promise.all([
  readFile(new URL('../apps/api/src/wiki/wiki-read.service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/api/src/wiki/wiki-permission.service.ts', import.meta.url), 'utf8'),
  readFile(new URL('../apps/api/src/server/server-wiki-publication.service.ts', import.meta.url), 'utf8'),
  readFile(new URL('./backfill-wiki-search.mjs', import.meta.url), 'utf8'),
  readFile(new URL('./validate-data.mjs', import.meta.url), 'utf8'),
]);

test('public wiki page status contract includes protected published documents', () => {
  assert.deepEqual(PUBLIC_WIKI_PAGE_STATUSES, ['normal', 'active', 'published', 'protected']);
  assert.equal(PUBLIC_WIKI_PAGE_STATUS_SQL_LIST, "'normal', 'active', 'published', 'protected'");
  assert.equal(isPublicWikiPageStatus('protected'), true);
  assert.equal(isPublicWikiPageStatus('deleted'), false);
  assert.equal(isPublicWikiPageStatus('hidden'), false);
});

test('API discovery and permission paths consume the shared public status contract', () => {
  assert.match(readService, /PUBLIC_WIKI_PAGE_STATUSES/u);
  assert.match(readService, /PUBLIC_WIKI_PAGE_STATUS_SQL_LIST/u);
  assert.match(permissionService, /isPublicWikiPageStatus/u);
  assert.match(publicationService, /isPublicWikiPageStatus/u);
  for (const source of [readService, permissionService, publicationService]) {
    assert.doesNotMatch(source, /\['normal', 'active', 'published'\]/u);
  }
});

test('search backfill and data validation consume the same SQL status list', () => {
  assert.match(backfill, /PUBLIC_WIKI_PAGE_STATUSES/u);
  assert.match(backfill, /PUBLIC_WIKI_PAGE_STATUS_SQL_LIST/u);
  assert.match(validation, /PUBLIC_WIKI_PAGE_STATUS_SQL_LIST/u);
  for (const source of [backfill, validation]) {
    assert.doesNotMatch(source, /IN \('normal', 'active', 'published'\)/u);
  }
});
