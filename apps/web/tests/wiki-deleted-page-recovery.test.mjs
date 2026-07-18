import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('deleted page list requires review before restoration', async () => {
  const list = await readFile(new URL('components/wiki/wiki-deleted-pages-client.tsx', root), 'utf8');
  assert.match(list, /이력 검토 및 복구/u);
  assert.match(list, /이전 삭제 문서 더 보기/u);
  assert.match(list, /fetchWikiDeletedPages\(cursor\)/u);
  assert.match(list, /\/wiki\/deleted\/\$\{encodeURIComponent\(page\.id\)\}/u);
  assert.doesNotMatch(list, /restoreWikiPage/u);
});

test('recovery workspace previews a selected revision and restores it explicitly', async () => {
  const client = await readFile(new URL('components/wiki/wiki-deleted-page-recovery-client.tsx', root), 'utf8');
  const api = await readFile(new URL('lib/wiki-api.ts', root), 'utf8');
  assert.match(client, /fetchWikiDeletedPageRecovery\(\{ pageId, revisionId \}\)/u);
  assert.match(client, /revisionId: data\.page\.canSelectHistoricalRevision \? data\.selectedRevision\.id : undefined/u);
  assert.match(client, /새 판으로 복사됩니다/u);
  assert.match(api, /me\/deleted-pages\/\$\{encodeURIComponent\(input\.pageId\)\}\/recovery/u);
});
