import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiscordDigestJob } from '@minewiki/schemas';
import { createDiscordDigestSender } from './discord-digest';

const baseJob: DiscordDigestJob = {
  guildId: '123',
  channelId: '456',
  scheduledFor: new Date('2024-01-02T00:00:00Z').toISOString(),
  timezone: 'Asia/Seoul'
};

test('delivers digest successfully when dispatcher resolves', async () => {
  const sender = createDiscordDigestSender(async () => {});
  const result = await sender.send(baseJob);
  assert.equal(result.delivered, true);
  assert.equal(result.status, 'delivered');
});

test('handles missing permissions errors from Discord', async () => {
  const sender = createDiscordDigestSender(async () => {
    const error = new Error('Missing Permissions') as Error & { code?: number };
    error.code = 50013;
    throw error;
  });
  const result = await sender.send(baseJob);
  assert.equal(result.delivered, false);
  assert.equal(result.status, 'missing_permissions');
  assert.equal(result.errorCode, 50013);
});

test('handles unknown channel errors', async () => {
  const sender = createDiscordDigestSender(async () => {
    throw { code: 10003, message: 'Unknown Channel' };
  });
  const result = await sender.send(baseJob);
  assert.equal(result.delivered, false);
  assert.equal(result.status, 'channel_missing');
  assert.equal(result.errorCode, 10003);
});

test('handles Discord rate limiting responses', async () => {
  const originalNow = Date.now;
  Date.now = () => 1_000;
  try {
    const sender = createDiscordDigestSender(async () => {
      throw { status: 429, retry_after: 2 };
    });
    const result = await sender.send(baseJob);
    assert.equal(result.delivered, false);
    assert.equal(result.status, 'rate_limited');
    assert.equal(result.errorCode, 429);
    assert.equal(result.retryAt, new Date(1_000 + 2_000).toISOString());
  } finally {
    Date.now = originalNow;
  }
});

test('marks unknown errors with fallback status', async () => {
  const sender = createDiscordDigestSender(async () => {
    throw new Error('Unexpected failure');
  });
  const result = await sender.send(baseJob);
  assert.equal(result.delivered, false);
  assert.equal(result.status, 'unknown_error');
  assert.ok(result.errorCode);
});
