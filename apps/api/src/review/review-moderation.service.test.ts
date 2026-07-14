import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException, InternalServerErrorException } from '@nestjs/common';
import { ReviewModerationService } from './review-moderation.service';

const reportId = '11111111-1111-4111-8111-111111111111';
const reviewId = '22222222-2222-4222-8222-222222222222';
const serverId = '33333333-3333-4333-8333-333333333333';
const actorId = '44444444-4444-4444-8444-444444444444';

test('resolving and hiding a public review decrements its public counter atomically', async () => {
  const operations: string[] = [];
  const audits: unknown[] = [];
  const prisma = moderationPrisma(operations, 1);
  const service = new ReviewModerationService(
    prisma as never,
    {} as never,
    { async audit(...args: unknown[]) { audits.push(args); } } as never,
  );

  const result = await service.resolve(reportId, actorId, 'resolved', {
    resolution: '광고성 콘텐츠 확인',
    hideReview: true,
  });

  assert.deepEqual(operations, ['report:resolved', 'review:staff', 'server:decrement']);
  assert.equal(result.status, 'resolved');
  assert.equal(result.review.visibility, 'staff');
  assert.equal(audits.length, 1);
});

test('counter drift aborts report resolution instead of hiding without reconciliation', async () => {
  const operations: string[] = [];
  const service = new ReviewModerationService(
    moderationPrisma(operations, 0) as never,
    {} as never,
    { async audit() {} } as never,
  );

  await assert.rejects(
    () => service.resolve(reportId, actorId, 'resolved', {
      resolution: '정책 위반 확인',
      hideReview: true,
    }),
    (error: unknown) => error instanceof InternalServerErrorException,
  );
  assert.equal(operations.includes('report:resolved'), false);
});

test('a concurrent moderation winner prevents stale resolution from overwriting it', async () => {
  const operations: string[] = [];
  const service = new ReviewModerationService(
    moderationPrisma(operations, 1, 0) as never,
    {} as never,
    { async audit() {} } as never,
  );

  await assert.rejects(
    () => service.resolve(reportId, actorId, 'dismissed', {
      resolution: '중복 처리',
      hideReview: false,
    }),
    (error: unknown) => error instanceof ConflictException,
  );
  assert.deepEqual(operations, []);
});

test('already hidden review is not decremented a second time', async () => {
  const operations: string[] = [];
  const service = new ReviewModerationService(
    moderationPrisma(operations, 1, 1, 0) as never,
    {} as never,
    { async audit() {} } as never,
  );

  const result = await service.resolve(reportId, actorId, 'resolved', {
    resolution: '다른 신고에서 이미 숨김',
    hideReview: true,
  });
  assert.equal(result.status, 'resolved');
  assert.deepEqual(operations, ['report:resolved']);
});

function moderationPrisma(
  operations: string[],
  counterCount: number,
  claimCount = 1,
  hiddenCount = 1,
) {
  const now = new Date('2026-07-15T00:00:00.000Z');
  const report = {
    id: reportId,
    reviewId,
    accountId: '55555555-5555-4555-8555-555555555555',
    reason: '광고 신고',
    status: 'open',
    assigneeAccountId: null,
    resolution: null,
    assignedAt: null,
    statusUpdatedAt: now,
    resolvedAt: null,
    dismissedAt: null,
    createdAt: now,
    updatedAt: now,
    review: {
      id: reviewId,
      serverId,
      authorDisplayName: '작성자',
      body: '신고 대상 리뷰',
      visibility: 'public',
      reports: 1,
      createdAt: now,
      server: { id: serverId, name: '테스트 서버' },
    },
    reporter: { id: '55555555-5555-4555-8555-555555555555', displayName: '신고자', email: null },
    assignee: null,
  };
  return {
    async $transaction(callback: (transaction: ReturnType<typeof transaction>) => unknown) {
      const pending: string[] = [];
      const tx = transaction(pending);
      const result = await callback(tx);
      operations.push(...pending);
      return result;
    },
  };

  function transaction(pending: string[]) {
    let findCount = 0;
    let finalStatus = 'open';
    return {
      reviewReport: {
        async findUnique() {
          findCount += 1;
          if (findCount === 1) {
            return {
              ...report,
              review: { id: reviewId, serverId, visibility: 'public' },
            };
          }
          return {
            ...report,
            status: finalStatus,
            resolution: '광고성 콘텐츠 확인',
            assigneeAccountId: actorId,
            assignee: { id: actorId, displayName: '운영자', email: null },
            review: {
              ...report.review,
              visibility: hiddenCount === 1 ? 'staff' : report.review.visibility,
            },
          };
        },
        async updateMany(input: { data: { status: string } }) {
          finalStatus = input.data.status;
          pending.push(`report:${input.data.status}`);
          return { count: claimCount };
        },
      },
      serverReview: {
        async updateMany() {
          if (hiddenCount === 1) pending.push('review:staff');
          return { count: hiddenCount };
        },
      },
      server: {
        async updateMany() {
          pending.push('server:decrement');
          return { count: counterCount };
        },
      },
    };
  }
}
