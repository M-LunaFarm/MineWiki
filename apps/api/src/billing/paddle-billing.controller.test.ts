import assert from 'node:assert/strict';
import test from 'node:test';
import { PaddleBillingController } from './paddle-billing.controller';
import { BILLING_PRODUCTS } from '@minewiki/schemas/billing-contract';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';
const SESSION = { userId: 'account-id', permissions: [] };

test('billing availability is owner-scoped and advertises a manageable portal only in live mode', async () => {
  let ownerChecks = 0;
  let portalChecks = 0;
  const controller = new PaddleBillingController(
    { async isOwner(serverId: string, accountId: string) { ownerChecks += 1; return serverId === SERVER_ID && accountId === 'account-id'; } } as never,
    config('live', 'sandbox') as never,
    {} as never,
    { async isAvailable(serverId: string) { portalChecks += 1; return serverId === SERVER_ID; } } as never,
  );

  assert.deepEqual(await controller.availability(SERVER_ID, SESSION as never), {
    onlineCheckout: true,
    ready: true,
    reasonCode: null,
    portalAvailable: true,
    environment: 'sandbox',
    policy: { version: '2026-07-19-v2.0', effectiveDate: '2026-07-19', path: '/policies/billing' },
    products: BILLING_PRODUCTS,
  });
  assert.equal(ownerChecks, 1);
  assert.equal(portalChecks, 1);
});

test('billing availability does not query provider state while online checkout is disabled', async () => {
  const controller = new PaddleBillingController(
    { async isOwner() { return true; } } as never,
    config('off', 'production') as never,
    {} as never,
    { async isAvailable() { throw new Error('must not run'); } } as never,
  );
  assert.deepEqual(await controller.availability(SERVER_ID, SESSION as never), {
    onlineCheckout: false,
    ready: false,
    reasonCode: 'billing_disabled',
    portalAvailable: false,
    environment: 'production',
    policy: { version: '2026-07-19-v2.0', effectiveDate: '2026-07-19', path: '/policies/billing' },
    products: BILLING_PRODUCTS,
  });
});

test('checkout forwards only current policy consent to the immutable intent service', async () => {
  let received: unknown[] | null = null;
  const controller = new PaddleBillingController(
    { async isOwner() { return true; } } as never,
    config('live', 'sandbox') as never,
    { async create(...args: unknown[]) { received = args; return { transactionId: 'txn_test' }; } } as never,
    {} as never,
  );
  await controller.createCheckout(SERVER_ID, { layoutKey: 'brand', policyVersion: '2026-07-19-v2.0' }, SESSION as never);
  assert.deepEqual(received, [SERVER_ID, 'brand', 'account-id', '2026-07-19-v2.0']);
});

function config(mode: string, environment: string) {
  const values: Record<string, string> = { PADDLE_MODE: mode, PADDLE_ENV: environment, PADDLE_POLICY_VERSION: '2026-07-19-v2.0' };
  return { get(key: string, fallback?: string) { return values[key] ?? fallback ?? ''; } };
}
