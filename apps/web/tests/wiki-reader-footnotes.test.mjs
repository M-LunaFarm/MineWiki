import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [hydrator, mainArticle, serverArticle, css] = await Promise.all([
  readFile(new URL('../components/wiki/wiki-reader-interaction-hydrator.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/wiki-article-view.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
]);

test('wiki readers progressively enhance sanitized footnote anchors in both article surfaces', () => {
  assert.match(mainArticle, /WikiReaderInteractionHydrator/u);
  assert.match(serverArticle, /WikiReaderInteractionHydrator/u);
  assert.match(hydrator, /collapsed-headings/u);
  assert.match(hydrator, /aria-expanded/u);
  assert.match(hydrator, /hashchange/u);
  assert.match(hydrator, /\.wiki-footnote-ref > a\[href\^="#fn-"\]/u);
  assert.match(hydrator, /cloneNode\(true\)/u);
  assert.match(hydrator, /root\.contains\(note\)/u);
  assert.doesNotMatch(hydrator, /innerHTML/u);
});

test('desktop footnote preview preserves anchor fallback and keyboard escape', () => {
  assert.match(hydrator, /mouseenter/u);
  assert.match(hydrator, /focus/u);
  assert.match(hydrator, /event\.key !== 'Escape'/u);
  assert.match(hydrator, /reference\.focus\(\)/u);
  assert.match(hydrator, /if \(!window\.matchMedia\(MOBILE_QUERY\)\.matches\) return;/u);
  assert.match(hydrator, /if \(openDialog\(reference\)\) event\.preventDefault\(\)/u);
});

test('mobile footnote dialog has a label, close control, focus return, and safe cleanup', () => {
  assert.match(hydrator, /document\.createElement\('dialog'\)/u);
  assert.match(hydrator, /aria-labelledby/u);
  assert.match(hydrator, /각주 닫기/u);
  assert.match(hydrator, /activeReference\?\.focus\(\)/u);
  assert.match(hydrator, /dialog\.element\.remove\(\)/u);
  assert.match(css, /\.wiki-footnote-dialog::backdrop/u);
});
