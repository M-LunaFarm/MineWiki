import assert from 'node:assert/strict';
import test from 'node:test';

import {
  formatWikiNamespace,
  formatWikiResultPath,
  isMissingServerWikiRoot,
} from '../lib/wiki-search-display.mjs';

test('wiki search result paths decode Korean segments for display only', () => {
  assert.equal(
    formatWikiResultPath('/wiki/%EC%84%9C%EB%B2%84_%EC%95%88%EB%82%B4'),
    '/wiki/서버 안내',
  );
  assert.equal(formatWikiResultPath('/wiki/%E0%A4%A'), '/wiki/%E0%A4%A');
  assert.equal(formatWikiNamespace('server'), '서버 위키');
  assert.equal(formatWikiNamespace('custom'), 'custom');
});

test('only a missing standalone server wiki root uses tenant recovery', () => {
  assert.equal(isMissingServerWikiRoot('/serverWiki/missing-server'), true);
  assert.equal(isMissingServerWikiRoot('/serverWiki/missing-server/'), true);
  assert.equal(isMissingServerWikiRoot('/serverWiki/server/missing-page'), false);
  assert.equal(isMissingServerWikiRoot('/wiki/missing-page'), false);
});
