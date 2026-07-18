import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  applyWikiEditorFormat,
  wikiEditorShortcutAction,
} from '../lib/wiki-editor-formatting.mjs';

test('collapsed formatting inserts an editable placeholder and selects it', () => {
  const result = applyWikiEditorFormat({ value: '앞 뒤', selectionStart: 2, selectionEnd: 2 }, 'bold');

  assert.equal(result.value, "앞 '''굵은 텍스트'''뒤");
  assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), '굵은 텍스트');
});

test('selected inline formatting wraps content and toggles back without losing selection', () => {
  const wrapped = applyWikiEditorFormat({ value: '선택 본문', selectionStart: 3, selectionEnd: 5 }, 'italic');
  assert.equal(wrapped.value, "선택 ''본문''");
  assert.equal(wrapped.value.slice(wrapped.selectionStart, wrapped.selectionEnd), '본문');

  const unwrapped = applyWikiEditorFormat({
    value: wrapped.value,
    selectionStart: wrapped.selectionStart,
    selectionEnd: wrapped.selectionEnd,
  }, 'italic');
  assert.equal(unwrapped.value, '선택 본문');
  assert.equal(unwrapped.value.slice(unwrapped.selectionStart, unwrapped.selectionEnd), '본문');
});

test('multiline list formatting prefixes complete selected lines and toggles them', () => {
  const value = '머리\n첫째\n둘째\n꼬리';
  const start = value.indexOf('첫째');
  const end = value.indexOf('\n꼬리');
  const listed = applyWikiEditorFormat({ value, selectionStart: start, selectionEnd: end }, 'unordered-list');

  assert.equal(listed.value, '머리\n * 첫째\n * 둘째\n꼬리');
  assert.equal(listed.value.slice(listed.selectionStart, listed.selectionEnd), ' * 첫째\n * 둘째');

  const plain = applyWikiEditorFormat({
    value: listed.value,
    selectionStart: listed.selectionStart,
    selectionEnd: listed.selectionEnd,
  }, 'unordered-list');
  assert.equal(plain.value, value);
});

test('Korean and emoji selections preserve UTF-16 editor offsets', () => {
  const value = '앞 😀 한글 뒤';
  const start = value.indexOf('😀');
  const end = start + '😀 한글'.length;
  const result = applyWikiEditorFormat({ value, selectionStart: start, selectionEnd: end }, 'bold');

  assert.equal(result.value, "앞 '''😀 한글''' 뒤");
  assert.equal(result.value.slice(result.selectionStart, result.selectionEnd), '😀 한글');
});

test('block actions isolate rich wiki snippets and select their editable content', () => {
  const code = applyWikiEditorFormat({ value: '앞뒤', selectionStart: 1, selectionEnd: 1 }, 'code-block');
  assert.equal(code.value, '앞\n{{{#!syntax text\n코드\n}}}\n뒤');
  assert.equal(code.value.slice(code.selectionStart, code.selectionEnd), '코드');

  const table = applyWikiEditorFormat({ value: '', selectionStart: 0, selectionEnd: 0 }, 'table');
  assert.equal(table.value, '||<thead>항목||설명||\n||값||내용||');
  assert.equal(table.value.slice(table.selectionStart, table.selectionEnd), '항목');

  const include = applyWikiEditorFormat({ value: '', selectionStart: 0, selectionEnd: 0 }, 'include');
  assert.equal(include.value, '[include(틀:안내)]');
  assert.equal(include.value.slice(include.selectionStart, include.selectionEnd), '틀:안내');
});

test('wiki editor shortcuts require a primary modifier and reject shifted or alternate chords', () => {
  assert.equal(wikiEditorShortcutAction({ key: 'b', ctrlKey: true }), 'bold');
  assert.equal(wikiEditorShortcutAction({ key: 'I', metaKey: true }), 'italic');
  assert.equal(wikiEditorShortcutAction({ key: 'k', metaKey: true }), 'link');
  assert.equal(wikiEditorShortcutAction({ key: 'b' }), null);
  assert.equal(wikiEditorShortcutAction({ key: 'b', ctrlKey: true, shiftKey: true }), null);
  assert.equal(wikiEditorShortcutAction({ key: 'k', ctrlKey: true, altKey: true }), null);
});

test('wiki editor statically integrates the separated accessible toolbar', async () => {
  const [editor, toolbar] = await Promise.all([
    readFile(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/wiki-editor-toolbar.tsx', import.meta.url), 'utf8'),
  ]);

  assert.match(editor, /applyWikiEditorFormat/u);
  assert.match(editor, /wikiEditorShortcutAction/u);
  assert.match(editor, /<WikiEditorToolbar/u);
  assert.match(editor, /ref=\{textareaRef\}/u);
  assert.match(editor, /onKeyDown=\{handleEditorKeyDown\}/u);
  assert.match(editor, /setSelectionRange\(result\.selectionStart, result\.selectionEnd\)/u);
  assert.match(toolbar, /role="toolbar" aria-label="위키 본문 서식"/u);
  assert.match(toolbar, /overflow-x-auto/u);
  assert.match(toolbar, /action="table"/u);
  assert.match(toolbar, /action="callout"/u);
  assert.match(toolbar, /action="footnote"/u);
  assert.match(toolbar, /action="include"/u);
  assert.match(toolbar, /aria-label=\{title\}/u);
  assert.match(toolbar, /onMouseDown=\{\(event\) => event\.preventDefault\(\)\}/u);
});
