import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@minewiki/config';
import { RedisThrottlerStorage } from './redis-throttler-storage';
import { SecondsBasedThrottlerStorage } from './rate-limit-storage.factory';

const redisUrl = new ConfigService().getOptional('REDIS_URL');
const storages: RedisThrottlerStorage[] = [];

after(async () => {
  await Promise.all(storages.map((storage) => storage.onApplicationShutdown()));
});

test('two API instances consume one shared request budget', { skip: !redisUrl }, async () => {
  const namespace = `minewiki:test:rate-limit:${randomUUID()}`;
  const firstRedis = new RedisThrottlerStorage(redisUrl!, namespace);
  const secondRedis = new RedisThrottlerStorage(redisUrl!, namespace);
  const first = new SecondsBasedThrottlerStorage(firstRedis);
  const second = new SecondsBasedThrottlerStorage(secondRedis);
  storages.push(firstRedis, secondRedis);
  await Promise.all([firstRedis.connect(), secondRedis.connect()]);

  const one = await first.increment('shared-account', 1, 2, 1, 'default');
  const two = await second.increment('shared-account', 1, 2, 1, 'default');
  const three = await first.increment('shared-account', 1, 2, 1, 'default');
  const stillBlocked = await second.increment('shared-account', 1, 2, 1, 'default');

  assert.deepEqual([one.totalHits, two.totalHits, three.totalHits], [1, 2, 3]);
  assert.equal(one.isBlocked, false);
  assert.equal(two.isBlocked, false);
  assert.equal(three.isBlocked, true);
  assert.equal(stillBlocked.isBlocked, true);
  assert.equal(stillBlocked.totalHits, 3, 'blocked requests must not inflate the counter');
});

test('the shared budget resets after the block duration', { skip: !redisUrl }, async () => {
  const namespace = `minewiki:test:rate-limit:${randomUUID()}`;
  const redis = new RedisThrottlerStorage(redisUrl!, namespace);
  const storage = new SecondsBasedThrottlerStorage(redis);
  storages.push(redis);
  await redis.connect();

  await storage.increment('expiring-account', 0.06, 1, 0.08, 'default');
  const blocked = await storage.increment('expiring-account', 0.06, 1, 0.08, 'default');
  assert.equal(blocked.isBlocked, true);

  await new Promise((resolve) => setTimeout(resolve, 110));
  const recovered = await storage.increment('expiring-account', 0.06, 1, 0.08, 'default');
  assert.equal(recovered.isBlocked, false);
  assert.equal(recovered.totalHits, 1);
});

test('concurrent instances update the budget atomically', { skip: !redisUrl }, async () => {
  const namespace = `minewiki:test:rate-limit:${randomUUID()}`;
  const firstRedis = new RedisThrottlerStorage(redisUrl!, namespace);
  const secondRedis = new RedisThrottlerStorage(redisUrl!, namespace);
  const first = new SecondsBasedThrottlerStorage(firstRedis);
  const second = new SecondsBasedThrottlerStorage(secondRedis);
  storages.push(firstRedis, secondRedis);
  await Promise.all([firstRedis.connect(), secondRedis.connect()]);

  const results = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    (index % 2 === 0 ? first : second).increment('concurrent-ip', 1, 10, 1, 'default'),
  ));
  assert.equal(results.filter((result) => !result.isBlocked).length, 10);
  assert.equal(results.filter((result) => result.isBlocked).length, 10);
  assert.equal(Math.max(...results.map((result) => result.totalHits)), 11);
});
