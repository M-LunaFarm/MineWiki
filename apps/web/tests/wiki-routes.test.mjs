import assert from 'node:assert/strict';
import test from 'node:test';
import { buildWikiRoutePath, decodeWikiRouteSegment } from '../lib/wiki-routes.mjs';

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
