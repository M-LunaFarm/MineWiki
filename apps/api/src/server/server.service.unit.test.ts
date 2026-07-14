import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { downsamplePingSamples, ServerService } from './server.service';

test('server stats downsampling preserves the seven-day range endpoints', () => {
  const samples = Array.from({ length: 901 }, (_, index) => index);
  const downsampled = downsamplePingSamples(samples, 96);

  assert.equal(downsampled.length, 96);
  assert.equal(downsampled[0], 0);
  assert.equal(downsampled[downsampled.length - 1], 900);
  assert.equal(new Set(downsampled).size, downsampled.length);
});

test('registration canonicalizes endpoints and rejects disguised duplicates', async () => {
  let storedEndpointKey: string | null = null;
  let storedHost: string | null = null;
  const now = new Date('2026-07-12T00:00:00.000Z');
  const prisma = {
    server: {
      findFirst: async ({ where }: { where: { registrationEndpointKey: string } }) =>
        storedEndpointKey === where.registrationEndpointKey ? { id: 'server-existing' } : null,
      findUnique: async () => null,
      create: async ({ data }: { data: Record<string, unknown> }) => {
        storedEndpointKey = String(data.registrationEndpointKey);
        storedHost = String(data.joinHost);
        return {
          id: randomUUID(),
          shortCode: String(data.shortCode),
          wikiSpaceId: null,
          wikiPageId: null,
          wikiSlug: null,
          name: String(data.name),
          joinHost: storedHost,
          joinPort: Number(data.joinPort),
          edition: data.edition,
          supportedVersions: data.supportedVersions,
          tags: data.tags,
          shortDescription: data.shortDescription,
          longDescription: data.longDescription,
          bannerUrl: null,
          websiteUrl: null,
          discordUrl: null,
          voteCooldownHours: 24,
          verificationGrade: 'Unverified',
          verifiedAt: null,
          votes24h: 0,
          votesMonthly: 0,
          reviewsCount: 0,
          voteRequiresOwnership: false,
          playersOnline: null,
          playersMax: null,
          playersLastUpdatedAt: null,
          isOnline: null,
          latencyMs: null,
          createdAt: now,
          updatedAt: now,
        };
      },
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);
  const base = {
    name: 'Canonical Server',
    joinPort: 25565,
    edition: 'java' as const,
    supportedVersions: ['1.21.1'],
    tags: ['survival'],
    shortDescription: 'Canonical endpoint registration',
    longDescription: 'Canonical endpoint registration test.',
    websiteUrl: null,
    discordUrl: null,
    registrantAccountId: randomUUID(),
  };

  await service.register({ ...base, joinHost: ' PLAY.Example.COM. ' });
  assert.equal(storedHost, 'play.example.com');
  assert.match(storedEndpointKey ?? '', /^[a-f0-9]{64}$/u);

  await assert.rejects(
    () => service.register({ ...base, joinHost: 'play.example.com' }),
    /이미 등록되어 있습니다/,
  );

  await assert.rejects(
    () => service.register({ ...base, joinHost: '192.168.1.10', joinPort: 25566 }),
    /사설망, 루프백 또는 예약된 IP 주소/,
  );
});

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
            votesTotal: 342,
            rankCalculatedAt: new Date('2026-07-11T00:45:00.000Z'),
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
    updatedAt: '2026-07-11T00:45:00.000Z',
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
            votesTotal: 0,
            rankCalculatedAt: null,
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

test('server list preserves rank when only historical valid votes remain', async () => {
  const serverId = randomUUID();
  const prisma = {
    server: {
      findMany: async () => [
        {
          id: serverId,
          name: 'Historically Ranked Server',
          joinHost: 'history.example.com',
          joinPort: 25565,
          edition: 'java',
          supportedVersions: ['1.21'],
          tags: [],
          shortDescription: 'Historical rank',
          verificationGrade: 'Unverified',
          verifiedAt: null,
          votes24h: 0,
          votesMonthly: 0,
          reviewsCount: 1,
          voteRequiresOwnership: false,
          bannerUrl: null,
          websiteUrl: null,
          playersOnline: 0,
          playersMax: 0,
          playersLastUpdatedAt: null,
          isOnline: false,
          latencyMs: null,
          stats: {
            rankCurrent: 1,
            rankDelta24h: 0,
            rankBest: 1,
            votesTotal: 1,
            rankCalculatedAt: new Date('2026-07-12T00:45:00.000Z'),
            lastUpdatedAt: new Date('2026-07-12T01:00:00.000Z'),
          },
        },
      ],
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const [server] = await service.list();

  assert.equal(server.rank?.current, 1);
});

test('server wiki Docs layout is always included without a paid entitlement', async () => {
  const prisma = {
    serverWiki: {
      async findUnique() {
        return { id: 5n, layoutKey: 'docs', layoutUpdatedAt: null };
      }
    },
    serverWikiLayoutEntitlement: {
      async findMany() { return []; }
    }
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const settings = await service.getWikiLayoutSettings(randomUUID());

  assert.equal(settings.selected, 'docs');
  assert.equal(settings.layouts.find((layout) => layout.key === 'docs')?.entitled, true);
  assert.equal(settings.layouts.find((layout) => layout.key === 'handbook')?.entitled, false);
});

test('server wiki rejects selecting a premium layout without an active entitlement', async () => {
  const prisma = {
    serverWiki: {
      async findUnique() {
        return { id: 5n, layoutKey: 'docs', layoutUpdatedAt: null };
      }
    },
    serverWikiLayoutEntitlement: {
      async findMany() { return []; }
    }
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  await assert.rejects(
    () => service.updateWikiLayout(randomUUID(), 'brand'),
    /premium layout is not included/
  );
});

test('Votifier settings never return the stored v2 token', async () => {
  const service = new ServerService(
    {} as never,
    {
      votifierTarget: {
        findMany: async () => [
          {
            protocol: 'v2',
            host: 'vote.example.com',
            port: 8192,
            token: 'enc:v1:sensitive-token',
            publicKey: null,
          },
        ],
      },
    } as never,
    {} as never,
  );

  const [target] = await service.listVotifierTargets(randomUUID());

  assert.equal(target?.token, undefined);
  assert.equal(target?.tokenConfigured, true);
});

test('Votifier update preserves an encrypted token when no replacement is provided', async () => {
  const serverId = randomUUID();
  const created: Array<Record<string, unknown>> = [];
  const service = new ServerService(
    {} as never,
    {
      votifierTarget: {
        findMany: async () => [
          {
            protocol: 'v2',
            token: 'enc:v1:stored-token',
            createdAt: new Date(),
          },
        ],
        deleteMany: async () => ({ count: 1 }),
        createMany: async ({ data }: { data: Array<Record<string, unknown>> }) => {
          created.push(...data);
          return { count: data.length };
        },
      },
      $transaction: async (operations: Promise<unknown>[]) => Promise.all(operations),
    } as never,
    {} as never,
  );

  await service.updateVotifierTargets(serverId, [
    {
      protocol: 'v2',
      host: 'vote.example.com',
      port: 8192,
      tokenConfigured: true,
    },
  ]);

  assert.equal(created[0]?.token, 'enc:v1:stored-token');
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
      rankCalculatedAt: new Date('2026-07-11T00:45:00.000Z'),
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
        return { _max: { rankCalculatedAt: new Date('2026-07-11T00:45:00.000Z') } };
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
    sort: 'playersOnline_desc',
    page: 2,
    pageSize: 12,
  });

  assert.equal(result.total, 25);
  assert.equal(result.page, 2);
  assert.equal(result.pageSize, 12);
  assert.equal(result.totalPages, 3);
  assert.deepEqual(result.summary, { online: 25, verified: 25, votes24h: 420 });
  assert.equal(result.rankUpdatedAt, '2026-07-11T00:45:00.000Z');
  assert.equal(result.items[0]?.rank?.updatedAt, '2026-07-11T00:45:00.000Z');
  assert.equal(result.items[0]?.rank?.current, 2);
  assert.equal(queries.length, 6);
  assert.deepEqual((queries[0] as { skip: number; take: number }).skip, 12);
  assert.deepEqual((queries[0] as { skip: number; take: number }).take, 12);
  assert.deepEqual((queries[0] as { orderBy: unknown }).orderBy, [
    { isOnline: { sort: 'desc', nulls: 'last' } },
    { playersOnline: { sort: 'desc', nulls: 'last' } },
    { name: 'asc' },
  ]);
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
