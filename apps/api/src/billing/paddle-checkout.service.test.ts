import test from 'node:test';
import assert from 'node:assert/strict';
import { PaddleCheckoutService } from './paddle-checkout.service';

test('checkout persists an immutable intent before calling Paddle and attaches its transaction', async () => {
  const operations: string[] = [];
  let intent: Record<string, unknown> | null = null;
  const prisma = {
    server: { async findUnique() { return activeOwner(); } },
    serverWiki: { async findUnique() { return { id: 9n }; } },
    paddleBillingSubject: {
      async upsert() { operations.push('subject'); return { id: 'subject-id' }; },
    },
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    paddleSubscriptionShadow: { async findFirst() { return null; } },
    paddleCheckoutIntent: {
      async upsert({ create }: { create: Record<string, unknown> }) {
        operations.push('intent');
        intent = create;
        return { ...create, providerTransactionId: null, providerCheckoutUrl: null };
      },
      async updateMany({ data }: { data: Record<string, unknown> }) {
        operations.push('attach'); intent = { ...intent, ...data }; return { count: 1 };
      },
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
  assert.equal(intent?.providerCheckoutUrl, 'https://checkout.paddle.com/test');
  assert.equal(intent?.status, 'pending');
  assert.deepEqual(result, {
    checkoutUrl: 'https://checkout.paddle.com/test',
    transactionId: 'txn_test',
  });
});

test('concurrent checkout requests create one Paddle transaction and keep the open lease', async () => {
  let intent: Record<string, unknown> | null = null;
  let providerCalls = 0;
  let releaseProvider!: () => void;
  let markProviderStarted!: () => void;
  const providerStarted = new Promise<void>((resolve) => { markProviderStarted = resolve; });
  const providerRelease = new Promise<void>((resolve) => { releaseProvider = resolve; });
  const prisma = {
    server: { async findUnique() { return activeOwner(); } },
    serverWiki: { async findUnique() { return { id: 9n }; } },
    paddleBillingSubject: { async upsert() { return { id: 'subject-id' }; } },
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    paddleSubscriptionShadow: { async findFirst() { return null; } },
    paddleCheckoutIntent: {
      async upsert({ create }: { create: Record<string, unknown> }) {
        if (!intent) intent = create;
        return { ...intent, providerTransactionId: null, providerCheckoutUrl: null };
      },
      async updateMany({ data }: { data: Record<string, unknown> }) {
        intent = { ...intent, ...data }; return { count: 1 };
      },
    },
  };
  const service = new PaddleCheckoutService(
    prisma as never,
    config('live') as never,
    {
      getProviderPriceId() { return 'pri_handbook'; },
      getProduct() { return { productCode: 'server_wiki_handbook', layoutKey: 'handbook' }; },
    } as never,
    {
      async createTransaction() {
        providerCalls += 1;
        markProviderStarted();
        await providerRelease;
        return { transactionId: 'txn_once', checkoutUrl: 'https://checkout.paddle.com/once' };
      },
    } as never,
  );

  const first = service.create('server-id', 'handbook', 'account-id', '2026-07-19-v2.0');
  await providerStarted;
  await assert.rejects(
    () => service.create('server-id', 'handbook', 'account-id', '2026-07-19-v2.0'),
    /already open/i,
  );
  releaseProvider();
  assert.deepEqual(await first, {
    checkoutUrl: 'https://checkout.paddle.com/once',
    transactionId: 'txn_once',
  });
  assert.equal(providerCalls, 1);
  assert.equal(intent?.openLeaseKey, 'sandbox:subject-id');
});

test('checkout retry reuses the persisted Paddle transaction URL', async () => {
  let providerCalls = 0;
  const prisma = {
    server: { async findUnique() { return activeOwner(); } },
    serverWiki: { async findUnique() { return { id: 9n }; } },
    paddleBillingSubject: { async upsert() { return { id: 'subject-id' }; } },
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    paddleSubscriptionShadow: { async findFirst() { return null; } },
    paddleCheckoutIntent: {
      async upsert() {
        return {
          id: 'existing-intent', layoutKey: 'handbook', status: 'pending',
          providerTransactionId: 'txn_existing', providerCheckoutUrl: 'https://checkout.paddle.com/existing',
        };
      },
    },
  };
  const service = new PaddleCheckoutService(
    prisma as never,
    config('live') as never,
    {
      getProviderPriceId() { return 'pri_handbook'; },
      getProduct() { return { productCode: 'server_wiki_handbook', layoutKey: 'handbook' }; },
    } as never,
    { async createTransaction() { providerCalls += 1; throw new Error('must not run'); } } as never,
  );

  assert.deepEqual(
    await service.create('server-id', 'handbook', 'account-id', '2026-07-19-v2.0'),
    { checkoutUrl: 'https://checkout.paddle.com/existing', transactionId: 'txn_existing' },
  );
  assert.equal(providerCalls, 0);
});

test('checkout rechecks active ownership inside the intent transaction', async () => {
  let persisted = false;
  const prisma = {
    server: {
      async findUnique() {
        return { ownerAccountId: 'account-id', ownershipChallengeSuspendedAt: new Date() };
      },
    },
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    paddleBillingSubject: {
      async upsert() { persisted = true; throw new Error('must not persist'); },
    },
  };
  const service = new PaddleCheckoutService(
    prisma as never,
    config('live') as never,
    {
      getProviderPriceId() { return 'pri_handbook'; },
      getProduct() { return { productCode: 'server_wiki_handbook', layoutKey: 'handbook' }; },
    } as never,
    {} as never,
  );

  await assert.rejects(
    () => service.create('server-id', 'handbook', 'account-id', '2026-07-19-v2.0'),
    /active server owner/i,
  );
  assert.equal(persisted, false);
});

test('an uncertain provider failure keeps the lease and a retry cannot create a second transaction', async () => {
  let intent: Record<string, unknown> | null = null;
  let providerCalls = 0;
  const prisma = {
    server: { async findUnique() { return activeOwner(); } },
    serverWiki: { async findUnique() { return { id: 9n }; } },
    paddleBillingSubject: { async upsert() { return { id: 'subject-id' }; } },
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    paddleSubscriptionShadow: { async findFirst() { return null; } },
    paddleCheckoutIntent: {
      async upsert({ create }: { create: Record<string, unknown> }) {
        if (!intent) intent = create;
        return { ...intent, providerTransactionId: null, providerCheckoutUrl: null };
      },
    },
  };
  const service = new PaddleCheckoutService(
    prisma as never,
    config('live') as never,
    {
      getProviderPriceId() { return 'pri_handbook'; },
      getProduct() { return { productCode: 'server_wiki_handbook', layoutKey: 'handbook' }; },
    } as never,
    {
      async createTransaction() { providerCalls += 1; throw new Error('provider timeout'); },
    } as never,
  );

  await assert.rejects(
    () => service.create('server-id', 'handbook', 'account-id', '2026-07-19-v2.0'),
    /provider timeout/i,
  );
  await assert.rejects(
    () => service.create('server-id', 'handbook', 'account-id', '2026-07-19-v2.0'),
    /already open/i,
  );
  assert.equal(providerCalls, 1);
  assert.equal(intent?.status, 'creating');
  assert.equal(intent?.openLeaseKey, 'sandbox:subject-id');
});

test('an expired uncertain checkout reconciles before safely opening a replacement', async () => {
  const expired = {
    id: 'expired-intent', billingSubjectId: 'subject-id', environment: 'sandbox', layoutKey: 'handbook',
    status: 'creating', openLeaseKey: 'sandbox:subject-id', providerTransactionId: null,
    providerCheckoutUrl: null, expiresAt: new Date(Date.now() - 60_000),
    createdAt: new Date(Date.now() - 31 * 60_000),
  };
  let openIntent: Record<string, unknown> | null = expired;
  let providerCalls = 0;
  let reconciliationCalls = 0;
  const prisma = {
    server: { async findUnique() { return activeOwner(); } },
    serverWiki: { async findUnique() { return { id: 9n }; } },
    paddleBillingSubject: { async upsert() { return { id: 'subject-id' }; } },
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) { return callback(prisma); },
    paddleSubscriptionShadow: { async findFirst() { return null; } },
    paddleCheckoutIntent: {
      async upsert({ create }: { create: Record<string, unknown> }) {
        if (!openIntent) openIntent = create;
        return { ...openIntent };
      },
      async updateMany({ where, data }: { where: { id: string }; data: Record<string, unknown> }) {
        if (!openIntent || openIntent.id !== where.id) return { count: 0 };
        openIntent = { ...openIntent, ...data };
        if (data.openLeaseKey === null) openIntent = null;
        return { count: 1 };
      },
    },
  };
  const service = new PaddleCheckoutService(
    prisma as never,
    config('live') as never,
    {
      getProviderPriceId() { return 'pri_handbook'; },
      getProduct() { return { productCode: 'server_wiki_handbook', layoutKey: 'handbook' }; },
    } as never,
    {
      async findTransactionByCheckoutIntent() { reconciliationCalls += 1; return null; },
      async createTransaction() {
        providerCalls += 1;
        return { transactionId: 'txn_replacement', checkoutUrl: 'https://checkout.paddle.com/replacement' };
      },
    } as never,
  );

  assert.deepEqual(
    await service.create('server-id', 'handbook', 'account-id', '2026-07-19-v2.0'),
    { transactionId: 'txn_replacement', checkoutUrl: 'https://checkout.paddle.com/replacement' },
  );
  assert.equal(reconciliationCalls, 1);
  assert.equal(providerCalls, 1);
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

function activeOwner() {
  return { ownerAccountId: 'account-id', ownershipChallengeSuspendedAt: null };
}
