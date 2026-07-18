import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createRateLimitStorage,
  SecondsBasedThrottlerStorage,
} from './rate-limit-storage.factory';

function config(environment: 'development' | 'test' | 'production', redisUrl?: string) {
  return {
    get(key: string, fallback?: string) {
      if (key === 'NODE_ENV') return environment;
      return fallback;
    },
    getOptional(key: string) {
      return key === 'REDIS_URL' ? redisUrl : undefined;
    },
  } as never;
}

test('development and test environments may use the local memory fallback', async () => {
  const development = await createRateLimitStorage(config('development'));
  const unitTest = await createRateLimitStorage(config('test'));
  assert.ok(development instanceof SecondsBasedThrottlerStorage);
  assert.ok(unitTest instanceof SecondsBasedThrottlerStorage);
});

test('application throttle seconds are converted to Nest storage milliseconds once', async () => {
  const calls: unknown[][] = [];
  const storage = new SecondsBasedThrottlerStorage({
    async increment(...args: unknown[]) {
      calls.push(args);
      return { totalHits: 1, timeToExpire: 60, isBlocked: false, timeToBlockExpire: 0 };
    },
  });
  await storage.increment('key', 60, 10, 300, 'default');
  assert.deepEqual(calls, [['key', 60_000, 10, 300_000, 'default']]);
});

test('production refuses to start without a shared Redis rate-limit store', async () => {
  await assert.rejects(
    createRateLimitStorage(config('production')),
    /REDIS_URL is required for distributed production rate limits/u,
  );
});
