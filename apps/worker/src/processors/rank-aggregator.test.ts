import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRankAggregator } from './rank-aggregator';

type CapturedUpsert = {
  create: { rankBest: number };
  update: { rankCurrent: number; rankBest: number };
};

test('rank aggregation derives best rank from snapshots instead of placeholder stats', async () => {
  let voteGroupCall = 0;
  const statsUpserts: CapturedUpsert[] = [];
  const prisma = {
    vote: {
      groupBy: async () => {
        voteGroupCall += 1;
        if (voteGroupCall <= 4) {
          return [
            { serverId: 'server-a', _count: { _all: 20 } },
            { serverId: 'server-b', _count: { _all: 10 } },
          ];
        }
        return [];
      },
    },
    server: {
      findMany: async () => [
        { id: 'server-a', name: 'Alpha', reviewsCount: 1 },
        { id: 'server-b', name: 'Beta', reviewsCount: 1 },
      ],
      update: (args: unknown) => ({ operation: 'server.update', args }),
    },
    serverStats: {
      upsert: (args: CapturedUpsert) => {
        statsUpserts.push(args);
        return { operation: 'serverStats.upsert', args };
      },
    },
    serverRankSnapshot: {
      groupBy: async () => [
        { serverId: 'server-a', _min: { rank: 3 } },
        { serverId: 'server-b', _min: { rank: 1 } },
      ],
      findMany: async () => [],
      findFirst: async () => ({ id: 'today-snapshot' }),
      createMany: async () => ({ count: 0 }),
    },
    $transaction: async (operations: unknown[]) => operations,
  };

  const aggregator = createRankAggregator(prisma as never);
  const result = await aggregator.aggregate({ processedAt: '2026-07-11T03:00:00.000Z' });

  assert.deepEqual(result, { serversProcessed: 2, risers: 0 });
  assert.equal(statsUpserts[0]?.update.rankCurrent, 1);
  assert.equal(statsUpserts[0]?.update.rankBest, 1);
  assert.equal(statsUpserts[1]?.update.rankCurrent, 2);
  assert.equal(statsUpserts[1]?.update.rankBest, 1);
  assert.equal(voteGroupCall, 11);
});

test('rank aggregation uses the current rank when no historical snapshot exists', async () => {
  let voteGroupCall = 0;
  const statsUpserts: CapturedUpsert[] = [];
  const prisma = {
    vote: {
      groupBy: async () => {
        voteGroupCall += 1;
        return voteGroupCall <= 4
          ? [{ serverId: 'server-new', _count: { _all: 1 } }]
          : [];
      },
    },
    server: {
      findMany: async () => [{ id: 'server-new', name: 'New', reviewsCount: 0 }],
      update: (args: unknown) => ({ operation: 'server.update', args }),
    },
    serverStats: {
      upsert: (args: CapturedUpsert) => {
        statsUpserts.push(args);
        return { operation: 'serverStats.upsert', args };
      },
    },
    serverRankSnapshot: {
      groupBy: async () => [],
      findMany: async () => [],
      findFirst: async () => ({ id: 'today-snapshot' }),
      createMany: async () => ({ count: 0 }),
    },
    $transaction: async (operations: unknown[]) => operations,
  };

  await createRankAggregator(prisma as never).aggregate({
    processedAt: '2026-07-11T03:00:00.000Z',
  });

  assert.equal(statsUpserts[0]?.create.rankBest, 1);
  assert.equal(statsUpserts[0]?.update.rankBest, 1);
});
