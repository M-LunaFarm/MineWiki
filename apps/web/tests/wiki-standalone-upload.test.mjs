import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [page, client, queueView, api, tools] = await Promise.all([
  readFile(new URL('../app/wiki/upload/page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/wiki-upload-client.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/wiki-upload-queue-view.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/wiki-page-tools.tsx', import.meta.url), 'utf8'),
]);

test('standalone upload resolves a wiki space and is discoverable from document tools', () => {
  assert.match(page, /fetchWikiPageByPath\('\/wiki'\)/u);
  assert.match(page, /<WikiUploadClient spaceId=\{spaceId\}/u);
  assert.match(page, /space-y-7 px-4 py-10 sm:px-6 lg:px-0/u);
  assert.match(tools, /const uploadHref = `\/wiki\/upload\?spaceId=\$\{encodeURIComponent\(spaceId\)\}&returnTo=\$\{encodeURIComponent\(routePath\)\}`/u);
  assert.match(tools, /href=\{uploadHref\}/u);
});

test('standalone upload sends space-scoped ACL context and required attribution', () => {
  assert.match(client, /spaceId,/u);
  assert.match(client, /license,/u);
  assert.match(client, /wikiUploadMetadataError/u);
  assert.match(queueView, /wikiDocumentPath/u);
  assert.match(api, /linkedResourceType: input\.pageId \? 'wiki_page' : 'wiki_space'/u);
  assert.match(api, /Boolean\(input\.pageId\) === Boolean\(input\.spaceId\)/u);
});

test('standalone upload exposes a bounded serial multi-image queue', () => {
  assert.match(page, /이미지 1~10개/u);
  assert.match(client, /type="file" multiple/u);
  assert.match(client, /mergeWikiUploadSelection/u);
  assert.match(client, /runWikiUploadQueue/u);
  assert.match(client, /현재 파일 후 중단/u);
  assert.match(client, /성공 \{successCount\}개 문법 복사/u);
  assert.doesNotMatch(client, /files\?\.\[0\]/u);
});

test('standalone upload versions replacements and restores history with optimistic concurrency', () => {
  assert.match(client, /기존 파일 교체/u);
  assert.match(client, /replaceFileId: replaceFileId \|\| undefined/u);
  assert.match(client, /fetchWikiFileVersions/u);
  assert.match(client, /restoreWikiFileVersion/u);
  assert.match(client, /expectedCurrentVersionNo: current\.versionNo/u);
  assert.match(client, /복원 작업도 새 버전으로 기록/u);
  assert.match(api, /\/versions\/\$\{encodeURIComponent\(input\.versionId\)\}\/restore/u);
  assert.match(api, /headers: \{ 'Content-Type': 'application\/json', \.\.\.\(await csrfHeaders\(\)\) \}/u);
});
