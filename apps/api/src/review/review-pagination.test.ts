import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { ReviewService } from './review.service';

const serverId = '11111111-1111-4111-8111-111111111111';

function review(id: string, rating: number, createdAt: string) {
  return {
    id,
    serverId,
    authorAccountId: '22222222-2222-4222-8222-222222222222',
    authorDisplayName: 'Reviewer',
    rating,
    body: `review-${rating}`,
    tags: ['community'],
    visibility: 'public' as const,
    isAnonymous: false,
    helpfulCount: 0,
    reports: 0,
    adminReplyBody: null,
    adminReplyAuthor: null,
    adminReplyCreatedAt: null,
    createdAt: new Date(createdAt),
    updatedAt: new Date(createdAt),
    evidenceMinecraftUuid: null,
    evidenceVoteId: null,
    evidenceVerifiedAt: null,
    evidencePolicyVersion: null,
  };
}

test('review pages use a stable rating/date/id cursor and bind it to filters', async () => {
  const calls: Array<Record<string, unknown>> = [];
  const rows = [
    review('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, '2026-07-15T00:03:00.000Z'),
    review('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 5, '2026-07-15T00:02:00.000Z'),
    review('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 4, '2026-07-15T00:01:00.000Z'),
  ];
  const prisma = {
    serverReview: {
      async findMany(args: Record<string, unknown>) {
        calls.push(args);
        return calls.length === 1 ? rows : [rows[2]];
      },
    },
  };
  const service = new ReviewService(
    { async ensureExists() {} } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
  );

  const first = await service.listPage(serverId, {
    limit: 2,
    sort: 'wilson',
    rating: undefined,
    tag: 'community',
  });
  assert.deepEqual(first.items.map((item) => item.id), rows.slice(0, 2).map((item) => item.id));
  assert.ok(first.nextCursor);
  assert.deepEqual(calls[0]?.orderBy, [
    { rating: 'desc' },
    { createdAt: 'desc' },
    { id: 'desc' },
  ]);
  assert.deepEqual((calls[0]?.where as { tags: unknown }).tags, { array_contains: ['community'] });
  assert.ok((calls[0]?.where as { updatedAt: { lte: Date } }).updatedAt.lte instanceof Date);

  const second = await service.listPage(serverId, {
    limit: 2,
    sort: 'wilson',
    tag: 'community',
    cursor: first.nextCursor,
  });
  assert.equal(second.items[0]?.id, rows[2]?.id);
  const continuation = (calls[1]?.where as { AND: { OR: unknown[] } }).AND.OR;
  assert.equal(continuation.length, 3);

  await assert.rejects(
    service.listPage(serverId, {
      limit: 2,
      sort: 'newest',
      tag: 'community',
      cursor: first.nextCursor,
    }),
    BadRequestException,
  );
  assert.equal(calls.length, 2, 'a mismatched cursor must fail before querying reviews');
});

test('malformed review cursors fail closed before database pagination', async () => {
  let queried = false;
  const service = new ReviewService(
    { async ensureExists() {} } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    { serverReview: { async findMany() { queried = true; return []; } } } as never,
  );
  await assert.rejects(
    service.listPage(serverId, { cursor: 'not-a-valid-cursor' }),
    BadRequestException,
  );
  assert.equal(queried, false);
});
