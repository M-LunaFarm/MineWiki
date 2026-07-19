import test from 'node:test';
import assert from 'node:assert/strict';
import { triggerPaddleWebhookInboxSweep } from './paddle-webhook-inbox';

test('Paddle inbox scheduler authenticates the internal sweep without exposing its token in the URL', async () => {
  let requestedUrl = '';
  let authorization = '';
  const result = await triggerPaddleWebhookInboxSweep({
    apiBaseUrl: 'http://api:3000/',
    internalToken: 'derived-secret',
    fetchImpl: async (input, init) => {
      requestedUrl = String(input);
      authorization = String((init?.headers as Record<string, string>).authorization);
      return new Response(JSON.stringify({ examined: 1, processed: 1, ignored: 0, stale: 0, quarantined: 0, retried: 0, deadLettered: 0, skipped: 0 }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  assert.equal(requestedUrl, 'http://api:3000/v1/internal/billing/paddle/process-due');
  assert.equal(authorization, 'Bearer derived-secret');
  assert.equal(requestedUrl.includes('derived-secret'), false);
  assert.equal(result.processed, 1);
});

test('Paddle inbox scheduler surfaces API failures for the run-loop retry policy', async () => {
  await assert.rejects(
    () => triggerPaddleWebhookInboxSweep({
      apiBaseUrl: 'http://api:3000',
      internalToken: 'derived-secret',
      fetchImpl: async () => new Response('', { status: 503 }),
    }),
    /HTTP 503/u,
  );
});
