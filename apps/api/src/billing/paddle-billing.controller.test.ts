import assert from 'node:assert/strict';
import test from 'node:test';
import { PaddleBillingController } from './paddle-billing.controller';

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
    portalAvailable: true,
    environment: 'sandbox',
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
    portalAvailable: false,
    environment: 'production',
  });
});

function config(mode: string, environment: string) {
  const values: Record<string, string> = { PADDLE_MODE: mode, PADDLE_ENV: environment };
  return { get(key: string, fallback?: string) { return values[key] ?? fallback ?? ''; } };
}
