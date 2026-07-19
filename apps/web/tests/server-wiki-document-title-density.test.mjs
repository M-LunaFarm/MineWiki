import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [article, css] = await Promise.all([
  readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
]);

test('server wiki chrome suppresses only an equivalent leading content title', () => {
  assert.match(article, /page\.headings\[0\]\?\.level === 1/u);
  assert.match(article, /normalizeDocumentTitle\(page\.headings\[0\]\.title\) === normalizeDocumentTitle\(documentTitle\)/u);
  assert.match(article, /visibleHeadings = hidesLeadingContentTitle \? page\.headings\.slice\(1\)/u);
  assert.match(article, /server-wiki-hide-leading-title/u);
  assert.match(css, /server-wiki-hide-leading-title > h1:first-child/u);
});

test('server wiki table of contents and counts use the de-duplicated heading list', () => {
  assert.match(article, /visibleHeadings\.length\}개 섹션/u);
  assert.equal((article.match(/visibleHeadings\.map/g) ?? []).length, 2);
  assert.doesNotMatch(article, /page\.headings\.map/u);
});
