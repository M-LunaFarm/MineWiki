import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { ReviewFeedCursorCodec, type ReviewFeedCursorBinding } from './review-feed-cursor';

const binding: ReviewFeedCursorBinding = {
  scope: 'mine',
  serverId: '11111111-1111-4111-8111-111111111111',
  subject: '22222222-2222-4222-8222-222222222222',
  visibility: 'staff',
  sort: 'newest',
  ratingFilter: null,
  tagFilter: null,
};

function codec() {
  return new ReviewFeedCursorCodec({
    get(key: string) {
      assert.equal(key, 'APP_ENCRYPTION_KEY');
      return 'review-feed-cursor-test-key';
    },
  } as never);
}

test('review feed cursor round-trips and binds every feed dimension', () => {
  const position = {
    snapshotAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-17T23:59:00.000Z',
    id: '33333333-3333-4333-8333-333333333333',
    rating: 5,
  };
  const value = codec().encode(binding, position);
  assert.deepEqual(codec().decode(value, binding), position);

  for (const changed of [
    { ...binding, scope: 'staff' as const },
    { ...binding, serverId: '44444444-4444-4444-8444-444444444444' },
    { ...binding, subject: '55555555-5555-4555-8555-555555555555' },
    { ...binding, visibility: 'all' as const },
    { ...binding, sort: 'wilson' as const },
    { ...binding, ratingFilter: 5 },
    { ...binding, tagFilter: 'community' as const },
  ]) {
    assert.throws(() => codec().decode(value, changed), BadRequestException);
  }
});

test('review feed cursor rejects tampering and impossible dates', () => {
  const valid = codec().encode(binding, {
    snapshotAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-17T23:59:00.000Z',
    id: '33333333-3333-4333-8333-333333333333',
    rating: 4,
  });
  const [payload, signature] = valid.split('.') as [string, string];
  const replacement = payload.endsWith('a') ? 'b' : 'a';
  assert.throws(
    () => codec().decode(`${payload.slice(0, -1)}${replacement}.${signature}`, binding),
    BadRequestException,
  );
  assert.throws(() => codec().encode(binding, {
    snapshotAt: '2026-07-18T00:00:00.000Z',
    createdAt: '2026-07-18T00:01:00.000Z',
    id: '33333333-3333-4333-8333-333333333333',
    rating: 4,
  }), BadRequestException);
});
