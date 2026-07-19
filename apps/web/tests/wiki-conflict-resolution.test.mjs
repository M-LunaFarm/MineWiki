import assert from 'node:assert/strict';
import test from 'node:test';
import {
  parseWikiConflictDocument,
  resolveAllWikiConflicts,
  resolveWikiConflict,
} from '../lib/wiki-conflict-resolution.mjs';

const source = [
  'before',
  '<<<<<<< 내 편집',
  'local one',
  '||||||| 기준 판',
  'base one',
  '=======',
  'current one',
  '>>>>>>> 최신 판',
  'middle',
  '<<<<<<< 내 편집',
  'same',
  '||||||| 기준 판',
  'old',
  '=======',
  'same',
  '>>>>>>> 최신 판',
  'after',
].join('\n');

test('parses every diff3 conflict source without dropping surrounding text', () => {
  const conflicts = parseWikiConflictDocument(source);
  assert.equal(conflicts.length, 2);
  assert.deepEqual(conflicts[0], {
    index: 0, startLine: 1, endLine: 7,
    local: 'local one', base: 'base one', current: 'current one',
  });
});

test('resolves one conflict while preserving the remaining marker block', () => {
  const resolved = resolveWikiConflict(source, 0, 'current');
  assert.match(resolved, /^before\ncurrent one\nmiddle$/m);
  assert.equal(parseWikiConflictDocument(resolved).length, 1);
});

test('both keeps distinct local and current sources but de-duplicates equal content', () => {
  const resolved = resolveAllWikiConflicts(source, 'both');
  assert.equal(resolved, ['before', 'local one', 'current one', 'middle', 'same', 'after'].join('\n'));
});

test('malformed markers are not partially rewritten', () => {
  const malformed = '<<<<<<< 내 편집\nlocal\n=======\ncurrent';
  assert.deepEqual(parseWikiConflictDocument(malformed), []);
  assert.equal(resolveWikiConflict(malformed, 0, 'local'), malformed);
});
