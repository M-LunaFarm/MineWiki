import test from 'node:test';
import assert from 'node:assert/strict';
import { PaddleCheckoutService } from './paddle-checkout.service';

test('checkout persists an immutable intent before calling Paddle and attaches its transaction', async () => {
  const operations: string[] = [];
  let intent: Record<string, unknown> | null = null;
  const prisma = {
    serverWiki: { async findUnique() { return { id: 9n }; } },
    paddleBillingSubject: {
      async upsert() { operations.push('subject'); return { id: 'subject-id' }; },
    },
    paddleSubscriptionShadow: { async findFirst() { return null; } },
    paddleCheckoutIntent: {
      async create({ data }: { data: Record<string, unknown> }) { operations.push('intent'); intent = data; return data; },
      async update({ data }: { data: Record<string, unknown> }) { operations.push('attach'); intent = { ...intent, ...data }; },
    },
  };
  const paddle = {
    async createTransaction(input: { checkoutIntentId: string }) {
      operations.push('provider');
      assert.equal(input.checkoutIntentId, intent?.id);
      return { transactionId: 'txn_test', checkoutUrl: 'https://checkout.paddle.com/test' };
    },
  };
  const service = new PaddleCheckoutService(
    prisma as never,
    config('live') as never,
    {
      getProviderPriceId() { return 'pri_handbook'; },
      getProduct() { return { productCode: 'server_wiki_handbook', layoutKey: 'handbook', displayName: 'Handbook', serviceScope: 'recurring_server_wiki_layout' }; },
    } as never,
    paddle as never,
  );
  const result = await service.create('11111111-1111-4111-8111-111111111111', 'handbook', 'account-id', '2026-07-19-v2.0');
  assert.deepEqual(operations, ['subject', 'intent', 'provider', 'attach']);
  assert.equal(intent?.configuredPriceId, 'pri_handbook');
  assert.equal(intent?.policyVersion, '2026-07-19-v2.0');
  assert.equal(intent?.termsAcceptedAt instanceof Date, true);
  assert.deepEqual(intent?.productSnapshot, {
    productCode: 'server_wiki_handbook', layoutKey: 'handbook', displayName: 'Handbook', serviceScope: 'recurring_server_wiki_layout',
  });
  assert.equal(intent?.providerTransactionId, 'txn_test');
  assert.deepEqual(result, {
    checkoutUrl: 'https://checkout.paddle.com/test',
    transactionId: 'txn_test',
  });
});

test('checkout is unavailable without live mode and never touches persistence', async () => {
  const service = new PaddleCheckoutService(
    { serverWiki: { async findUnique() { throw new Error('must not run'); } } } as never,
    config('shadow') as never,
    {} as never,
    {} as never,
  );
  await assert.rejects(
    () => service.create('11111111-1111-4111-8111-111111111111', 'brand', 'account-id', '2026-07-19-v2.0'),
    /not enabled/,
  );
});

test('checkout rejects stale policy consent before persistence or provider access', async () => {
  let persistenceTouched = false;
  const service = new PaddleCheckoutService(
    { serverWiki: { async findUnique() { persistenceTouched = true; } } } as never,
    config('live') as never,
    {} as never,
    {} as never,
  );
  await assert.rejects(
    () => service.create('11111111-1111-4111-8111-111111111111', 'handbook', 'account-id', '2026-02-17-v1.0'),
    /billing policy changed/i,
  );
  assert.equal(persistenceTouched, false);
});

function config(mode: string) {
  const values: Record<string, string> = {
    PADDLE_MODE: mode,
    PADDLE_ENV: 'sandbox',
    PADDLE_CHECKOUT_URL: 'https://minewiki.kr/billing/checkout',
  };
  return { get(key: string, fallback?: string) { return values[key] ?? fallback ?? ''; } };
}
