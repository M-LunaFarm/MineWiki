import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ReviewController } from './review.controller';

const serverId = '11111111-1111-4111-8111-111111111111';
const reviewId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';

test('review reports require a bounded reason and preserve the review response contract', async () => {
  const calls: unknown[] = [];
  const response = { id: reviewId, reports: 1 };
  const controller = new ReviewController(
    {
      async report(...args: unknown[]) {
        calls.push(args);
        return response;
      },
    } as never,
    {} as never,
    {} as never,
  );
  const session = {
    sessionId: '44444444-4444-4444-8444-444444444444',
    userId: accountId,
    isElevated: false,
    authenticatedAt: new Date().toISOString(),
  };

  await assert.rejects(() => controller.report(serverId, reviewId, session, {}));
  await assert.rejects(() =>
    controller.report(serverId, reviewId, session, { reason: 'x'.repeat(501) }),
  );
  const result = await controller.report(serverId, reviewId, session, { reason: '  스팸 광고  ' });

  assert.equal(result, response);
  assert.deepEqual(calls, [[serverId, reviewId, accountId, '스팸 광고']]);
});

test('review reply accepts only a strict bounded body after owner authorization', async () => {
  const calls: unknown[] = [];
  const response = { id: reviewId, adminReply: null };
  const controller = new ReviewController(
    {
      async setAdminReply(...args: unknown[]) {
        calls.push(args);
        return response;
      },
    } as never,
    {} as never,
    { isOwner: async () => true } as never,
  );
  const session = {
    sessionId: '44444444-4444-4444-8444-444444444444',
    userId: accountId,
    isElevated: false,
    authenticatedAt: new Date().toISOString(),
  };

  await assert.rejects(() =>
    controller.reply(serverId, reviewId, { body: 'x'.repeat(301) }, session),
  );
  await assert.rejects(() =>
    controller.reply(serverId, reviewId, { body: '답변', extra: true }, session),
  );
  const result = await controller.reply(serverId, reviewId, { body: '  확인했습니다.  ' }, session);

  assert.equal(result, response);
  assert.deepEqual(calls, [[serverId, reviewId, '운영진', '확인했습니다.', accountId]]);
});

test('authenticated authors can load their own review receipts', async () => {
  const calls: unknown[] = [];
  const controller = new ReviewController(
    {
      async listMine(...args: unknown[]) {
        calls.push(args);
        return [];
      },
    } as never,
    {} as never,
    {} as never,
  );
  const session = {
    sessionId: '44444444-4444-4444-8444-444444444444',
    userId: accountId,
    isElevated: false,
    authenticatedAt: new Date().toISOString(),
  };

  assert.deepEqual(await controller.listMine(serverId, session), []);
  assert.deepEqual(calls, [[serverId, accountId]]);
});
