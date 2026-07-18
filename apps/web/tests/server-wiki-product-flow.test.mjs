import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const detail = await readFile(new URL('../components/servers/server-detail-showcase.tsx', import.meta.url), 'utf8');
const wiki = await readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8');
const wikiHeader = await readFile(new URL('../components/wiki/server-wiki-header.tsx', import.meta.url), 'utf8');
const wikiServerApi = await readFile(new URL('../lib/wiki-server-api.ts', import.meta.url), 'utf8');
const appShell = await readFile(new URL('../components/layout/app-shell.tsx', import.meta.url), 'utf8');

test('server detail promotes linked documentation as a first-class child experience', () => {
  const overview = detail.indexOf('<ServerOverviewCard detail={detail} />');
  const documentation = detail.indexOf('id="server-documentation-title"');
  const reviews = detail.indexOf('id="server-reviews"');

  assert.ok(overview > 0);
  assert.ok(documentation > overview);
  assert.ok(reviews > documentation);
  assert.match(detail.slice(documentation, reviews), /서버 위키 열기/u);
  assert.match(detail.slice(documentation, reviews), /GitBook처럼 문서별로/u);
});

test('server wiki uses its own documentation shell and enriches the root document with navigation', () => {
  const header = wiki.indexOf('<ServerWikiHeader page={pageWithNavigation} />');
  const article = wiki.indexOf('id={contentId}');
  const startHere = wiki.indexOf('id="server-wiki-start-here-title"');

  assert.ok(header > 0);
  assert.ok(article > header);
  assert.ok(startHere > article);
  assert.match(wiki, /const isWikiHome = currentIndex === 0/u);
  assert.match(wiki, /fetchServerWikiNavigation\(wiki\.contentSlug, wiki\.navigationKey\)\.catch\(\(\) => null\)/u);
  assert.match(wikiServerApi, /new URLSearchParams\(\{ key: navigationKey \}\)/u);
  assert.match(wikiServerApi, /navigationKey\.startsWith\('draft:'\) \? 'no-store' : 'force-cache'/u);
  assert.match(wiki, /pageNavigation\.filter\(\(item\) => !item\.current\)\.slice\(0, 6\)/u);
  assert.match(wikiHeader, /Documentation/u);
  assert.match(wikiHeader, /서버 문서 검색/u);
  assert.match(wikiHeader, /서버 정보/u);
  assert.match(wikiHeader, /<details className="group relative lg:hidden">/u);
  assert.match(wikiHeader, /bg-white\/95/u);
  assert.match(wiki, /max-w-\[1440px\]/u);
  assert.match(wiki, /이 페이지에서 찾기/u);
  assert.match(wiki, /\{page\.headings\.length\}개 섹션/u);
  assert.doesNotMatch(wiki, /섹션 목차·편집/u);
  assert.match(appShell, /const isServerWikiPage/u);
  assert.match(appShell, /if \(isServerWikiPage\)/u);
  assert.doesNotMatch(appShell.slice(appShell.indexOf('if (isServerWikiPage)'), appShell.indexOf('if (isWikiPage)')), /SiteHeader/u);
  assert.doesNotMatch(wiki, /랭킹 서버 상세로 돌아가기/u);
});
