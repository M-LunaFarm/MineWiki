import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRankAggregator } from './rank-aggregator';

type CapturedUpsert = {
  create: { rankBest: number; rankCalculatedAt: Date | null; votesTotal: number };
  update: {
    rankCurrent: number;
    rankBest: number;
    rankCalculatedAt: Date | null;
    votesTotal: number;
  };
};

test('rank aggregation derives best rank from snapshots instead of placeholder stats', async () => {
  let voteGroupCall = 0;
  const statsUpserts: CapturedUpsert[] = [];
  let serverQuery: unknown;
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
      findMany: async (query: unknown) => {
        serverQuery = query;
        return [
        { id: 'server-a', name: 'Alpha', reviewsCount: 1, stats: null },
        { id: 'server-b', name: 'Beta', reviewsCount: 1, stats: null },
        ];
      },
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
      deleteMany: (args: unknown) => ({ operation: 'serverRankSnapshot.deleteMany', args }),
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
  assert.equal(statsUpserts[0]?.update.rankCalculatedAt.toISOString(), '2026-07-11T03:00:00.000Z');
  assert.equal(voteGroupCall, 11);
  assert.deepEqual(serverQuery, {
    where: { listingStatus: 'active' },
    select: {
      id: true,
      name: true,
      reviewsCount: true,
      stats: { select: { rankBest: true, rankCalculatedAt: true } },
    },
  });
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
      findMany: async () => [
        { id: 'server-new', name: 'New', reviewsCount: 0, stats: null },
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
      groupBy: async () => [],
      findMany: async () => [],
      findFirst: async () => ({ id: 'today-snapshot' }),
      createMany: async () => ({ count: 0 }),
      deleteMany: (args: unknown) => ({ operation: 'serverRankSnapshot.deleteMany', args }),
    },
    $transaction: async (operations: unknown[]) => operations,
  };

  await createRankAggregator(prisma as never).aggregate({
    processedAt: '2026-07-11T03:00:00.000Z',
  });

  assert.equal(statsUpserts[0]?.create.rankBest, 1);
  assert.equal(statsUpserts[0]?.update.rankBest, 1);
});

test('rank aggregation excludes servers without a valid lifetime vote', async () => {
  let voteGroupCall = 0;
  const statsUpserts: CapturedUpsert[] = [];
  const snapshotDeletes: unknown[] = [];
  const snapshotCreates: Array<{ data: Array<{ serverId: string }> }> = [];
  const prisma = {
    vote: {
      groupBy: async () => {
        voteGroupCall += 1;
        if (voteGroupCall <= 3) {
          return [{ serverId: 'ranked', _count: { _all: 2 } }];
        }
        if (voteGroupCall === 4) {
          return [{ serverId: 'ranked', _count: { _all: 5 } }];
        }
        return [];
      },
    },
    server: {
      findMany: async () => [
        { id: 'ranked', name: 'Ranked', reviewsCount: 0, stats: null },
        {
          id: 'unranked',
          name: 'Unranked',
          reviewsCount: 99,
          stats: { rankBest: 1, rankCalculatedAt: new Date('2026-07-14T01:00:00.000Z') },
        },
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
      groupBy: async () => [],
      findMany: async () => [],
      createMany: async (args: { data: Array<{ serverId: string }> }) => {
        snapshotCreates.push(args);
        return { count: args.data.length };
      },
      deleteMany: (args: unknown) => {
        snapshotDeletes.push(args);
        return { operation: 'serverRankSnapshot.deleteMany', args };
      },
    },
    $transaction: async (operations: unknown[]) => operations,
  };

  const result = await createRankAggregator(prisma as never).aggregate({
    processedAt: '2026-07-15T01:00:00.000Z',
  });

  assert.deepEqual(result, { serversProcessed: 2, risers: 0 });
  assert.equal(statsUpserts[0]?.update.rankCurrent, 1);
  assert.equal(statsUpserts[0]?.update.votesTotal, 5);
  assert.equal(statsUpserts[1]?.update.rankCurrent, 0);
  assert.equal(statsUpserts[1]?.update.rankBest, 0);
  assert.equal(statsUpserts[1]?.update.rankCalculatedAt, null);
  assert.equal(statsUpserts[1]?.update.votesTotal, 0);
  assert.deepEqual(snapshotDeletes, [{ where: { serverId: { in: ['unranked'] } } }]);
  assert.deepEqual(snapshotCreates[0]?.data.map((row) => row.serverId), ['ranked']);
});

test('rank aggregation preserves a better rank reached earlier the same day', async () => {
  let voteGroupCall = 0;
  const statsUpserts: CapturedUpsert[] = [];
  const prisma = {
    vote: {
      groupBy: async () => {
        voteGroupCall += 1;
        return voteGroupCall <= 4
          ? [
              { serverId: 'alpha', _count: { _all: 30 } },
              { serverId: 'beta', _count: { _all: 20 } },
              { serverId: 'gamma', _count: { _all: 10 } },
            ]
          : [];
      },
    },
    server: {
      findMany: async () => [
        { id: 'alpha', name: 'Alpha', reviewsCount: 0, stats: null },
        { id: 'beta', name: 'Beta', reviewsCount: 0, stats: null },
        {
          id: 'gamma',
          name: 'Gamma',
          reviewsCount: 0,
          stats: { rankBest: 1, rankCalculatedAt: new Date('2026-07-15T00:30:00.000Z') },
        },
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
      groupBy: async () => [{ serverId: 'gamma', _min: { rank: 5 } }],
      findMany: async () => [],
      createMany: async () => ({ count: 0 }),
      deleteMany: (args: unknown) => ({ operation: 'serverRankSnapshot.deleteMany', args }),
    },
    $transaction: async (operations: unknown[]) => operations,
  };

  await createRankAggregator(prisma as never).aggregate({
    processedAt: '2026-07-15T01:00:00.000Z',
  });

  assert.equal(statsUpserts[2]?.update.rankCurrent, 3);
  assert.equal(statsUpserts[2]?.update.rankBest, 1);
});

test('daily rank snapshots stay idempotent when same-day aggregations overlap', async () => {
  const storedIds = new Set<string>();
  const createManyCalls: Array<{ data: Array<{ id: string }>; skipDuplicates?: boolean }> = [];
  const prisma = {
    vote: {
      groupBy: async () => [{ serverId: 'server-a', _count: { _all: 3 } }],
    },
    server: {
      findMany: async () => [
        { id: 'server-a', name: 'Alpha', reviewsCount: 0, stats: null },
      ],
      update: (args: unknown) => ({ operation: 'server.update', args }),
    },
    serverStats: {
      upsert: (args: unknown) => ({ operation: 'serverStats.upsert', args }),
    },
    serverRankSnapshot: {
      groupBy: async () => [],
      findMany: async () => [],
      createMany: async (args: { data: Array<{ id: string }>; skipDuplicates?: boolean }) => {
        createManyCalls.push(args);
        let count = 0;
        for (const row of args.data) {
          if (!storedIds.has(row.id)) {
            storedIds.add(row.id);
            count += 1;
          }
        }
        return { count };
      },
      deleteMany: (args: unknown) => ({ operation: 'serverRankSnapshot.deleteMany', args }),
    },
    $transaction: async (operations: unknown[]) => operations,
  };
  const aggregator = createRankAggregator(prisma as never);

  await Promise.all([
    aggregator.aggregate({ processedAt: '2026-07-15T01:00:00.000Z' }),
    aggregator.aggregate({ processedAt: '2026-07-15T01:00:00.000Z' }),
  ]);

  assert.equal(createManyCalls.length, 2);
  assert.equal(createManyCalls.every((call) => call.skipDuplicates === true), true);
  assert.deepEqual([...storedIds], ['rank:2026-07-15:server-a']);
});
