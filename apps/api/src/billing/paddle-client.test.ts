import test from 'node:test';
import assert from 'node:assert/strict';
import { PaddleClient } from './paddle-client';

test('Paddle client sends only the opaque checkout intent and validates checkout output', async (t) => {
  const original = globalThis.fetch;
  let requestBody: Record<string, unknown> | null = null;
  globalThis.fetch = (async (_url: string | URL | Request, init?: RequestInit) => {
    requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
    return new Response(JSON.stringify({
      data: {
        id: 'txn_01h00000000000000000000000',
        checkout: { url: 'https://checkout.paddle.com/pay/test' },
      },
    }), { status: 201, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = original; });

  const client = new PaddleClient(config({ PADDLE_MODE: 'live', PADDLE_ENV: 'sandbox', PADDLE_API_KEY: 'secret' }) as never);
  const result = await client.createTransaction({
    priceId: 'pri_01h00000000000000000000000',
    checkoutIntentId: '11111111-1111-4111-8111-111111111111',
    checkoutUrl: 'https://minewiki.kr/billing/checkout',
  });
  assert.equal(result.transactionId, 'txn_01h00000000000000000000000');
  assert.equal(result.checkoutUrl, 'https://checkout.paddle.com/pay/test');
  assert.deepEqual(requestBody?.custom_data, {
    minewiki_checkout_intent_id: '11111111-1111-4111-8111-111111111111',
  });
  assert.equal(JSON.stringify(requestBody).includes('serverWiki'), false);
});

test('Paddle client is fail-closed outside live mode', async () => {
  const client = new PaddleClient(config({ PADDLE_MODE: 'shadow' }) as never);
  await assert.rejects(
    () => client.createTransaction({ priceId: 'pri_test', checkoutIntentId: 'intent', checkoutUrl: 'https://minewiki.kr' }),
    /not enabled/,
  );
});

function config(values: Record<string, string>) {
  return { get(key: string, fallback?: string) { return values[key] ?? fallback ?? ''; } };
}
