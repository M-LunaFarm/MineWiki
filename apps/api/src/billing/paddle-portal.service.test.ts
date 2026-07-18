import assert from 'node:assert/strict';
import test from 'node:test';
import { PaddlePortalService } from './paddle-portal.service';

test('portal availability exposes only whether a manageable Paddle customer exists', async () => {
  let where: unknown;
  const service = new PaddlePortalService({
    paddleSubscriptionShadow: {
      async findFirst(input: { where: unknown }) {
        where = input.where;
        return { id: 9n };
      },
    },
  } as never, config('live') as never, {} as never);

  assert.equal(await service.isAvailable('11111111-1111-4111-8111-111111111111'), true);
  assert.deepEqual(where, {
    billingSubject: { serverWiki: { voteServerId: '11111111-1111-4111-8111-111111111111' } },
    providerCustomerId: { not: null },
  });
});

test('portal availability stays false without a provider customer', async () => {
  const service = new PaddlePortalService({
    paddleSubscriptionShadow: { async findFirst() { return null; } },
  } as never, config('live') as never, {} as never);
  assert.equal(await service.isAvailable('11111111-1111-4111-8111-111111111111'), false);
});

test('portal creation selects the newest shadow with a provider customer', async () => {
  let subscriptionWhere: unknown;
  const paddle = {
    async createPortalSession(customerId: string, subscriptionId: string) {
      assert.equal(customerId, 'ctm_test');
      assert.equal(subscriptionId, 'sub_test');
      return { overviewUrl: 'https://customer-portal.paddle.com/cpl_test?token=secret' };
    },
  };
  const service = new PaddlePortalService({
    paddleBillingSubject: { async findFirst() { return { id: 'subject-id' }; } },
    paddleSubscriptionShadow: {
      async findFirst(input: { where: unknown }) {
        subscriptionWhere = input.where;
        return { providerCustomerId: 'ctm_test', providerSubscriptionId: 'sub_test' };
      },
    },
  } as never, config('live') as never, paddle as never);

  assert.deepEqual(await service.create('11111111-1111-4111-8111-111111111111'), {
    portalUrl: 'https://customer-portal.paddle.com/cpl_test?token=secret',
  });
  assert.deepEqual(subscriptionWhere, {
    billingSubjectId: 'subject-id',
    providerCustomerId: { not: null },
  });
});

function config(mode: string) {
  return { get(key: string, fallback?: string) { return key === 'PADDLE_MODE' ? mode : fallback ?? ''; } };
}
