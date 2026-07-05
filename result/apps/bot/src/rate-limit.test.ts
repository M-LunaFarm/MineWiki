import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RateLimitQueue, extractRetryAfterMs, isRateLimitError } from './rate-limit';

test('rate limit queue delays execution when 429 occurs', async () => {
  const queue = new RateLimitQueue();
  let attempt = 0;
  const started = Date.now();
  await assert.rejects(
    queue.schedule(async () => {
      attempt += 1;
      throw {
        status: 429,
        rawError: {
          retry_after: 0.5
        }
      };
    })
  );
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 500);
  assert.equal(attempt, 1);
});

test('retry-after header parsing', () => {
  const error = {
    status: 429,
    headers: new Map([['retry-after', '3']])
  };
  assert.equal(isRateLimitError(error), true);
  const ms = extractRetryAfterMs(error);
  assert.equal(ms, 3000);
});
