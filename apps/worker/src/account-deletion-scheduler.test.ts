import assert from 'node:assert/strict';
import test from 'node:test';
import { triggerAccountDeletionSweep } from './account-deletion-scheduler';

test('account deletion scheduler calls only the protected internal endpoint', async () => {
  let receivedUrl = ''; let receivedAuth = '';
  const result = await triggerAccountDeletionSweep({
    apiBaseUrl: 'http://api:3000/', internalToken: 'internal-secret',
    fetchImpl: async (url, init) => {
      receivedUrl = String(url); receivedAuth = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({ processed: 2, blocked: 1, failed: 0 }), { status: 200 });
    },
  });
  assert.equal(receivedUrl, 'http://api:3000/v1/internal/account-deletions/process-due');
  assert.equal(receivedAuth, 'Bearer internal-secret');
  assert.deepEqual(result, { processed: 2, blocked: 1, failed: 0 });
});

test('account deletion scheduler treats a non-success response as a failed sweep', async () => {
  await assert.rejects(
    () => triggerAccountDeletionSweep({
      apiBaseUrl: 'http://api:3000',
      internalToken: 'internal-secret',
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    }),
    /HTTP 401/,
  );
});
