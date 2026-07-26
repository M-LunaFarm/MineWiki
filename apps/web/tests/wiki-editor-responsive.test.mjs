import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const editor = await readFile(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8');
const toolbar = await readFile(new URL('../components/wiki/wiki-editor-toolbar.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('wiki editor constrains every grid branch to the mobile viewport', () => {
  assert.match(editor, /wiki-editor-shell mx-auto flex min-w-0 w-full/u);
  assert.match(editor, /grid min-w-0 gap-6/u);
  assert.match(editor, /<section className="min-w-0 space-y-4">/u);
  assert.match(editor, /<aside className="min-w-0 space-y-4">/u);
  assert.match(editor, /min-h-\[520px\] max-w-full w-full/u);
});

test('format toolbar scrolls internally instead of widening the document', () => {
  assert.match(toolbar, /wiki-editor-toolbar w-full max-w-full overflow-x-auto/u);
  assert.match(css, /\.wiki-editor-toolbar/u);
  assert.match(css, /overscroll-behavior-inline: contain/u);
});
