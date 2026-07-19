import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [toggle, article, workspace, sidebar, css] = await Promise.all([
  readFile(new URL('../components/wiki/server-wiki-reading-mode-toggle.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/server-wiki-workspace.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/server-wiki-sidebar.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
]);

test('wide reading mode is keyboard accessible and persists without blocking storage', () => {
  assert.match(toggle, /type="button"/u);
  assert.match(toggle, /aria-pressed=\{wide\}/u);
  assert.match(toggle, /localStorage\.getItem\(STORAGE_KEY\)/u);
  assert.match(toggle, /localStorage\.setItem\(STORAGE_KEY/u);
  assert.match(toggle, /document\.documentElement\.dataset\.serverWikiWide/u);
});

test('wide mode removes both navigation rails while preserving a bounded article width', () => {
  assert.match(article, /server-wiki-main/u);
  assert.match(article, /server-wiki-article/u);
  assert.match(article, /server-wiki-toc/u);
  assert.match(workspace, /server-wiki-main/u);
  assert.match(sidebar, /server-wiki-sidebar/u);
  assert.match(css, /data-server-wiki-wide='true'[\s\S]*grid-template-columns: minmax\(0, 1fr\) !important/u);
  assert.match(css, /max-width: 1180px/u);
});

test('compact vertical rhythm is scoped to rendered server documents', () => {
  assert.match(css, /\.server-wiki-rendered :is\(p, ul, ol, table, blockquote, pre\)/u);
  assert.match(css, /\.server-wiki-rendered h2/u);
  assert.doesNotMatch(css, /\.wiki-rendered :is\(p, ul, ol, table, blockquote, pre\) \{\s*margin-top: 0\.75rem/u);
});
