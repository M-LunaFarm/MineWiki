import assert from 'node:assert/strict';
import test from 'node:test';
import {
  buildServerWikiToolPath,
  buildWikiRoutePath,
  decodeWikiRouteSegment,
  parseServerWikiToolRoute,
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

test('keeps reserved-looking document names separate from canonical server tools', () => {
  assert.equal(parseServerWikiToolRoute(['luna', 'requests']), null);
  assert.equal(parseServerWikiToolRoute(['luna', 'API', 'history']), null);
  assert.deepEqual(parseServerWikiToolRoute(['luna', '_tools', 'history', 'API', 'requests']), {
    tool: 'history',
    documentSegments: ['luna', 'API', 'requests'],
  });
});

test('builds canonical server tool paths for root and nested documents', () => {
  assert.equal(buildServerWikiToolPath('/server/luna', 'edit'), '/server/luna/_tools/edit');
  assert.equal(
    buildServerWikiToolPath('/server/luna/API/requests', 'history'),
    '/server/luna/_tools/history/API/requests',
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
