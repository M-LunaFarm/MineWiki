import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editorSource = await readFile(
  new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url),
  'utf8',
);
const apiSource = await readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');

test('wiki preview binds include expansion to the stable page identity', () => {
  assert.match(editorSource, /pageId:\s*page\?\.id/u);
  assert.match(apiSource, /readonly pageId\?: string/u);
  assert.match(apiSource, /JSON\.stringify\(\{ contentRaw, \.\.\.context \}\)/u);
});

test('editor copy promises only ACL-readable include expansion', () => {
  assert.doesNotMatch(editorSource, /미리보기에서는 포함 본문을 해석하지 않/u);
  assert.match(editorSource, /미리보기와 저장된 문서 모두 현재 계정이 읽을 수 있는 틀만 본문에 펼칩니다/u);
});
