import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ServerService } from './server.service';

test('server list exposes the aggregated global rank metadata', async () => {
  const serverId = randomUUID();
  const prisma = {
    server: {
      findMany: async () => [
        {
          id: serverId,
          shortCode: 'abcde',
          wikiSpaceId: null,
          wikiPageId: null,
          wikiSlug: null,
          name: 'Ranked Server',
          joinHost: 'play.example.com',
          joinPort: 25565,
          edition: 'java',
          supportedVersions: ['1.21'],
          tags: ['survival'],
          shortDescription: 'Ranked server',
          verificationGrade: 'A',
          verifiedAt: new Date('2026-07-11T00:00:00.000Z'),
          votes24h: 42,
          votesMonthly: 300,
          reviewsCount: 7,
          voteRequiresOwnership: true,
          bannerUrl: null,
          websiteUrl: null,
          playersOnline: 12,
          playersMax: 100,
          playersLastUpdatedAt: new Date('2026-07-11T00:00:00.000Z'),
          isOnline: true,
          latencyMs: 25,
          stats: {
            rankCurrent: 2,
            rankDelta24h: 3,
            rankBest: 1,
            lastUpdatedAt: new Date('2026-07-11T01:00:00.000Z'),
          },
        },
      ],
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const [server] = await service.list();

  assert.deepEqual(server.rank, {
    current: 2,
    delta24h: 3,
    best: 1,
    updatedAt: '2026-07-11T01:00:00.000Z',
  });
});

test('server list marks zero-vote servers as awaiting rank aggregation', async () => {
  const serverId = randomUUID();
  const prisma = {
    server: {
      findMany: async () => [
        {
          id: serverId,
          name: 'New Server',
          joinHost: 'new.example.com',
          joinPort: 25565,
          edition: 'java',
          supportedVersions: ['1.21'],
          tags: [],
          shortDescription: 'New server',
          verificationGrade: 'Unverified',
          verifiedAt: null,
          votes24h: 0,
          votesMonthly: 0,
          reviewsCount: 0,
          voteRequiresOwnership: false,
          bannerUrl: null,
          websiteUrl: null,
          playersOnline: 0,
          playersMax: 0,
          playersLastUpdatedAt: null,
          isOnline: true,
          latencyMs: 30,
          stats: {
            rankCurrent: 9,
            rankDelta24h: 0,
            rankBest: 9,
            lastUpdatedAt: new Date('2026-07-11T01:00:00.000Z'),
          },
        },
      ],
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const [server] = await service.list();

  assert.equal(server.rank, null);
});

test('paginated rankings apply server-side filters and return page metadata', async () => {
  const serverId = randomUUID();
  const queries: unknown[] = [];
  const rankedServer = {
    id: serverId,
    name: 'Ranked Server',
    joinHost: 'ranked.example.com',
    joinPort: 25565,
    edition: 'java',
    supportedVersions: ['1.21'],
    tags: ['survival'],
    shortDescription: 'Ranked server',
    verificationGrade: 'A',
    verifiedAt: new Date('2026-07-11T00:00:00.000Z'),
    votes24h: 42,
    votesMonthly: 300,
    reviewsCount: 7,
    voteRequiresOwnership: true,
    bannerUrl: null,
    websiteUrl: null,
    playersOnline: 12,
    playersMax: 100,
    playersLastUpdatedAt: new Date('2026-07-11T00:00:00.000Z'),
    isOnline: true,
    latencyMs: 25,
    createdAt: new Date('2026-07-10T00:00:00.000Z'),
    stats: {
      rankCurrent: 2,
      rankDelta24h: 3,
      rankBest: 1,
      lastUpdatedAt: new Date('2026-07-11T01:00:00.000Z'),
    },
  };
  const prisma = {
    server: {
      findMany: async (query: unknown) => {
        queries.push(query);
        return [rankedServer];
      },
      count: async (query: unknown) => {
        queries.push(query);
        return 25;
      },
      aggregate: async (query: unknown) => {
        queries.push(query);
        return { _sum: { votes24h: 420 } };
      },
    },
    serverStats: {
      aggregate: async (query: unknown) => {
        queries.push(query);
        return { _max: { lastUpdatedAt: new Date('2026-07-11T01:00:00.000Z') } };
      },
    },
    $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const result = await service.rankings({
    edition: 'java',
    grade: 'Verified',
    online: true,
    tag: 'survival',
    search: 'ranked',
    sort: 'latest',
    page: 2,
    pageSize: 12,
  });

  assert.equal(result.total, 25);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 12);
  assert.equal(result.totalPages, 3);
  assert.deepEqual(result.summary, { online: 25, verified: 25, votes24h: 420 });
  assert.equal(result.rankUpdatedAt, '2026-07-11T01:00:00.000Z');
  assert.equal(result.items[0]?.rank?.current, 2);
  assert.equal(queries.length, 6);
  assert.deepEqual((queries[0] as { skip: number; take: number }).skip, 12);
  assert.deepEqual((queries[0] as { skip: number; take: number }).take, 12);
  assert.deepEqual(
    (queries[0] as { where: { tags: unknown } }).where.tags,
    { array_contains: ['survival'] },
  );
  assert.equal((queries[0] as { where: { isOnline: unknown } }).where.isOnline, true);
});

test('server banner upload uses canonical file service metadata path', async () => {
  const serverId = randomUUID();
  const accountId = randomUUID();
  const calls: unknown[] = [];
  const files = {
    createImage: async (...args: unknown[]) => {
      calls.push(args);
      return {
        id: 'file-1',
        filename: 'banner.webp',
        publicPath: 'upload://banner.webp',
        width: 320,
        height: 160,
      };
    },
  };
  const updates: unknown[] = [];
  const prisma = {
    server: {
      findUnique: async () => ({ id: serverId }),
      update: async (args: unknown) => {
        updates.push(args);
        return { id: serverId, bannerUrl: 'upload://banner.webp' };
      },
    },
  };
  const service = new ServerService(files as never, prisma as never, {} as never);

  const stored = await service.updateBanner(serverId, accountId, {
    data: 'data:image/png;base64,AAAA',
    filename: 'banner.png',
  });

  assert.equal(stored.publicPath, 'upload://banner.webp');
  assert.deepEqual(calls, [
    [
      accountId,
      {
        data: 'data:image/png;base64,AAAA',
        filename: 'banner.png',
        usageContext: 'server_banner',
      },
    ],
  ]);
  assert.deepEqual(updates, [
    {
      where: { id: serverId },
      data: { bannerUrl: 'upload://banner.webp' },
    },
  ]);
});
