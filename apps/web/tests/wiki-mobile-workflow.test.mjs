import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const article = await readFile(new URL('../components/wiki/wiki-article-view.tsx', import.meta.url), 'utf8');
const editor = await readFile(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8');

test('mobile readers can reach primary document actions before the article body', () => {
  const actions = article.indexOf('aria-label="문서 주요 작업"');
  const body = article.indexOf('id={contentId}');

  assert.ok(actions > 0);
  assert.ok(body > actions);
  assert.match(article, /grid grid-cols-3 gap-2 lg:hidden/u);
  assert.match(article.slice(actions, body), /\/> 편집/u);
  assert.match(article.slice(actions, body), /\/> 역사/u);
  assert.match(article.slice(actions, body), /\/> 토론/u);
});

test('mobile editors can preview immediately after the source and file search has dialog semantics', () => {
  const source = editor.indexOf('aria-label={sectionAnchor ? \'위키 섹션 본문\'');
  const mobilePreview = editor.indexOf('id="wiki-mobile-preview"');
  const fileTools = editor.indexOf('파일 저작권·출처');

  assert.ok(source > 0);
  assert.ok(mobilePreview > source);
  assert.ok(fileTools > mobilePreview);
  assert.match(editor, /aria-expanded=\{filePickerOpen\}/u);
  assert.match(editor, /aria-controls="wiki-file-picker"/u);
  assert.match(editor, /role="search"/u);
});
