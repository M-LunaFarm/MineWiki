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

test('release submission delivery is discarded when reviewer access was revoked', async () => {
  let delivered = false;
  let completed = false;
  const event = {
    id: 2n, status: 'processing', attempts: 1,
    payloadJson: { deliveries: [{ profileId: '8', type: 'server_wiki_release_submitted', pageId: null, actorProfileId: '7', sourceType: 'server_wiki_release_candidate', sourceId: '12', title: 'Luna', message: null, href: '/wiki/release-reviews/12', dedupeKey: 'release:12:profile:8', createdAt: new Date().toISOString() }] },
  };
  const eventStore = {
    async updateMany(args: { where: { id?: bigint; status?: string }; data: { status?: string } }) {
      if (args.where.id === 2n && args.where.status === 'pending') return { count: 1 };
      if (args.where.id === 2n && args.where.status === 'processing' && args.data.status === 'processed') { completed = true; return { count: 1 }; }
      return { count: 0 };
    },
    async findMany() { return [{ id: 2n }]; },
    async findUnique() { return event; },
  };
  const tx = {
    serverWikiReleaseCandidate: { async findMany() { return [{ id: 12n, spaceId: 3n, status: 'pending_review', createdBy: 7n }]; } },
    wikiProfile: { async findMany() { return [{ id: 8n, accountId: 'account-8' }]; } },
    account: { async findMany() { return [{ id: 'account-8', canonicalAccountId: null }]; } },
    subwikiRole: { async findMany() { return []; } },
    wikiNotification: {
      async createMany() { delivered = true; return { count: 1 }; },
      async findMany() { return []; },
    },
    wikiNotificationEvent: eventStore,
  };
  const prisma = {
    wikiNotificationEvent: eventStore,
    async $transaction(callback: (store: typeof tx) => Promise<void>) { await callback(tx); },
  } as unknown as PrismaClient;

  assert.equal(await processWikiNotificationOutbox(prisma, 'worker-2'), 1);
  assert.equal(delivered, false);
  assert.equal(completed, true);
});

test('release submission delivery reaches only a current same-space reviewer', async () => {
  let delivered: Array<{ profileId: bigint }> = [];
  const event = {
    id: 3n, status: 'processing', attempts: 1,
    payloadJson: { deliveries: [{ profileId: '8', type: 'server_wiki_release_submitted', pageId: null, actorProfileId: '7', sourceType: 'server_wiki_release_candidate', sourceId: '12', title: 'Luna', message: null, href: '/wiki/release-reviews/12', dedupeKey: 'release:12:profile:8', createdAt: new Date().toISOString() }] },
  };
  const eventStore = {
    async updateMany(args: { where: { id?: bigint; status?: string } }) {
      if (args.where.id === 3n && (args.where.status === 'pending' || args.where.status === 'processing')) return { count: 1 };
      return { count: 0 };
    },
    async findMany() { return [{ id: 3n }]; },
    async findUnique() { return event; },
  };
  const tx = {
    serverWikiReleaseCandidate: { async findMany() { return [{ id: 12n, spaceId: 3n, status: 'pending_review', createdBy: 7n }]; } },
    wikiProfile: { async findMany() { return [{ id: 8n, accountId: 'account-8' }]; } },
    account: { async findMany() { return [{ id: 'account-8', canonicalAccountId: null }]; } },
    subwikiRole: { async findMany() { return [{ userId: 8n, spaceId: 3n }]; } },
    wikiNotification: {
      async createMany(args: { data: typeof delivered }) { delivered = args.data; return { count: args.data.length }; },
      async findMany() { return []; },
    },
    wikiNotificationEvent: eventStore,
  };
  const prisma = {
    wikiNotificationEvent: eventStore,
    async $transaction(callback: (store: typeof tx) => Promise<void>) { await callback(tx); },
  } as unknown as PrismaClient;

  assert.equal(await processWikiNotificationOutbox(prisma, 'worker-3'), 1);
  assert.equal(delivered[0]?.profileId, 8n);
});

test('change request delivery reaches only the current candidate submitter', async () => {
  let delivered: Array<{ profileId: bigint; type: string }> = [];
  const event = {
    id: 4n, status: 'processing', attempts: 1,
    payloadJson: { deliveries: [{ profileId: '8', type: 'server_wiki_release_changes_requested', pageId: null, actorProfileId: '7', sourceType: 'server_wiki_release_candidate', sourceId: '12', title: 'Luna', message: null, href: '/servers/server-1/wiki-layouts', dedupeKey: 'release:12:changes:profile:8', createdAt: new Date().toISOString() }] },
  };
  const eventStore = {
    async updateMany(args: { where: { id?: bigint; status?: string } }) {
      if (args.where.id === 4n && (args.where.status === 'pending' || args.where.status === 'processing')) return { count: 1 };
      return { count: 0 };
    },
    async findMany() { return [{ id: 4n }]; },
    async findUnique() { return event; },
  };
  const tx = {
    serverWikiReleaseCandidate: { async findMany() { return [{ id: 12n, spaceId: 3n, status: 'changes_requested', createdBy: 8n }]; } },
    wikiProfile: { async findMany() { return [{ id: 8n, accountId: 'account-8' }]; } },
    account: { async findMany() { return [{ id: 'account-8', canonicalAccountId: null }]; } },
    subwikiRole: { async findMany() { throw new Error('submitter delivery must not depend on reviewer role'); } },
    wikiNotification: {
      async createMany(args: { data: typeof delivered }) { delivered = args.data; return { count: args.data.length }; },
      async findMany() { return []; },
    },
    wikiNotificationEvent: eventStore,
  };
  const prisma = {
    wikiNotificationEvent: eventStore,
    async $transaction(callback: (store: typeof tx) => Promise<void>) { await callback(tx); },
  } as unknown as PrismaClient;

  assert.equal(await processWikiNotificationOutbox(prisma, 'worker-4'), 1);
  assert.deepEqual(delivered.map(({ profileId, type }) => ({ profileId, type })), [{
    profileId: 8n,
    type: 'server_wiki_release_changes_requested',
  }]);
});

test('late collaborator invite delivery is discarded after the invitation is cancelled', async () => {
  let delivered = false;
  let completed = false;
  const invitationId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const event = {
    id: 5n, status: 'processing', attempts: 1,
    payloadJson: { deliveries: [{
      profileId: '8', type: 'server_wiki_collaborator_invited', pageId: null,
      actorProfileId: '7', sourceType: 'server_wiki_collaborator_invitation', sourceId: invitationId,
      title: 'Luna', message: '편집자 역할 초대', href: '/me#server-wiki-invitations',
      dedupeKey: `invite:${invitationId}:profile:8`, createdAt: new Date().toISOString(),
    }] },
  };
  const eventStore = {
    async updateMany(args: { where: { id?: bigint; status?: string }; data: { status?: string } }) {
      if (args.where.id === 5n && args.where.status === 'pending') return { count: 1 };
      if (args.where.id === 5n && args.where.status === 'processing' && args.data.status === 'processed') { completed = true; return { count: 1 }; }
      return { count: 0 };
    },
    async findMany() { return [{ id: 5n }]; },
    async findUnique() { return event; },
  };
  const tx = {
    serverWikiCollaboratorInvitation: {
      async findMany() { return [{ id: invitationId, status: 'cancelled', targetProfileId: 8n }]; },
    },
    wikiNotification: {
      async createMany() { delivered = true; return { count: 1 }; },
      async findMany() { return []; },
    },
    wikiNotificationEvent: eventStore,
  };
  const prisma = {
    wikiNotificationEvent: eventStore,
    async $transaction(callback: (store: typeof tx) => Promise<void>) { await callback(tx); },
  } as unknown as PrismaClient;

  assert.equal(await processWikiNotificationOutbox(prisma, 'worker-5'), 1);
  assert.equal(delivered, false);
  assert.equal(completed, true);
});

test('late ownership transfer request delivery is discarded after cancellation', async () => {
  let delivered = false;
  let completed = false;
  const transferId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const event = {
    id: 6n, status: 'processing', attempts: 1,
    payloadJson: { deliveries: [{
      profileId: '8', type: 'server_ownership_transfer_requested', pageId: null,
      actorProfileId: '7', sourceType: 'server_ownership_transfer', sourceId: transferId,
      sourceVersion: 1,
      title: '서버 소유권 이전 요청', message: 'Luna', href: '/me#server-ownership-transfers',
      dedupeKey: `transfer:${transferId}:requested:profile:8`, createdAt: new Date().toISOString(),
    }] },
  };
  const eventStore = {
    async updateMany(args: { where: { id?: bigint; status?: string }; data: { status?: string } }) {
      if (args.where.id === 6n && args.where.status === 'pending') return { count: 1 };
      if (args.where.id === 6n && args.where.status === 'processing' && args.data.status === 'processed') {
        completed = true;
        return { count: 1 };
      }
      return { count: 0 };
    },
    async findMany() { return [{ id: 6n }]; },
    async findUnique() { return event; },
  };
  const tx = {
    serverOwnershipTransfer: {
      async findMany() {
        return [{
          id: transferId, status: 'cancelled', version: 2, expiresAt: new Date(Date.now() + 60_000),
          sourceOwnerProfileId: 7n, targetProfileId: 8n,
        }];
      },
    },
    wikiNotification: {
      async createMany() { delivered = true; return { count: 1 }; },
      async findMany() { return []; },
    },
    wikiNotificationEvent: eventStore,
  };
  const prisma = {
    wikiNotificationEvent: eventStore,
    async $transaction(callback: (store: typeof tx) => Promise<void>) { await callback(tx); },
  } as unknown as PrismaClient;

  assert.equal(await processWikiNotificationOutbox(prisma, 'worker-6'), 1);
  assert.equal(delivered, false);
  assert.equal(completed, true);
});
