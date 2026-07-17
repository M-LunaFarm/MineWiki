import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { serverReviewPageSchema } from '@minewiki/schemas';
import { Prisma } from '@prisma/client';
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
  const isolationLevels: string[] = [];
  const rows = [
    review('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 5, '2026-07-15T00:03:00.000Z'),
    review('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 5, '2026-07-15T00:02:00.000Z'),
    review('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 4, '2026-07-15T00:01:00.000Z'),
  ];
  const serverReview = {
    async findMany(args: Record<string, unknown>) {
      calls.push(args);
      return calls.length === 1 ? rows : [rows[2]];
    },
    async groupBy() {
      return [
        { rating: 4, _count: { _all: 1 } },
        { rating: 5, _count: { _all: 2 } },
      ];
    },
  };
  const prisma = {
    async $transaction<T>(
      callback: (transaction: { serverReview: typeof serverReview }) => Promise<T>,
      options: { isolationLevel: string },
    ) {
      isolationLevels.push(options.isolationLevel);
      return callback({ serverReview });
    },
    serverReview,
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
  assert.deepEqual(first.aggregate, {
    total: 3,
    average: 14 / 3,
    histogram: { '1': 0, '2': 0, '3': 0, '4': 1, '5': 2 },
  });
  assert.deepEqual(isolationLevels, [Prisma.TransactionIsolationLevel.RepeatableRead]);
  assert.deepEqual(serverReviewPageSchema.parse(first), first);
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

test('review aggregate covers every snapshot-visible public review regardless of page filters', async () => {
  const pageQueries: Array<Record<string, unknown>> = [];
  const aggregateQueries: Array<Record<string, unknown>> = [];
  const row = review(
    'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    5,
    '2026-07-15T00:03:00.000Z',
  );
  const serverReview = {
    async findMany(args: Record<string, unknown>) {
      pageQueries.push(args);
      return [row];
    },
    async groupBy(args: Record<string, unknown>) {
      aggregateQueries.push(args);
      return [
        { rating: 1, _count: { _all: 1 } },
        { rating: 3, _count: { _all: 2 } },
        { rating: 5, _count: { _all: 1 } },
      ];
    },
  };
  const prisma = {
    async $transaction<T>(callback: (transaction: { serverReview: typeof serverReview }) => Promise<T>) {
      return callback({ serverReview });
    },
    serverReview,
  };
  const service = new ReviewService(
    { async ensureExists() {} } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
  );

  const result = await service.listPage(serverId, {
    limit: 1,
    rating: 5,
    tag: 'community',
    sort: 'newest',
  });

  assert.deepEqual(result.aggregate, {
    total: 4,
    average: 3,
    histogram: { '1': 1, '2': 0, '3': 2, '4': 0, '5': 1 },
  });
  const pageWhere = pageQueries[0]?.where as Record<string, unknown>;
  const aggregateWhere = aggregateQueries[0]?.where as Record<string, unknown>;
  assert.equal(pageWhere.rating, 5);
  assert.deepEqual(pageWhere.tags, { array_contains: ['community'] });
  assert.deepEqual(aggregateWhere, {
    serverId,
    visibility: 'public',
    createdAt: pageWhere.createdAt,
    updatedAt: pageWhere.updatedAt,
  });
  assert.deepEqual(aggregateQueries[0]?.by, ['rating']);
  assert.deepEqual(aggregateQueries[0]?._count, { _all: true });
});

test('review aggregate uses null average and zeroed stars when no public reviews are visible', async () => {
  const serverReview = {
    async findMany() { return []; },
    async groupBy() { return []; },
  };
  const service = new ReviewService(
    { async ensureExists() {} } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
    {
      async $transaction<T>(
        callback: (transaction: { serverReview: typeof serverReview }) => Promise<T>,
      ) {
        return callback({ serverReview });
      },
      serverReview,
    } as never,
  );

  const result = await service.listPage(serverId);

  assert.deepEqual(result.aggregate, {
    total: 0,
    average: null,
    histogram: { '1': 0, '2': 0, '3': 0, '4': 0, '5': 0 },
  });
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
