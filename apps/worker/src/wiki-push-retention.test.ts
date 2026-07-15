import assert from 'node:assert/strict';
import test from 'node:test';
import { sweepWikiPushRetention } from './wiki-push-retention';

test('retention removes expired subscriptions and old terminal rows in bounded batches', async () => {
  const whereClauses: unknown[] = [];
  const prisma = {
    wikiPushSubscription: {
      async findMany(input: { where: unknown }) { whereClauses.push(input.where); return [{ id: 'sub-1' }]; },
      async deleteMany() { return { count: 1 }; },
    },
    wikiPushDelivery: {
      async findMany(input: { where: unknown }) { whereClauses.push(input.where); return [{ id: 2n }]; },
      async deleteMany() { return { count: 1 }; },
    },
    wikiNotificationEvent: {
      async findMany(input: { where: unknown }) { whereClauses.push(input.where); return [{ id: 3n }]; },
      async deleteMany() { return { count: 1 }; },
    },
  };
  const result = await sweepWikiPushRetention(prisma as never, new Date('2026-07-16T00:00:00.000Z'));
  assert.deepEqual(result, { subscriptions: 1, deliveries: 1, events: 1 });
  const serialized = JSON.stringify(whereClauses);
  assert.match(serialized, /2026-06-16T00:00:00.000Z/);
  assert.match(serialized, /2026-04-17T00:00:00.000Z/);
});
