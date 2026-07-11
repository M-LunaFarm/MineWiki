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
          stats: { rankCurrent: 2, rankDelta24h: 3, rankBest: 1 },
        },
      ],
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const [server] = await service.list();

  assert.deepEqual(server.rank, { current: 2, delta24h: 3, best: 1 });
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
