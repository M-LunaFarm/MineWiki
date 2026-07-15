import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildWikiSearchBooleanQuery, buildWikiSearchVector } from '../src/search.js';

test('Korean two-character queries map to an indexed synthetic token', () => {
  const vector = new Set(buildWikiSearchVector(['마인크래프트 서버']).split(' '));
  const queryTerms = buildWikiSearchBooleanQuery('서버').split(' ').map((term) => term.slice(1));

  assert.equal(queryTerms.length, 1);
  assert.equal(vector.has(queryTerms[0]!), true);
});

test('long queries require every adjacent trigram without exposing source text', () => {
  const vector = buildWikiSearchVector(['MineWiki 한국 위키']);
  const query = buildWikiSearchBooleanQuery('minewiki');

  assert.equal(query.split(' ').length, 6);
  assert.equal(query.split(' ').every((term) => term.startsWith('+mw')), true);
  assert.equal(vector.includes('minewiki'), false);
  assert.equal(buildWikiSearchBooleanQuery('ＭＩＮＥ'), buildWikiSearchBooleanQuery('mine'));
});

test('punctuation-only queries do not produce a search expression', () => {
  assert.equal(buildWikiSearchBooleanQuery('--- !!!'), '');
});
