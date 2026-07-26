import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const article = await readFile(new URL('../components/wiki/wiki-article-view.tsx', import.meta.url), 'utf8');
const tools = await readFile(new URL('../components/wiki/wiki-page-tools.tsx', import.meta.url), 'utf8');
const css = await readFile(new URL('../app/globals.css', import.meta.url), 'utf8');

test('ordinary wiki pages use a compact accordion rail with the table of contents open', () => {
  assert.match(article, /aria-label="이 문서"/u);
  assert.match(article, /<details className="wiki-rail-panel hidden lg:block" open>/u);
  assert.match(article, /<details className="wiki-rail-panel lg:hidden">/u);
  for (const label of ['목차', '최근 변경', '문서 정보', '도구', '분류']) {
    assert.ok(article.includes(label));
  }
  assert.match(article, /embedded/u);
  assert.match(tools, /embedded = false/u);
});

test('mobile places the compact rail before the article without hiding primary actions', () => {
  assert.match(article, /wiki-rendered wiki-mobile-full order-2/u);
  assert.match(article, /wiki-reader-rail order-1/u);
  assert.match(article, /aria-label="문서 주요 작업"/u);
  assert.match(article, /keySuffix="mobile"/u);
});

test('accordion rail defines explicit light and dark surfaces', () => {
  assert.match(css, /\.wiki-rail-panel > summary/u);
  assert.match(css, /\.wiki-rail-panel\[open\] \.wiki-rail-chevron/u);
  assert.match(css, /html\[data-theme='light'\] \.wiki-rail-panel/u);
  assert.match(css, /html\[data-theme='light'\] \.wiki-rail-panel-label > svg/u);
});
