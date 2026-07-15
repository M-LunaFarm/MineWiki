import assert from 'node:assert/strict';
import test from 'node:test';
import { createECDH } from 'node:crypto';
import { encryptSecret } from '@minewiki/security';
import { processWebPushDeliveries, type WebPushDeliveryConfig } from './web-push-delivery';

const KEY = 'test-web-push-encryption-key-with-32-bytes';
const CONFIG: WebPushDeliveryConfig = {
  enabled: true,
  publicKey: 'public',
  privateKey: 'private',
  subject: 'mailto:support@minewiki.kr',
};
const browserKey = createECDH('prime256v1');
browserKey.generateKeys();
const P256DH = browserKey.getPublicKey().toString('base64url');
const AUTH = Buffer.alloc(16, 9).toString('base64url');

function fixture(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-07-16T12:00:00.000Z');
  const delivery = {
    id: 10n,
    notificationId: 20n,
    status: 'processing',
    attempts: 1,
    lockedBy: 'worker:claim',
    subscription: {
      id: 'subscription-1',
      disabledAt: null,
      expirationTime: null,
      endpointCiphertext: encryptSecret('https://fcm.googleapis.com/fcm/send/example', KEY),
      p256dhCiphertext: encryptSecret(P256DH, KEY),
      authCiphertext: encryptSecret(AUTH, KEY),
      session: { accountId: 'account-1', expiresAt: new Date('2026-07-17T00:00:00.000Z'), account: { lifecycleStatus: 'active' } },
      profile: { accountId: 'account-1', status: 'active' },
    },
    ...overrides,
  };
  const updates: Array<Record<string, unknown>> = [];
  let deleted = 0;
  const prisma = {
    wikiPushDelivery: {
      async updateMany(input: Record<string, unknown>) {
        updates.push(input);
        const data = input.data as { status?: string; lockedBy?: string };
        const where = input.where as { status?: string };
        if (where.status === 'processing' && (data.status === 'pending' || data.status === 'failed')) return { count: 0 };
        if (where.status === 'pending' && data.status === 'processing') {
          delivery.lockedBy = String((input.data as { lockedBy: string }).lockedBy);
          return { count: 1 };
        }
        return { count: 1 };
      },
      async findMany() { return [{ id: delivery.id }]; },
      async findUnique() { return delivery; },
    },
    wikiPushSubscription: {
      async deleteMany() { deleted += 1; return { count: 1 }; },
      async updateMany(input: Record<string, unknown>) { updates.push(input); return { count: 1 }; },
    },
    async $transaction(values: unknown[]) { return Promise.all(values); },
  };
  return { now, delivery, prisma, updates, getDeleted: () => deleted };
}

test('sends only a generic payload and completes the claimed delivery', async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  const state = fixture();
  let payload = '';
  let sendOptions: Record<string, unknown> = {};
  const result = await processWebPushDeliveries(state.prisma as never, CONFIG, {
    now: state.now,
    workerId: 'worker',
    send: async (_subscription, value, options) => { payload = value; sendOptions = options; return { statusCode: 201 }; },
  });
  assert.deepEqual(JSON.parse(payload), { notificationId: '20', tag: 'minewiki-notification-20' });
  assert.equal(/title|message|href|endpoint/i.test(payload), false);
  assert.equal(result.delivered, 1);
  assert.equal(sendOptions.TTL, 300);
  assert.equal(sendOptions.urgency, 'normal');
  assert.ok(state.updates.some((entry) => JSON.stringify(entry, (_key, value) => typeof value === 'bigint' ? value.toString() : value).includes('lease_exhausted')));
});

test('removes a subscription on an expired endpoint response', async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  const state = fixture();
  const result = await processWebPushDeliveries(state.prisma as never, CONFIG, {
    now: state.now,
    send: async () => { throw { statusCode: 410 }; },
  });
  assert.equal(result.removedSubscriptions, 1);
  assert.equal(state.getDeleted(), 1);
});

test('retries 429 using Retry-After without exposing the endpoint', async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  const state = fixture();
  const result = await processWebPushDeliveries(state.prisma as never, CONFIG, {
    now: state.now,
    random: () => 0,
    send: async () => { throw { statusCode: 429, headers: { 'retry-after': '30' } }; },
  });
  assert.equal(result.retried, 1);
  const serialized = JSON.stringify(state.updates, (_key, value) => typeof value === 'bigint' ? value.toString() : value);
  assert.match(serialized, /http_429/);
  assert.equal(serialized.includes('fcm.googleapis.com'), false);
  assert.match(serialized, /2026-07-16T12:00:30.000Z/);
});

test('deletes subscriptions whose session or profile is no longer valid', async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  const state = fixture({
    subscription: {
      ...fixture().delivery.subscription,
      session: { accountId: 'account-1', expiresAt: new Date('2026-07-15T00:00:00.000Z'), account: { lifecycleStatus: 'active' } },
    },
  });
  let sent = false;
  const result = await processWebPushDeliveries(state.prisma as never, CONFIG, {
    now: state.now,
    send: async () => { sent = true; return { statusCode: 201 }; },
  });
  assert.equal(sent, false);
  assert.equal(result.removedSubscriptions, 1);
});

test('removes an unreadable encrypted subscription instead of retrying secret material', async () => {
  process.env.APP_ENCRYPTION_KEY = KEY;
  const baseline = fixture().delivery.subscription;
  const state = fixture({ subscription: { ...baseline, endpointCiphertext: 'enc:v1:invalid' } });
  let sent = false;
  const result = await processWebPushDeliveries(state.prisma as never, CONFIG, {
    now: state.now,
    send: async () => { sent = true; return { statusCode: 201 }; },
  });
  assert.equal(sent, false);
  assert.equal(result.removedSubscriptions, 1);
  assert.equal(result.retried, 0);
});

test('does nothing while web push is disabled', async () => {
  const state = fixture();
  const result = await processWebPushDeliveries(state.prisma as never, { ...CONFIG, enabled: false });
  assert.deepEqual(result, { delivered: 0, retried: 0, failed: 0, removedSubscriptions: 0 });
  assert.equal(state.updates.length, 0);
});
