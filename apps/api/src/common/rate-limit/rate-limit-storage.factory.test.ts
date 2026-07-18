import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ThrottlerStorageService } from '@nestjs/throttler';
import { createRateLimitStorage } from './rate-limit-storage.factory';

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
  assert.ok(development instanceof ThrottlerStorageService);
  assert.ok(unitTest instanceof ThrottlerStorageService);
});

test('production refuses to start without a shared Redis rate-limit store', async () => {
  await assert.rejects(
    createRateLimitStorage(config('production')),
    /REDIS_URL is required for distributed production rate limits/u,
  );
});
