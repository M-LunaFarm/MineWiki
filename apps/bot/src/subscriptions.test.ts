import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DateTime } from 'luxon';
import { PrismaClient } from '@prisma/client';
import {
  SubscriptionStore,
  computeNextDigest,
  validateTimezone
} from './subscriptions';

const hasDatabase = Boolean(process.env.DATABASE_URL);

test('validates timezone strings', () => {
  assert.equal(validateTimezone('Asia/Seoul'), 'Asia/Seoul');
  assert.throws(() => validateTimezone('Not/AZone'));
});

test('computes next digest at local midnight', () => {
  const reference = DateTime.fromISO('2024-04-10T15:00:00Z');
  const next = computeNextDigest('Asia/Seoul', reference);
  const zoned = next.setZone('Asia/Seoul');
  assert.equal(zoned.hour, 0);
  assert.equal(zoned.minute, 0);
});

test('stores and retrieves subscriptions with updated schedule', { skip: !hasDatabase }, async () => {
  const prisma = new PrismaClient();
  const store = new SubscriptionStore(prisma);
  await prisma.discordSubscription.deleteMany({ where: { guildId: 'guild-1' } });

  const record = await store.upsert('guild-1', {
    channelId: 'channel-1',
    timezone: 'Asia/Seoul',
    roleRewardId: 'role-1'
  });
  assert.equal(record.guildId, 'guild-1');
  assert.equal((await store.get('guild-1'))?.channelId, 'channel-1');

  const due = await store.due(new Date(Date.now() + 1000 * 60 * 60 * 24 * 2));
  assert.ok(due.length >= 1);

  const updated = await store.updateNextDigest('guild-1');
  assert.ok(updated);
  const originalTime = DateTime.fromISO(record.nextDigestAt);
  const updatedTime = DateTime.fromISO(updated!.nextDigestAt);
  assert.ok(updatedTime > originalTime);

  await prisma.discordSubscription.deleteMany({ where: { guildId: 'guild-1' } });
  await prisma.$disconnect();
});
