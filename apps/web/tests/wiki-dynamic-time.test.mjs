import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatWikiDynamicTime } from '../lib/wiki-dynamic-time.mjs';

test('formats cached datetime markers as a live Asia/Seoul timestamp', () => {
  const now = new Date('2026-07-16T05:30:45.000Z');
  assert.deepEqual(formatWikiDynamicTime('datetime', undefined, now), {
    text: '2026-07-16 14:30:45',
    dateTime: '2026-07-16T05:30:45.000Z',
  });
});

test('calculates age against the Korean calendar date and rejects future birthdays', () => {
  const beforeBirthday = new Date('2026-07-16T05:30:45.000Z');
  const onBirthday = new Date('2026-07-17T03:00:00.000Z');

  assert.equal(formatWikiDynamicTime('age', '2000-07-17', beforeBirthday)?.text, '25');
  assert.equal(formatWikiDynamicTime('age', '2000-07-17', onBirthday)?.text, '26');
  assert.equal(formatWikiDynamicTime('age', '2030-01-01', beforeBirthday)?.text, 'invalid date');
  assert.equal(formatWikiDynamicTime('age', '2023-02-29', beforeBirthday), null);
});

test('calculates dday with thetree-compatible signs across Korean calendar days', () => {
  const now = new Date('2026-07-16T05:30:45.000Z');

  assert.equal(formatWikiDynamicTime('dday', '2026-07-15', now)?.text, '+1');
  assert.equal(formatWikiDynamicTime('dday', '2026-07-16', now)?.text, '-0');
  assert.equal(formatWikiDynamicTime('dday', '2026-07-17', now)?.text, '-1');
  assert.equal(formatWikiDynamicTime('dday', '2024-02-30', now), null);
});

test('ignores unknown marker modes and invalid clocks', () => {
  assert.equal(formatWikiDynamicTime('unknown', '2026-07-16', new Date()), null);
  assert.equal(formatWikiDynamicTime('datetime', undefined, new Date('invalid')), null);
});
