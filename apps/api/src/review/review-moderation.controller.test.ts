import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { ReviewModerationController } from './review-moderation.controller';

const reportId = '11111111-1111-4111-8111-111111111111';
const accountId = '22222222-2222-4222-8222-222222222222';

test('review moderation queue requires review.moderate access', () => {
  const controller = new ReviewModerationController({} as never);
  assert.throws(
    () => controller.list({ ...session(), isElevated: true }),
    (error: unknown) => error instanceof ForbiddenException,
  );
});

test('review moderation queue normalizes pagination and assignee filters', async () => {
  let captured: unknown;
  const controller = new ReviewModerationController({
    async listReports(query: unknown) {
      captured = query;
      return { items: [], total: 0, page: 2, pageSize: 25, totalPages: 0 };
    },
  } as never);

  await controller.list(
    session(['review.moderate']),
    'in_review',
    undefined,
    'me',
    ' spam ',
    '2',
    '25',
  );

  assert.deepEqual(captured, {
    status: 'in_review',
    serverId: undefined,
    assigneeAccountId: accountId,
    search: 'spam',
    page: 2,
    pageSize: 25,
  });
});

test('review moderation resolution requires bounded text', async () => {
  const calls: unknown[] = [];
  const controller = new ReviewModerationController({
    async resolve(...args: unknown[]) {
      calls.push(args);
      return {};
    },
  } as never);

  assert.throws(() =>
    controller.resolve(reportId, session(['review.moderate']), { resolution: 'x' }),
  );
  await controller.resolve(reportId, session(['review.moderate']), {
    resolution: '정책 위반 확인',
    hideReview: true,
  });
  assert.deepEqual(calls[0], [
    reportId,
    accountId,
    'resolved',
    { resolution: '정책 위반 확인', hideReview: true },
  ]);
});

function session(permissions: string[] = []) {
  return {
    sessionId: '33333333-3333-4333-8333-333333333333',
    userId: accountId,
    isElevated: false,
    authenticatedAt: new Date().toISOString(),
    permissions,
    groups: [],
  };
}
