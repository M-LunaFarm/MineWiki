import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  buildCategoryWikiToolPath,
  buildServerWikiToolPath,
  buildStandardWikiToolPath,
  buildWikiDiffPath,
  buildWikiHistoryPath,
  buildWikiPagePath,
  buildWikiRevisionPath,
  buildWikiRoutePath,
  decodeWikiRouteSegment,
  parseServerWikiToolRoute,
  parseStandardWikiToolRoute,
  safeWikiReturnTo,
} from '../lib/wiki-routes.mjs';

test('builds readable Korean wiki paths from encoded Next route segments', () => {
  assert.equal(
    buildWikiRoutePath('wiki', ['%EB%8C%80%EB%AC%B8']),
    '/wiki/대문',
  );
});

test('preserves plain and malformed route segments safely', () => {
  assert.equal(buildWikiRoutePath('server', ['creeper-wiki', 'rules']), '/server/creeper-wiki/rules');
  assert.equal(decodeWikiRouteSegment('%E0%A4%A'), '%E0%A4%A');
});

test('uses the namespace front page when no path segments are present', () => {
  assert.equal(buildWikiRoutePath('help'), '/help/대문');
});

test('builds nested category document paths inside the category namespace', () => {
  assert.equal(
    buildWikiRoutePath('category', ['%EA%B2%8C%EC%9E%84%ED%94%8C%EB%A0%88%EC%9D%B4', '%EB%AA%B9']),
    '/wiki/category/게임플레이/몹',
  );
});

test('preserves every namespace after a page move response', () => {
  const routes = [
    ['main', '설치', '/wiki/설치'],
    ['mod', 'Sodium', '/mod/Sodium'],
    ['modpack', 'All_the_Mods', '/modpack/All_the_Mods'],
    ['dev', 'API/역사', '/dev/API/역사'],
    ['guide', '시작/설치', '/guide/시작/설치'],
    ['data', '블록', '/data/블록'],
    ['help', '문법', '/help/문법'],
    ['project', 'MineWiki', '/project/MineWiki'],
    ['template', '서버', '/template/서버'],
    ['user', 'discord_owner_name/작업실', '/user/discord_owner_name/작업실'],
    ['category', '게임플레이/몹', '/wiki/category/게임플레이/몹'],
    ['file', 'logo.png', '/file/logo.png'],
    ['server', 'minewiki/규칙', '/server/minewiki/규칙'],
  ];
  for (const [namespace, slug, expected] of routes) {
    assert.equal(buildWikiPagePath(namespace, slug), expected);
  }
});

test('keeps category edit and history tools outside document title space', () => {
  assert.equal(
    buildCategoryWikiToolPath('/wiki/category/게임플레이/몹', 'edit'),
    '/wiki/category/_tools/edit/게임플레이/몹',
  );
  assert.equal(
    buildCategoryWikiToolPath('/wiki/category/게임플레이/몹', 'history'),
    '/wiki/category/_tools/history/게임플레이/몹',
  );
  assert.throws(() => buildCategoryWikiToolPath('/wiki/대문', 'edit'), /Not a category wiki route/);
});

test('keeps reserved-looking document names separate from canonical server tools', () => {
  assert.equal(parseServerWikiToolRoute(['luna', 'requests']), null);
  assert.equal(parseServerWikiToolRoute(['luna', 'API', 'history']), null);
  assert.deepEqual(parseServerWikiToolRoute(['luna', '_tools', 'history', 'API', 'requests']), {
    tool: 'history',
    documentSegments: ['luna', 'API', 'requests'],
  });
});

test('builds explicit tool routes for every standard wiki namespace', () => {
  const routes = [
    ['/wiki/대문', '/wiki/_tools/edit/대문'],
    ['/mod/Sodium', '/mod/_tools/edit/Sodium'],
    ['/modpack/All%20the%20Mods', '/modpack/_tools/edit/All%20the%20Mods'],
    ['/dev/API/history', '/dev/_tools/edit/API/history'],
    ['/guide/history', '/guide/_tools/edit/history'],
    ['/data/blocks/edit', '/data/_tools/edit/blocks/edit'],
    ['/help/문법', '/help/_tools/edit/문법'],
    ['/project/MineWiki', '/project/_tools/edit/MineWiki'],
    ['/template/서버', '/template/_tools/edit/서버'],
    ['/user/discord_owner_name', '/user/_tools/edit/discord_owner_name'],
    ['/file/logo.png', '/file/_tools/edit/logo.png'],
  ];
  for (const [documentPath, editPath] of routes) {
    assert.equal(buildStandardWikiToolPath(documentPath, 'edit'), editPath);
    assert.equal(
      buildStandardWikiToolPath(documentPath, 'history'),
      editPath.replace('/_tools/edit/', '/_tools/history/'),
    );
  }
});

test('parses only the explicit standard tool prefix and leaves suffix names as documents', () => {
  assert.deepEqual(parseStandardWikiToolRoute(['_tools', 'edit', 'API', 'history']), {
    tool: 'edit',
    documentSegments: ['API', 'history'],
  });
  assert.deepEqual(parseStandardWikiToolRoute(['_tools', 'history', 'edit']), {
    tool: 'history',
    documentSegments: ['edit'],
  });
  for (const documentSegments of [['edit'], ['history'], ['API', 'edit'], ['API', 'history']]) {
    assert.equal(parseStandardWikiToolRoute(documentSegments), null);
  }
});

test('builds canonical server tool paths for root and nested documents', () => {
  assert.equal(buildServerWikiToolPath('/server/luna', 'edit'), '/server/luna/_tools/edit');
  assert.equal(
    buildServerWikiToolPath('/server/luna/API/requests', 'history'),
    '/server/luna/_tools/history/API/requests',
  );
  assert.equal(
    buildServerWikiToolPath('/serverWiki/luna-docs/API/requests', 'history'),
    '/serverWiki/luna-docs/_tools/history/API/requests',
  );
  assert.throws(() => buildServerWikiToolPath('/wiki/대문', 'history'), /Not a server wiki route/);
});

test('keeps page ACL inside the canonical server wiki workspace', () => {
  assert.equal(buildServerWikiToolPath('/server/luna/rules', 'acl'), '/server/luna/_tools/acl/rules');
  assert.deepEqual(parseServerWikiToolRoute(['luna', '_tools', 'acl', 'rules']), {
    tool: 'acl',
    documentSegments: ['luna', 'rules'],
  });
});

test('revision and diff links preserve the canonical source document', () => {
  const returnTo = '/server/luna/API/requests';
  assert.equal(
    buildWikiRevisionPath('42', returnTo),
    '/wiki/revision/42?returnTo=%2Fserver%2Fluna%2FAPI%2Frequests',
  );
  assert.equal(
    buildWikiDiffPath('41', '42', returnTo),
    '/wiki/diff/41/42?returnTo=%2Fserver%2Fluna%2FAPI%2Frequests',
  );
});

test('history links preserve server, category, and standard document route families', () => {
  assert.equal(buildWikiHistoryPath('/server/luna/rules'), '/server/luna/_tools/history/rules');
  assert.equal(buildWikiHistoryPath('/serverWiki/luna-docs/rules'), '/serverWiki/luna-docs/_tools/history/rules');
  assert.equal(buildWikiHistoryPath('/wiki/category/게임/몹'), '/wiki/category/_tools/history/게임/몹');
  assert.equal(buildWikiHistoryPath('/guide/setup'), '/guide/_tools/history/setup');
});

test('current revision action uses the canonical source document return path', async () => {
  const source = await readFile(
    new URL('../components/wiki/wiki-article-view.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /buildWikiRevisionPath\(page\.revision\.id, routePath\)/u);
  assert.doesNotMatch(source, /href=\{`\/wiki\/revision\/\$\{page\.revision\.id\}`\}/u);
});

test('wiki return paths reject external and protocol-relative destinations', () => {
  assert.equal(safeWikiReturnTo('/server/luna/rules'), '/server/luna/rules');
  assert.equal(safeWikiReturnTo('//evil.example/path'), null);
  assert.equal(safeWikiReturnTo('/\\evil.example/path'), null);
  assert.equal(safeWikiReturnTo('https://evil.example/path'), null);
  assert.equal(buildWikiRevisionPath('42', '//evil.example/path'), '/wiki/revision/42');
});
