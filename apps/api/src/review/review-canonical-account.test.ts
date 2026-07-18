import assert from 'node:assert/strict';
import test from 'node:test';
import { ReviewService } from './review.service';
import type { PrismaService } from '../common/prisma.service';

test('a linked account can manage a review owned by its canonical account', async () => {
  const canonicalAccountId = '11111111-1111-4111-8111-111111111111';
  const linkedAccountId = '22222222-2222-4222-8222-222222222222';
  const serverId = '33333333-3333-4333-8333-333333333333';
  const review = {
    id: '44444444-4444-4444-8444-444444444444',
    serverId,
    authorAccountId: canonicalAccountId,
    authorDisplayName: '연결 사용자',
    rating: 4,
    body: '연결 전 작성한 리뷰',
    tags: ['community'],
    helpfulCount: 0,
    reports: 0,
    visibility: 'public' as const,
    isAnonymous: false,
    adminReplyBody: null,
    adminReplyAuthor: null,
    adminReplyCreatedAt: null,
    createdAt: new Date('2026-07-17T00:00:00.000Z'),
    updatedAt: new Date('2026-07-17T00:00:00.000Z'),
    evidenceMinecraftUuid: null,
    evidenceVoteId: null,
    evidenceVerifiedAt: null,
    evidencePolicyVersion: null,
  };
  const accounts = [
    { id: canonicalAccountId, canonicalAccountId },
    { id: linkedAccountId, canonicalAccountId },
  ];
  const transaction = {
    account: {
      findUnique: async ({ where }: { where: { id: string } }) =>
        accounts.find((account) => account.id === where.id) ?? null,
      findMany: async () => accounts,
    },
    accountLink: { findMany: async () => [] },
    $queryRaw: async () => accounts.map(({ id }) => ({ id })),
    serverReview: {
      findMany: async () => [review],
      findFirst: async () => review,
      update: async ({ data }: { data: { rating: number; body: string; tags: string[] } }) =>
        Object.assign(review, data),
    },
  };
  const prisma = {
    $transaction: async (callback: (tx: typeof transaction) => Promise<unknown>) => callback(transaction),
    serverReview: transaction.serverReview,
    reviewHelpfulVote: { findMany: async () => [] },
  } as unknown as PrismaService;
  const service = new ReviewService(
    { ensureExists: async () => undefined } as never,
    { track: async () => undefined, audit: async () => undefined } as never,
    {} as never,
    {} as never,
    {} as never,
    prisma,
  );

  const listed = await service.list(serverId, {}, linkedAccountId);
  assert.equal(listed[0]?.canManage, true);

  const updated = await service.update(
    serverId,
    review.id,
    { rating: 5, body: '연결 뒤 수정한 리뷰', tags: ['community'] },
    { sessionId: 'session', userId: linkedAccountId, isElevated: false },
  );
  assert.equal(updated.rating, 5);
  assert.equal(updated.canManage, true);
});
