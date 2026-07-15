import assert from 'node:assert/strict';
import test from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { decryptAppSecret } from '../common/secret-codec';
import {
  validatePushEndpoint,
  validateSubscriptionKeys,
  WikiPushSubscriptionService,
} from './wiki-push-subscription.service';

const session = {
  sessionId: '11111111-1111-4111-8111-111111111111',
  userId: '22222222-2222-4222-8222-222222222222',
  tokenVersion: 1,
  isElevated: false,
  authenticatedAt: new Date().toISOString(),
};

const endpoint = 'https://fcm.googleapis.com/fcm/send/private-capability-token';
const p256dh = Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 7)]).toString('base64url');
const auth = Buffer.alloc(16, 9).toString('base64url');

test('push endpoint validation accepts known providers and rejects SSRF-shaped URLs', () => {
  assert.equal(validatePushEndpoint(endpoint), endpoint);
  for (const invalid of [
    'http://fcm.googleapis.com/fcm/send/x',
    'https://user@fcm.googleapis.com/fcm/send/x',
    'https://fcm.googleapis.com:8443/fcm/send/x',
    'https://127.0.0.1/push',
    'https://example.com/push',
    'https://updates.push.services.mozilla.com/push#secret',
  ]) {
    assert.throws(() => validatePushEndpoint(invalid), BadRequestException);
  }
});

test('subscription key validation requires an uncompressed P-256 key and 16-byte auth secret', () => {
  assert.doesNotThrow(() => validateSubscriptionKeys(p256dh, auth));
  assert.throws(() => validateSubscriptionKeys(Buffer.alloc(65).toString('base64url'), auth), BadRequestException);
  assert.throws(() => validateSubscriptionKeys(p256dh, Buffer.alloc(15).toString('base64url')), BadRequestException);
  assert.throws(() => validateSubscriptionKeys('not+base64', auth), BadRequestException);
});

test('registration binds the session profile and stores no push capability plaintext', async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
  let write: Record<string, unknown> | undefined;
  const transaction = {
    wikiPushSubscription: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        'sessionId' in where ? null : null,
      count: async () => 0,
      delete: async () => undefined,
      upsert: async ({ create }: { create: Record<string, unknown> }) => { write = create; },
    },
  };
  const service = new WikiPushSubscriptionService(
    {
      wikiPushSubscription: { findUnique: async () => ({ disabledAt: null, expirationTime: null }) },
      $transaction: async (callback: (tx: typeof transaction) => Promise<void>) => callback(transaction),
    } as never,
    { ensureWikiProfile: async () => ({ id: 42n, status: 'active' }) } as never,
    { getOptional: (key: string) => key === 'WEB_PUSH_ENABLED' ? 'true' : key === 'VAPID_PUBLIC_KEY' ? 'public-key' : undefined } as never,
  );
  try {
    const result = await service.register(session, { endpoint, expirationTime: null, keys: { p256dh, auth } });
    assert.equal(result.subscribed, true);
    assert.equal(write?.sessionId, session.sessionId);
    assert.equal(write?.profileId, 42n);
    const serialized = JSON.stringify(write, (_, value) => typeof value === 'bigint' ? value.toString() : value);
    assert.equal(serialized.includes(endpoint), false);
    assert.equal(serialized.includes(p256dh), false);
    assert.equal(serialized.includes(auth), false);
    assert.equal(decryptAppSecret(write?.endpointCiphertext as string), endpoint);
    assert.equal(decryptAppSecret(write?.p256dhCiphertext as string), p256dh);
    assert.equal(decryptAppSecret(write?.authCiphertext as string), auth);
  } finally {
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});

test('registration never transfers an endpoint to a different wiki profile', async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = Buffer.alloc(32, 3).toString('base64');
  const transaction = {
    wikiPushSubscription: {
      findUnique: async ({ where }: { where: Record<string, unknown> }) =>
        'endpointHash' in where ? { id: 'existing', profileId: 99n } : null,
    },
  };
  const service = new WikiPushSubscriptionService(
    { $transaction: async (callback: (tx: typeof transaction) => Promise<void>) => callback(transaction) } as never,
    { ensureWikiProfile: async () => ({ id: 42n, status: 'active' }) } as never,
    { getOptional: (key: string) => key === 'WEB_PUSH_ENABLED' ? 'true' : key === 'VAPID_PUBLIC_KEY' ? 'public-key' : undefined } as never,
  );
  try {
    await assert.rejects(
      service.register(session, { endpoint, keys: { p256dh, auth } }),
      ConflictException,
    );
  } finally {
    if (previousKey === undefined) delete process.env.APP_ENCRYPTION_KEY;
    else process.env.APP_ENCRYPTION_KEY = previousKey;
  }
});
