import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaClient } from '@prisma/client';
import { processWikiNotificationOutbox } from './wiki-notification-outbox';

test('wiki notification outbox claims, delivers, and completes an event', async () => {
  let delivered: Array<{ profileId: bigint; dedupeKey: string }> = [];
  let completed = false;
  let pushDeliveries: Array<{ notificationId: bigint; subscriptionId: string }> = [];
  const event = {
    id: 1n, eventKey: 'revision:3', eventType: 'page_revision', status: 'processing', attempts: 1,
    availableAt: new Date(), lockedAt: new Date(), lockedBy: 'worker-1', processedAt: null, lastError: null, createdAt: new Date(),
    payloadJson: { deliveries: [{ profileId: '8', type: 'page_revision', pageId: '2', actorProfileId: '7', sourceType: 'revision', sourceId: '3', title: 'Guide', message: null, href: '/wiki/revision/3', dedupeKey: 'revision:3:profile:8', createdAt: new Date().toISOString() }] }
  };
  const eventStore = {
    async updateMany(args: { where: { id?: bigint; status?: string }; data: { status?: string } }) {
      if (args.where.id === 1n && args.where.status === 'pending') return { count: 1 };
      if (args.where.id === 1n && args.where.status === 'processing' && args.data.status === 'processed') { completed = true; return { count: 1 }; }
      return { count: 0 };
    },
    async findMany() { return [{ id: 1n }]; },
    async findUnique() { return event; }
  };
  const tx = {
    wikiNotification: {
      async createMany(args: { data: typeof delivered }) { delivered = args.data; return { count: args.data.length }; },
      async findMany() { return [{ id: 20n, profileId: 8n, createdAt: new Date() }]; },
    },
    wikiPushSubscription: {
      async findMany() {
        return [{
          id: 'subscription-1', profileId: 8n, createdAt: new Date(Date.now() - 60_000),
          session: { accountId: 'account-1' },
          profile: { accountId: 'account-1', status: 'active' },
        }];
      },
    },
    wikiPushDelivery: {
      async createMany(args: { data: typeof pushDeliveries }) {
        pushDeliveries = args.data;
        return { count: args.data.length };
      },
    },
    wikiNotificationEvent: eventStore
  };
  const prisma = {
    wikiNotificationEvent: eventStore,
    async $transaction(callback: (store: typeof tx) => Promise<void>) { await callback(tx); }
  } as unknown as PrismaClient;

  const count = await processWikiNotificationOutbox(prisma, 'worker-1');
  assert.equal(count, 1);
  assert.equal(delivered[0]?.profileId, 8n);
  assert.equal(delivered[0]?.dedupeKey, 'revision:3:profile:8');
  assert.equal(pushDeliveries[0]?.notificationId, 20n);
  assert.equal(pushDeliveries[0]?.subscriptionId, 'subscription-1');
  assert.equal(completed, true);
});
