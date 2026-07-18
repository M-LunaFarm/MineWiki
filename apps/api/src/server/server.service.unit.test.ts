import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { hashContent } from '@minewiki/wiki-core';
import { buildOrder, downsamplePingSamples, ServerService } from './server.service';
import { buildServerWikiMainPage, buildServerWikiStarterPages } from './server-wiki-scaffold';

test('server stats downsampling preserves the seven-day range endpoints', () => {
  const samples = Array.from({ length: 901 }, (_, index) => index);
  const downsampled = downsamplePingSamples(samples, 96);

  assert.equal(downsampled.length, 96);
  assert.equal(downsampled[0], 0);
  assert.equal(downsampled[downsampled.length - 1], 900);
  assert.equal(new Set(downsampled).size, downsampled.length);
});

test('server profile updates sync linked wiki identity and write a bounded audit summary', async () => {
  const serverId = randomUUID();
  const actorAccountId = randomUUID();
  const now = new Date('2026-07-17T00:00:00.000Z');
  const wikiUpdates: Array<Record<string, unknown>> = [];
  const audits: Array<Record<string, unknown>> = [];
  const current = {
    id: serverId,
    shortCode: 'profile',
    wikiSpaceId: 3n,
    wikiPageId: 4n,
    wikiSlug: 'profile-server',
    name: 'Before Server',
    joinHost: 'play.example.test',
    joinPort: 25565,
    edition: 'java' as const,
    supportedVersions: ['1.21'],
    tags: ['survival'],
    shortDescription: 'Before summary',
    longDescription: 'Before body',
    bannerUrl: null,
    websiteUrl: null,
    discordUrl: null,
    voteCooldownHours: 24,
    verificationGrade: 'Unverified' as const,
    verifiedAt: null,
    votes24h: 0,
    votesMonthly: 0,
    reviewsCount: 0,
    voteRequiresOwnership: false,
    createdAt: now,
    updatedAt: now,
    playersOnline: null,
    playersMax: null,
    playersLastUpdatedAt: null,
    isOnline: null,
    latencyMs: null,
  };
  const prisma = {
    async $transaction(callback: (tx: unknown) => Promise<unknown>) {
      return callback(prisma);
    },
    server: {
      async update({ data }: { data: Record<string, unknown> }) {
        return { ...current, ...data };
      },
    },
    serverWiki: {
      async updateMany(input: Record<string, unknown>) {
        wikiUpdates.push(input);
        return { count: 1 };
      },
    },
  };
  const events = {
    async audit(_name: string, input: Record<string, unknown>) {
      audits.push(input);
    },
  };
  const service = new ServerService(
    {} as never,
    prisma as never,
    {} as never,
    undefined,
    events as never,
  );
  const updated = await service.updateProfile(serverId, {
    name: 'After Server',
    tags: ['survival', 'economy'],
    shortDescription: 'After summary',
    longDescription: 'After body with practical joining information.',
    websiteUrl: 'https://example.test',
    discordUrl: null,
  }, actorAccountId);

  assert.equal(updated.name, 'After Server');
  assert.equal(updated.longDescription, 'After body with practical joining information.');
  assert.deepEqual(wikiUpdates[0]?.where, { voteServerId: serverId });
  const wikiData = wikiUpdates[0]?.data as { serverName: string; updatedAt: Date };
  assert.equal(wikiData.serverName, 'After Server');
  assert.ok(wikiData.updatedAt instanceof Date);
  assert.deepEqual(audits[0]?.metadata, {
    name: 'After Server',
    tagCount: 2,
    hasWebsite: true,
    hasDiscord: false,
  });
});

test('server detail hides a stale cross-brand wiki link', async () => {
  const now = new Date('2026-07-17T00:00:00.000Z');
  const server = {
    id: randomUUID(),
    listingStatus: 'active' as const,
    ownerAccountId: null,
    registrantAccountId: null,
    shortCode: 'foreign',
    wikiSpaceId: 3n,
    wikiPageId: 4n,
    wikiSlug: 'foreign-docs',
    name: 'MineWiki Server',
    joinHost: 'play.minewiki.test',
    joinPort: 25565,
    edition: 'java' as const,
    supportedVersions: ['1.21'],
    tags: ['survival'],
    shortDescription: 'MineWiki server',
    longDescription: 'MineWiki server details',
    bannerUrl: null,
    websiteUrl: null,
    discordUrl: null,
    voteCooldownHours: 24,
    verificationGrade: 'Unverified' as const,
    verifiedAt: null,
    votes24h: 0,
    votesMonthly: 0,
    reviewsCount: 0,
    voteRequiresOwnership: false,
    createdAt: now,
    updatedAt: now,
    playersOnline: null,
    playersMax: null,
    playersLastUpdatedAt: null,
    isOnline: null,
    latencyMs: null,
    stats: null,
  };
  const prisma = {
    server: { async findUnique() { return server; } },
    serverClaimMethod: { async findMany() { return []; } },
    serverWiki: {
      async findUnique() {
        return {
          id: 9n,
          voteServerId: server.id,
          spaceId: server.wikiSpaceId,
          slug: server.wikiSlug,
          status: 'active',
          serverName: 'Unrelated Brand',
          host: 'play.unrelated.test',
        };
      },
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const detail = await service.detail(server.id);

  assert.equal(detail.wikiSpaceId, null);
  assert.equal(detail.wikiPageId, null);
  assert.equal(detail.wikiSlug, null);
  assert.equal(detail.wikiUrl, null);
});

test('server wiki readiness points owners to the first incomplete factual document', async () => {
  const server = {
    id: randomUUID(),
    wikiSpaceId: 10n,
    wikiPageId: 1n,
    wikiSlug: 'server-one',
    name: 'Server One',
    joinHost: 'play.server-one.test',
    joinPort: 25565,
    edition: 'java',
    supportedVersions: ['1.21'],
    tags: ['survival'],
    shortDescription: 'A factual server summary',
    longDescription: 'This owner-provided introduction is intentionally long enough to satisfy the server wiki readiness check with factual information.',
    websiteUrl: 'https://server-one.test',
    discordUrl: null,
  };
  const serverWiki = {
    id: 20n,
    voteServerId: server.id,
    spaceId: 10n,
    slug: 'server-one',
    siteSlug: 'server-one-docs',
    status: 'active',
    serverName: server.name,
    host: server.joinHost,
  };
  const documents = [
    { path: serverWiki.slug, contentRaw: buildServerWikiMainPage(server) },
    ...buildServerWikiStarterPages(server).map((page) => ({
      path: `${serverWiki.slug}/${page.path}`,
      contentRaw: page.contentRaw,
    })),
  ];
  const pages = documents.map((document, index) => ({
    localPath: document.path,
    currentRevisionId: BigInt(index + 1),
    searchDocument: { revisionId: BigInt(index + 1) },
  }));
  const prisma = {
    server: { async findUnique() { return server; } },
    serverWiki: { async findUnique() { return serverWiki; } },
    wikiPage: { async findMany() { return pages; } },
    wikiPageRevision: {
      async findMany() {
        return documents.map((document, index) => ({
          id: BigInt(index + 1),
          contentHash: hashContent(document.contentRaw),
        }));
      },
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const readiness = await service.getServerWikiReadiness(server.id);

  assert.equal(readiness.status, 'needs_attention');
  assert.equal(readiness.checks.officialRules, false);
  assert.equal(readiness.checks.requiredDocuments, true);
  assert.equal(readiness.checks.searchIndex, true);
  assert.deepEqual(readiness.nextAction, {
    code: 'write_rules',
    label: '공식 규칙 작성하기',
    href: '/serverWiki/server-one-docs/_tools/edit/%EA%B7%9C%EC%B9%99',
  });
});

test('server wiki public slug is tenant-owned, validated, and audited independently of content paths', async () => {
  let storedSiteSlug: string | null = 'old-docs';
  const audits: Array<Record<string, unknown>> = [];
  const prisma = {
    serverWiki: {
      async findUnique() { return { id: 9n, siteSlug: storedSiteSlug }; },
      async update({ data }: { data: { siteSlug: string } }) {
        storedSiteSlug = data.siteSlug;
        return { id: 9n, siteSlug: storedSiteSlug };
      },
    },
  };
  const events = { async audit(_name: string, input: Record<string, unknown>) { audits.push(input); } };
  const service = new ServerService({} as never, prisma as never, {} as never, undefined, events as never);

  const result = await service.updateWikiSiteSlug(randomUUID(), 'Luna-Farm', randomUUID());

  assert.deepEqual(result, { siteSlug: 'luna-farm', wikiUrl: '/serverWiki/luna-farm' });
  assert.equal(storedSiteSlug, 'luna-farm');
  assert.equal(audits.length, 1);
  await assert.rejects(() => service.updateWikiSiteSlug(randomUUID(), 'api'), /예약된 사이트 주소/u);
  await assert.rejects(() => service.updateWikiSiteSlug(randomUUID(), 'bad_slug'), /3~63자/u);
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

test('default vote ranking uses the same tie breakers as the rank aggregator', () => {
  assert.deepEqual(buildOrder('votes24h_desc'), [
    { votes24h: 'desc' },
    { stats: { votesLast7d: 'desc' } },
    { reviewsCount: 'desc' },
    { name: 'asc' },
  ]);
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

test('server list conceals the unranked sentinel even when historical vote totals remain', async () => {
  const serverId = randomUUID();
  const calculatedAt = new Date('2026-07-17T00:45:00.000Z');
  const prisma = {
    server: {
      findMany: async () => [
        {
          id: serverId,
          name: 'Unranked Historical Server',
          joinHost: 'zero.example.com',
          joinPort: 25565,
          edition: 'java',
          supportedVersions: ['1.21'],
          tags: [],
          shortDescription: 'Aggregated zero-vote server',
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
            rankCurrent: 0,
            rankDelta24h: 0,
            rankBest: 0,
            votesTotal: 1,
            rankCalculatedAt: calculatedAt,
            lastUpdatedAt: calculatedAt,
          },
        },
      ],
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const [server] = await service.list();

  assert.equal(server.rank, null);
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

test('server wiki settings downgrade an expired persisted premium layout to Docs', async () => {
  const prisma = {
    serverWiki: {
      async findUnique() {
        return { id: 5n, layoutKey: 'brand', layoutUpdatedAt: new Date('2026-07-01T00:00:00.000Z') };
      },
    },
    serverWikiLayoutEntitlement: {
      async findMany() {
        return [{
          layoutKey: 'brand',
          status: 'active',
          startsAt: new Date('2026-06-01T00:00:00.000Z'),
          expiresAt: new Date('2026-06-30T00:00:00.000Z'),
          source: 'manual',
        }];
      },
    },
  };
  const settings = await new ServerService({} as never, prisma as never, {} as never)
    .getWikiLayoutSettings(randomUUID());

  assert.equal(settings.selected, 'docs');
  assert.equal(settings.layouts.find((layout) => layout.key === 'brand')?.entitled, false);
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

test('server wiki settings use optimistic versioning and increment policy version only for policy changes', async () => {
  const current = {
    id: 5n,
    slug: 'sample-server',
    contributionPolicySource: '기존 정책',
    editHelpSource: null,
    topNoticeSource: null,
    bottomNoticeSource: null,
    requireContributionPolicyAck: true,
    contributionPolicyVersion: 2,
    contentSettingsVersion: 4,
    contentSettingsUpdatedAt: null as Date | null,
    contentSettingsUpdatedBy: null as bigint | null,
  };
  const auditEvents: Array<Record<string, unknown>> = [];
  const serverWiki = {
    async findUnique() { return { ...current }; },
    async updateMany({ where, data }: { where: { contentSettingsVersion: number }; data: Record<string, unknown> }) {
      if (where.contentSettingsVersion !== current.contentSettingsVersion) return { count: 0 };
      current.editHelpSource = data.editHelpSource as string | null;
      current.contentSettingsVersion += 1;
      current.contentSettingsUpdatedAt = data.contentSettingsUpdatedAt as Date;
      current.contentSettingsUpdatedBy = data.contentSettingsUpdatedBy as bigint;
      return { count: 1 };
    },
    async findUniqueOrThrow() { return { ...current }; },
  };
  const prisma = {
    serverWiki,
    async $transaction(callback: (tx: { serverWiki: typeof serverWiki }) => Promise<unknown>) {
      return callback({ serverWiki });
    },
  };
  const service = new ServerService(
    {} as never,
    prisma as never,
    { async ensureWikiProfile() { return { id: 9n }; } } as never,
    undefined,
    { async audit(_action: string, input: Record<string, unknown>) { auditEvents.push(input); } } as never,
  );

  const result = await service.updateWikiContentSettings(randomUUID(), {
    expectedVersion: 4,
    contributionPolicySource: '기존 정책',
    editHelpSource: '새 도움말',
    topNoticeSource: null,
    bottomNoticeSource: null,
    requireContributionPolicyAck: true,
  }, randomUUID());

  assert.equal(result.version, 5);
  assert.equal(result.contributionPolicyVersion, 2);
  assert.equal(auditEvents.length, 1);
  assert.equal(
    JSON.stringify(auditEvents, (_key, value) => typeof value === 'bigint' ? value.toString() : value)
      .includes('새 도움말'),
    false,
  );
});

test('server wiki settings reject a stale expected version', async () => {
  const service = new ServerService(
    {} as never,
    {
      serverWiki: {
        async findUnique() {
          return {
            id: 5n,
            slug: 'sample-server',
            contributionPolicySource: null,
            editHelpSource: null,
            topNoticeSource: null,
            bottomNoticeSource: null,
            requireContributionPolicyAck: false,
            contributionPolicyVersion: 0,
            contentSettingsVersion: 8,
          };
        },
      },
    } as never,
    {} as never,
  );

  await assert.rejects(
    () => service.updateWikiContentSettings(randomUUID(), {
      expectedVersion: 7,
      contributionPolicySource: null,
      editHelpSource: null,
      topNoticeSource: null,
      bottomNoticeSource: null,
      requireContributionPolicyAck: false,
    }, randomUUID()),
    /다른 관리자가 서버 위키 설정을 먼저 변경했습니다/u,
  );
});

test('server wiki navigation persists versioned groups with optimistic concurrency and audit metadata', async () => {
  const serverId = randomUUID();
  const actorAccountId = randomUUID();
  const current = {
    id: 5n,
    spaceId: 41n,
    slug: 'sample-server',
    siteSlug: 'sample',
    navigationOrder: null as Prisma.JsonValue | null,
    navigationVersion: 0,
    navigationUpdatedAt: null as Date | null,
    navigationUpdatedBy: null as bigint | null,
  };
  const pages = [
    { id: 10n, title: 'sample-server', localPath: '대문', displayTitle: '샘플 서버', status: 'normal' },
    { id: 11n, title: 'sample-server/규칙', localPath: '규칙', displayTitle: '규칙', status: 'normal' },
  ];
  const audits: Array<Record<string, unknown>> = [];
  const serverWiki = {
    async findUnique() { return { ...current }; },
    async updateMany({ where, data }: { where: { navigationVersion: number }; data: Record<string, unknown> }) {
      if (where.navigationVersion !== current.navigationVersion) return { count: 0 };
      current.navigationOrder = data.navigationOrder as Prisma.JsonValue;
      current.navigationVersion += 1;
      current.navigationUpdatedAt = data.navigationUpdatedAt as Date;
      current.navigationUpdatedBy = data.navigationUpdatedBy as bigint;
      return { count: 1 };
    },
    async findUniqueOrThrow() { return { ...current }; },
  };
  const prisma = {
    serverWiki,
    wikiPage: { async findMany() { return pages; } },
    async $transaction(callback: (tx: { serverWiki: typeof serverWiki }) => Promise<unknown>) {
      return callback({ serverWiki });
    },
  };
  const service = new ServerService(
    {} as never,
    prisma as never,
    { async ensureWikiProfile() { return { id: 9n }; } } as never,
    undefined,
    { async audit(action: string, input: Record<string, unknown>) { audits.push({ action, ...input }); } } as never,
  );
  const document = {
    version: 1 as const,
    nodes: [
      { id: 'page:10', kind: 'page' as const, pageId: '10', parentId: null },
      { id: 'group:rules', kind: 'group' as const, title: '운영 안내', parentId: 'page:10' },
      { id: 'page:11', kind: 'page' as const, pageId: '11', parentId: 'group:rules' },
    ],
  };

  const result = await service.updateWikiNavigationSettings(serverId, 0, document, actorAccountId);

  assert.equal(result.version, 1);
  assert.deepEqual(result.items.map((item) => [item.kind, item.title, item.depth]), [
    ['page', '샘플 서버', 0],
    ['group', '운영 안내', 1],
    ['page', '규칙', 2],
  ]);
  assert.equal(result.items[2]?.kind === 'page' ? result.items[2].path : null, '/serverWiki/sample/%EA%B7%9C%EC%B9%99');
  assert.deepEqual(audits[0]?.metadata, { previousVersion: 0, version: 1, pageCount: 2, groupCount: 1 });
  await assert.rejects(
    () => service.updateWikiNavigationSettings(serverId, 0, document, actorAccountId),
    /다른 관리자가 서버 위키 문서 구조를 먼저 변경했습니다/u,
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
      votesTotal: 300,
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
    $transaction: async (operation: ((store: unknown) => Promise<unknown>) | Promise<unknown>[]) =>
      typeof operation === 'function' ? operation(prisma) : Promise.all(operation),
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
  assert.equal(result.rankEpoch, '2026-07-11T00:45:00.000Z');
  assert.equal(result.rankStatus, 'ready');
  assert.equal(result.unrankedCount, 0);
  assert.equal(result.items[0]?.rank?.updatedAt, '2026-07-11T00:45:00.000Z');
  assert.equal(result.items[0]?.rank?.current, 2);
  assert.equal(queries.length, 7);
  assert.deepEqual((queries[1] as { skip: number; take: number }).skip, 12);
  assert.deepEqual((queries[1] as { skip: number; take: number }).take, 12);
  assert.deepEqual((queries[1] as { orderBy: unknown }).orderBy, [
    { isOnline: { sort: 'desc', nulls: 'last' } },
    { playersMetricTrust: 'asc' },
    { playersOnline: { sort: 'desc', nulls: 'last' } },
    { name: 'asc' },
  ]);
  assert.deepEqual(
    (queries[1] as { where: { tags: unknown } }).where.tags,
    { array_contains: ['survival'] },
  );
  assert.equal((queries[1] as { where: { isOnline: unknown } }).where.isOnline, true);
  assert.equal((queries[1] as { where: { listingStatus: unknown } }).where.listingStatus, 'active');
});

test('canonical rankings read one completed epoch and reject stale continuation pages', async () => {
  const epoch = new Date('2026-07-18T04:00:00.000Z');
  const findQueries: Array<Record<string, unknown>> = [];
  const prisma = {
    server: {
      findMany: async (query: Record<string, unknown>) => {
        findQueries.push(query);
        return [];
      },
      count: async ({ where }: { where: { AND?: unknown } }) => where.AND ? 2 : 10,
      aggregate: async () => ({ _sum: { votes24h: 12 } }),
    },
    serverStats: {
      aggregate: async () => ({ _max: { rankCalculatedAt: epoch } }),
    },
    $transaction: async (operation: (store: unknown) => Promise<unknown>) => operation(prisma),
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  const result = await service.rankings({
    sort: 'votes24h_desc',
    page: 2,
    pageSize: 6,
    rankEpoch: epoch.toISOString(),
  });

  assert.equal(result.rankEpoch, epoch.toISOString());
  assert.equal(result.unrankedCount, 8);
  assert.deepEqual(findQueries[0]?.orderBy, [
    { stats: { rankCurrent: 'asc' } },
    { name: 'asc' },
  ]);
  assert.deepEqual(
    (findQueries[0]?.where as { AND: unknown[] }).AND[1],
    { stats: { is: { rankCalculatedAt: epoch, rankCurrent: { gt: 0 } } } },
  );

  await assert.rejects(
    () => service.rankings({
      sort: 'votes24h_desc',
      page: 3,
      pageSize: 6,
      rankEpoch: '2026-07-18T03:00:00.000Z',
    }),
    /ranking snapshot changed/i,
  );
});

test('public server list includes only active listings', async () => {
  let query: unknown;
  const prisma = {
    server: {
      findMany: async (input: unknown) => {
        query = input;
        return [];
      },
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);

  assert.deepEqual(await service.list(), []);
  assert.equal(
    (query as { where: { listingStatus: unknown } }).where.listingStatus,
    'active',
  );
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

function createServerWikiLinkFixture(input: {
  readonly actorAccountId: string;
  readonly serverOwnerAccountId: string;
  readonly targetOwnerAccountId: string;
  readonly targetVoteServerId?: string | null;
  readonly actorOwnsServer?: boolean;
  readonly duplicateTargetSpaceRow?: boolean;
  readonly failAudit?: boolean;
}) {
  const serverId = randomUUID();
  const targetWikiId = 71n;
  const targetSpaceId = 72n;
  const targetPageId = 73n;
  const canonicalAccountId = randomUUID();
  const accounts = new Map([
    [input.actorAccountId, {
      id: input.actorAccountId,
      canonicalAccountId: input.actorOwnsServer === false ? input.actorAccountId : canonicalAccountId,
      lifecycleStatus: 'active',
    }],
    [input.serverOwnerAccountId, {
      id: input.serverOwnerAccountId,
      canonicalAccountId,
      lifecycleStatus: 'active',
    }],
    [input.targetOwnerAccountId, {
      id: input.targetOwnerAccountId,
      canonicalAccountId: input.targetOwnerAccountId === input.serverOwnerAccountId
        ? canonicalAccountId
        : input.targetOwnerAccountId,
      lifecycleStatus: 'active',
    }],
    [canonicalAccountId, {
      id: canonicalAccountId,
      canonicalAccountId,
      lifecycleStatus: 'active',
    }],
  ]);
  const server = {
    id: serverId,
    ownerAccountId: input.serverOwnerAccountId,
    wikiSpaceId: null,
    wikiPageId: null,
    wikiSlug: null,
    name: 'Tenant A',
    joinHost: 'tenant-a.example.com',
    joinPort: 25565,
    edition: 'java',
  };
  const serverWiki = {
    id: targetWikiId,
    spaceId: targetSpaceId,
    voteServerId: input.targetVoteServerId ?? null,
    slug: 'tenant-b-wiki',
    status: 'active',
  };
  const updatedServerWikis: unknown[] = [];
  const updatedServers: unknown[] = [];
  const audits: Array<Record<string, unknown>> = [];
  const outsideAudits: unknown[] = [];
  const tx = {
    $queryRaw: async () => [],
    server: {
      findUnique: async () => ({ ...server }),
      findFirst: async () => null,
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(server, data);
        updatedServers.push(data);
        return { ...server };
      },
    },
    serverWiki: {
      findFirst: async () => ({ ...serverWiki }),
      findUnique: async ({ where }: { where: { id?: bigint; voteServerId?: string } }) => {
        if (where.voteServerId) {
          return serverWiki.voteServerId === where.voteServerId ? { ...serverWiki } : null;
        }
        return where.id === serverWiki.id ? { ...serverWiki } : null;
      },
      findUniqueOrThrow: async () => ({ ...serverWiki }),
      findMany: async () => input.duplicateTargetSpaceRow
        ? [{ id: serverWiki.id }, { id: serverWiki.id + 1n }]
        : [{ id: serverWiki.id }],
      update: async ({ data }: { data: Record<string, unknown> }) => {
        Object.assign(serverWiki, data);
        updatedServerWikis.push(data);
        return { ...serverWiki };
      },
      updateMany: async ({ where, data }: {
        where: { id: bigint; OR: Array<{ voteServerId: string | null }> };
        data: Record<string, unknown>;
      }) => {
        const expected = where.OR.map((candidate) => candidate.voteServerId);
        if (where.id !== serverWiki.id || !expected.includes(serverWiki.voteServerId)) {
          return { count: 0 };
        }
        Object.assign(serverWiki, data);
        updatedServerWikis.push(data);
        return { count: 1 };
      },
    },
    wikiSpace: {
      findUnique: async () => ({
        id: targetSpaceId,
        rootPageId: targetPageId,
        ownerUserId: 91n,
        status: 'active',
        spaceType: 'server_wiki',
        slug: serverWiki.slug,
      }),
    },
    wikiPage: {
      findUnique: async () => ({ id: targetPageId, spaceId: targetSpaceId }),
      findFirst: async () => ({ id: targetPageId, spaceId: targetSpaceId }),
    },
    wikiProfile: {
      findUnique: async () => ({
        id: 91n,
        accountId: input.targetOwnerAccountId,
        status: 'active',
      }),
    },
    account: {
      findUnique: async ({ where }: { where: { id: string } }) => accounts.get(where.id) ?? null,
    },
    auditEvent: {
      create: async ({ data }: { data: Record<string, unknown> }) => {
        if (input.failAudit) throw new Error('audit write failed');
        audits.push(data);
        return { id: randomUUID(), ...data };
      },
    },
  };
  const prisma = {
    server: {
      findUnique: async () => ({ ...server }),
    },
    serverWiki: {
      findFirst: async () => ({ ...serverWiki, voteServerId: null }),
    },
    $transaction: async <T>(
      callback: (client: typeof tx) => Promise<T>,
      options?: { isolationLevel: string },
    ) => {
      assert.equal(options?.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      const serverBefore = { ...server };
      const serverWikiBefore = { ...serverWiki };
      const updatedServersLength = updatedServers.length;
      const updatedServerWikisLength = updatedServerWikis.length;
      const auditsLength = audits.length;
      try {
        return await callback(tx);
      } catch (error) {
        restoreObject(server, serverBefore);
        restoreObject(serverWiki, serverWikiBefore);
        updatedServers.length = updatedServersLength;
        updatedServerWikis.length = updatedServerWikisLength;
        audits.length = auditsLength;
        throw error;
      }
    },
  };
  return {
    serverId,
    targetWikiId,
    canonicalAccountId,
    service: new ServerService(
      {} as never,
      prisma as never,
      {} as never,
      undefined,
      { async audit(...args: unknown[]) { outsideAudits.push(args); } } as never,
    ),
    updatedServerWikis,
    updatedServers,
    audits,
    outsideAudits,
    server,
    serverWiki,
  };
}

function restoreObject<T extends object>(target: T, snapshot: T): void {
  for (const key of Object.keys(target)) {
    if (!(key in snapshot)) delete (target as Record<string, unknown>)[key];
  }
  Object.assign(target, snapshot);
}

test('server wiki link rejects a target owned by another canonical account', async () => {
  const actorAccountId = randomUUID();
  const fixture = createServerWikiLinkFixture({
    actorAccountId,
    serverOwnerAccountId: randomUUID(),
    targetOwnerAccountId: randomUUID(),
  });

  await assert.rejects(
    () => fixture.service.linkServerWiki(
      fixture.serverId,
      { serverWikiId: fixture.targetWikiId.toString() },
      actorAccountId,
    ),
    /target.*wiki|대상 서버 위키/u,
  );
  assert.equal(fixture.updatedServerWikis.length, 0);
  assert.equal(fixture.updatedServers.length, 0);
});

test('server wiki link rejects a target claimed concurrently by another server', async () => {
  const actorAccountId = randomUUID();
  const ownerAccountId = randomUUID();
  const fixture = createServerWikiLinkFixture({
    actorAccountId,
    serverOwnerAccountId: ownerAccountId,
    targetOwnerAccountId: ownerAccountId,
    targetVoteServerId: randomUUID(),
  });

  await assert.rejects(
    () => fixture.service.linkServerWiki(
      fixture.serverId,
      { serverWikiId: fixture.targetWikiId.toString() },
      actorAccountId,
    ),
    /already linked|이미 다른 서버/u,
  );
  assert.equal(fixture.updatedServerWikis.length, 0);
  assert.equal(fixture.updatedServers.length, 0);
});

test('server wiki link fails closed when a space has duplicate server-wiki rows', async () => {
  const actorAccountId = randomUUID();
  const ownerAccountId = randomUUID();
  const fixture = createServerWikiLinkFixture({
    actorAccountId,
    serverOwnerAccountId: ownerAccountId,
    targetOwnerAccountId: ownerAccountId,
    duplicateTargetSpaceRow: true,
  });

  await assert.rejects(
    () => fixture.service.linkServerWiki(
      fixture.serverId,
      { spaceId: '72' },
      actorAccountId,
    ),
    /ambiguous linkage/u,
  );
  assert.equal(fixture.updatedServerWikis.length, 0);
  assert.equal(fixture.updatedServers.length, 0);
});

test('server wiki link rechecks canonical server ownership inside the transaction', async () => {
  const actorAccountId = randomUUID();
  const ownerAccountId = randomUUID();
  const fixture = createServerWikiLinkFixture({
    actorAccountId,
    serverOwnerAccountId: ownerAccountId,
    targetOwnerAccountId: ownerAccountId,
    actorOwnsServer: false,
  });

  await assert.rejects(
    () => fixture.service.linkServerWiki(
      fixture.serverId,
      { serverWikiId: fixture.targetWikiId.toString() },
      actorAccountId,
    ),
    /canonical server owner/u,
  );
  assert.equal(fixture.updatedServerWikis.length, 0);
  assert.equal(fixture.updatedServers.length, 0);
});

test('server wiki link preserves the explicit global-admin break-glass path', async () => {
  const actorAccountId = randomUUID();
  const fixture = createServerWikiLinkFixture({
    actorAccountId,
    serverOwnerAccountId: randomUUID(),
    targetOwnerAccountId: randomUUID(),
  });

  const result = await fixture.service.linkServerWiki(
    fixture.serverId,
    { serverWikiId: fixture.targetWikiId.toString() },
    actorAccountId,
    { allowTargetAuthorityBypass: true },
  );

  assert.equal(result.serverWikiId, fixture.targetWikiId.toString());
  assert.equal(fixture.updatedServerWikis.length, 1);
  assert.equal(fixture.updatedServers.length, 1);
});

test('server wiki link rolls back both linkage writes when strict audit persistence fails', async () => {
  const actorAccountId = randomUUID();
  const ownerAccountId = randomUUID();
  const fixture = createServerWikiLinkFixture({
    actorAccountId,
    serverOwnerAccountId: ownerAccountId,
    targetOwnerAccountId: ownerAccountId,
    failAudit: true,
  });

  await assert.rejects(
    () => fixture.service.linkServerWiki(
      fixture.serverId,
      { serverWikiId: fixture.targetWikiId.toString() },
      actorAccountId,
    ),
    /audit write failed/u,
  );
  assert.equal(fixture.serverWiki.voteServerId, null);
  assert.equal(fixture.server.wikiSpaceId, null);
  assert.equal(fixture.server.wikiPageId, null);
  assert.equal(fixture.server.wikiSlug, null);
  assert.equal(fixture.updatedServerWikis.length, 0);
  assert.equal(fixture.updatedServers.length, 0);
  assert.equal(fixture.audits.length, 0);
  assert.equal(fixture.outsideAudits.length, 0);
});

test('server wiki link accepts canonical aliases when source and target ownership match', async () => {
  const actorAccountId = randomUUID();
  const ownerAccountId = randomUUID();
  const fixture = createServerWikiLinkFixture({
    actorAccountId,
    serverOwnerAccountId: ownerAccountId,
    targetOwnerAccountId: ownerAccountId,
  });

  const result = await fixture.service.linkServerWiki(
    fixture.serverId,
    { wikiSlug: 'tenant-b-wiki' },
    actorAccountId,
  );

  assert.equal(result.serverWikiId, fixture.targetWikiId.toString());
  assert.equal(fixture.updatedServerWikis.length, 1);
  assert.equal(fixture.updatedServers.length, 1);
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.actorAccountId, fixture.canonicalAccountId);
  assert.equal(fixture.audits[0]?.action, 'server.wiki.link');
  assert.equal(fixture.audits[0]?.subjectId, fixture.serverId);
  assert.deepEqual(
    Object.keys(fixture.audits[0]?.metadata as Record<string, unknown>).sort(),
    ['serverId', 'serverWikiId', 'wikiPageId', 'wikiSlug', 'wikiSpaceId'],
  );
  assert.equal(JSON.stringify(fixture.audits[0]).includes('tenant-a.example.com'), false);
  assert.equal(fixture.outsideAudits.length, 0);
});
