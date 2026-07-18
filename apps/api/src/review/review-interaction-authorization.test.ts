import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { ReviewService } from './review.service';

const serverId = '11111111-1111-4111-8111-111111111111';
const reviewId = '22222222-2222-4222-8222-222222222222';
const authorId = '33333333-3333-4333-8333-333333333333';
const outsiderId = '44444444-4444-4444-8444-444444444444';

function createService(options: {
  readonly actorId: string;
  readonly authorAccountId: string;
  readonly visibility: 'public' | 'staff';
}) {
  let rawQueryCount = 0;
  const account = { id: options.actorId, canonicalAccountId: null };
  const review = {
    id: reviewId,
    serverId,
    authorAccountId: options.authorAccountId,
    visibility: options.visibility,
  };
  const transaction = {
    account: {
      findUnique: async () => account,
      findMany: async () => [account],
    },
    accountLink: { findMany: async () => [] },
    $queryRaw: async () => {
      rawQueryCount += 1;
      if (rawQueryCount === 1) return [{ id: options.actorId }];
      return options.visibility === 'public'
        ? [{ id: reviewId, authorAccountId: options.authorAccountId }]
        : [];
    },
    serverReview: {
      findFirst: async ({ where }: { where: { visibility?: string } }) =>
        where.visibility === 'public' && options.visibility !== 'public' ? null : review,
    },
    reviewReport: {
      findFirst: async () => null,
      create: async () => {
        throw new Error('report persistence must not be reached');
      },
    },
    reviewHelpfulVote: {
      findFirst: async () => null,
      create: async () => {
        throw new Error('helpful persistence must not be reached');
      },
    },
  };
  const prisma = {
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
  };
  return new ReviewService(
    {} as never,
    { audit: async () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    prisma as never,
  );
}

test('staff-only review interaction ids stay concealed from unrelated accounts', async () => {
  const reportService = createService({
    actorId: outsiderId,
    authorAccountId: authorId,
    visibility: 'staff',
  });
  const helpfulService = createService({
    actorId: outsiderId,
    authorAccountId: authorId,
    visibility: 'staff',
  });

  await assert.rejects(
    () => reportService.report(serverId, reviewId, outsiderId, '비공개 리뷰 신고'),
    NotFoundException,
  );
  await assert.rejects(
    () => helpfulService.markHelpful(serverId, reviewId, outsiderId, true),
    NotFoundException,
  );
});

test('public review authors cannot report or endorse their own review', async () => {
  const reportService = createService({
    actorId: authorId,
    authorAccountId: authorId,
    visibility: 'public',
  });
  const helpfulService = createService({
    actorId: authorId,
    authorAccountId: authorId,
    visibility: 'public',
  });

  await assert.rejects(
    () => reportService.report(serverId, reviewId, authorId, '내 리뷰 신고'),
    ForbiddenException,
  );
  await assert.rejects(
    () => helpfulService.markHelpful(serverId, reviewId, authorId, true),
    ForbiddenException,
  );
});
