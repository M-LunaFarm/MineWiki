import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const route = await readFile(new URL('../components/wiki/wiki-route-page.tsx', import.meta.url), 'utf8');
const frontPage = await readFile(new URL('../components/wiki/wiki-namespace-front-page.tsx', import.meta.url), 'utf8');

test('standard namespace roots enrich editable body content with live public discovery data', () => {
  assert.match(route, /page\.title === '대문'/u);
  assert.match(route, /fetchWikiPublicStats\(namespace\)/u);
  assert.match(route, /fetchWikiRecent\(\{ namespace \}\)/u);
  assert.match(route, /fetchWikiSpecial\(\{ type: 'long', namespace, limit: 7 \}\)/u);
  assert.match(route, /Promise\.allSettled/u);
  assert.match(route, /afterContent=\{<WikiNamespaceFrontPage/u);
});

test('namespace discovery exposes search, document count, featured pages, and recent updates', () => {
  assert.match(frontPage, /공개 문서/u);
  assert.match(frontPage, /name="namespace" value=\{namespace\}/u);
  assert.match(frontPage, /먼저 읽어볼 문서/u);
  assert.match(frontPage, /최근 업데이트/u);
  assert.match(frontPage, /item\.routePath !== routePath/u);
  assert.match(frontPage, /href="\/wiki\/special"/u);
});
