import assert from 'node:assert/strict';
import test from 'node:test';
import { triggerBillingEntitlementSweep } from './billing-entitlement-scheduler';

test('billing entitlement scheduler calls only the protected reconciliation endpoint', async () => {
  let receivedUrl = '';
  let receivedAuth = '';
  const result = await triggerBillingEntitlementSweep({
    apiBaseUrl: 'http://api:3000/',
    internalToken: 'billing-secret',
    fetchImpl: async (url, init) => {
      receivedUrl = String(url);
      receivedAuth = new Headers(init?.headers).get('authorization') ?? '';
      return new Response(JSON.stringify({ examined: 2, expired: 2, downgraded: 1, skipped: 0, failed: 0 }), { status: 200 });
    },
  });

  assert.equal(receivedUrl, 'http://api:3000/v1/internal/billing/reconcile-entitlements');
  assert.equal(receivedAuth, 'Bearer billing-secret');
  assert.deepEqual(result, { examined: 2, expired: 2, downgraded: 1, skipped: 0, failed: 0 });
});

test('billing entitlement scheduler treats a non-success response as a failed sweep', async () => {
  await assert.rejects(
    () => triggerBillingEntitlementSweep({
      apiBaseUrl: 'http://api:3000',
      internalToken: 'billing-secret',
      fetchImpl: async () => new Response('unauthorized', { status: 401 }),
    }),
    /HTTP 401/u,
  );
});
