import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const route = await readFile(new URL('../components/wiki/wiki-route-page.tsx', import.meta.url), 'utf8');
const context = await readFile(new URL('../components/wiki/wiki-document-context.tsx', import.meta.url), 'utf8');
const serverApi = await readFile(new URL('../lib/wiki-server-api.ts', import.meta.url), 'utf8');

test('ordinary wiki documents enrich the body with ACL-filtered backlinks and category peers', () => {
  assert.match(route, /fetchWikiBacklinks\(page\.id, 8\)/u);
  assert.match(route, /page\.categories\.slice\(0, 3\)/u);
  assert.match(route, /<WikiDocumentContext/u);
  assert.match(route, /fetchWikiRevisions\(page\.id, 6\)/u);
  assert.match(route, /revisions=\{revisions\}/u);
  assert.match(context, /같이 읽으면 좋은 문서/u);
  assert.match(context, /이 문서를 참고한 문서/u);
  assert.match(context, /dedupeRelated\(related, currentPageId\)/u);
  assert.match(serverApi, /\/v1\/wiki\/pages\/\$\{encodeURIComponent\(pageId\)\}\/backlinks/u);
});

test('ordinary wiki documents expose recent public revision activity', () => {
  assert.match(context, /function RevisionActivity/u);
  assert.match(context, /최근 문서 활동/u);
  assert.match(context, /buildWikiRevisionPath/u);
  assert.match(context, /formatSizeDelta/u);
});

test('server wiki keeps its dedicated GitBook shell instead of receiving the global context cards', () => {
  const serverBranch = route.slice(route.indexOf("if ((prefix === 'server' || prefix === 'serverWiki')"), route.indexOf("if (page.title === '대문'"));
  assert.match(serverBranch, /<ServerWikiArticleView/u);
  assert.doesNotMatch(serverBranch, /WikiDocumentContext/u);
});
