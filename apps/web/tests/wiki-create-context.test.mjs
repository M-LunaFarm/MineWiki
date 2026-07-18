import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const editor = await readFile(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8');
const api = await readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');

test('new wiki documents resolve a space before templates, uploads, and mutations', () => {
  assert.match(editor, /fetchWikiCreateContext\(\{ namespace, title, spaceId: createSpaceId \?\? undefined \}\)/);
  assert.match(editor, /listWikiDocumentTemplates\(\{ spaceId: createContext\.spaceId \}\)/);
  assert.match(editor, /pageId: page\?\.id,\s*spaceId: uploadSpaceId \?\? undefined,/);
  assert.match(editor, /spaceId: page \? undefined : createContext\?\.spaceId,/);
  assert.match(editor, /spaceId: createContext\?\.spaceId, contentRaw/);
});

test('wiki browser API keeps page and space template targets mutually exclusive', () => {
  assert.match(api, /fetchWikiCreateContext/);
  assert.match(api, /if \(input\.pageId && input\.spaceId\) throw new Error/);
  assert.match(api, /params\.set\('spaceId', input\.spaceId\)/);
});
