import assert from 'node:assert/strict';
import test from 'node:test';
import { hasWikiConflictMarkers, mergeWikiSource, WikiMergeLimitError } from './wiki-merge';

test('three-way merge combines independent wiki edits without markers', () => {
  const base = '== 소개 ==\n기준\n\n== 접속 ==\nold.example.kr\n';
  const local = '== 소개 ==\n내가 고친 소개\n\n== 접속 ==\nold.example.kr\n';
  const current = '== 소개 ==\n기준\n\n== 접속 ==\nplay.example.kr\n';

  const merged = mergeWikiSource(local, base, current);

  assert.equal(merged.hasConflicts, false);
  assert.equal(merged.conflictCount, 0);
  assert.match(merged.contentRaw, /내가 고친 소개/);
  assert.match(merged.contentRaw, /play\.example\.kr/);
  assert.equal(hasWikiConflictMarkers(merged.contentRaw), false);
  assert.equal(merged.contentRaw.endsWith('\n'), true);
});

test('three-way merge exposes overlapping edits with base context', () => {
  const merged = mergeWikiSource('내 문장', '기준 문장', '다른 문장');

  assert.equal(merged.hasConflicts, true);
  assert.equal(merged.conflictCount, 1);
  assert.match(merged.contentRaw, /^<<<<<<< 내 편집$/m);
  assert.match(merged.contentRaw, /^\|\|\|\|\|\|\| 기준 판$/m);
  assert.match(merged.contentRaw, /^>>>>>>> 최신 판$/m);
  assert.equal(hasWikiConflictMarkers(merged.contentRaw), true);
});

test('identical concurrent edits are treated as a clean false conflict', () => {
  const merged = mergeWikiSource('동일한 수정', '이전', '동일한 수정');

  assert.equal(merged.hasConflicts, false);
  assert.equal(merged.contentRaw, '동일한 수정');
});

test('three-way merge normalizes CRLF and rejects pathological line counts', () => {
  const merged = mergeWikiSource('a\r\nb\r\nlocal', 'a\r\nb\r\nbase', 'a\r\nb\r\nbase');
  assert.equal(merged.contentRaw, 'a\nb\nlocal');
  assert.throws(
    () => mergeWikiSource('x\n'.repeat(20_001), 'x', 'x'),
    WikiMergeLimitError
  );
  assert.throws(
    () => mergeWikiSource('x\r'.repeat(20_001), 'x', 'x'),
    WikiMergeLimitError
  );
});

test('three-way merge rejects a combined result beyond the source limit', () => {
  const base = 'start\nmiddle\nend';
  const local = `${'L'.repeat(700_000)}\n${base}`;
  const current = `${base}\n${'C'.repeat(700_000)}`;

  assert.throws(() => mergeWikiSource(local, base, current), WikiMergeLimitError);
});
