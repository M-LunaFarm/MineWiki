import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { buildWikiFileMarkup } from '../lib/wiki-file-markup.mjs';

const editor = await readFile(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8');

test('wiki editor exposes safe file display controls and emits bounded query options', () => {
  assert.match(editor, /파일 표시 설정/u);
  assert.match(editor, /너비\(px\)/u);
  assert.match(editor, /대체 텍스트/u);
  assert.match(editor, /buildWikiFileMarkup/u);
});

test('wiki file markup serializer encodes delimiters and rejects out-of-contract display values', () => {
  assert.equal(buildWikiFileMarkup({
    filename: 'safe.png', caption: 'Rock & Roll | 100% ]', width: '320', align: 'right', objectFit: 'cover', alt: 'A|B]C'
  }), '[[파일:safe.png|섬네일|width=320&align=right&object-fit=cover&alt=A%7CB%5DC&caption=Rock%20%26%20Roll%20%7C%20100%25%20%5D]]');

  assert.equal(buildWikiFileMarkup({
    filename: 'safe.png', caption: 'width=999', width: '4097', align: 'fixed', objectFit: 'javascript', alt: ''
  }), '[[파일:safe.png|섬네일|caption=width%3D999]]');
});
