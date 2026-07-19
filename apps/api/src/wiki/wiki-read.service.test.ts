import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { parseMarkup, WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
import { PUBLIC_WIKI_PAGE_STATUSES } from '@minewiki/wiki-core/page-status';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiIncludeService } from './wiki-include.service';
import {
  buildServerWikiNavigation,
  buildServerWikiPagePath,
  buildServerWikiToolPath,
  encodeWikiSearchCursor,
  makeSearchSnippet,
  parseWikiSearchCursor,
  serverWikiNavigationDepth,
  WikiReadService,
} from './wiki-read.service';
import { serverWikiIdentityConflicts } from '../server/server-wiki-identity';
import { WikiSpecialCursorCodec } from './wiki-special-cursor';
import type { WikiRoutePathResolver } from './wiki-route-path.resolver';

const specialCursorCodec = new WikiSpecialCursorCodec({
  get(name: string) { return name === 'APP_ENCRYPTION_KEY' ? 'wiki-special-read-test-secret' : undefined; },
} as never);

test('public pagecount filters revisions, ACLs, and namespaces without request-specific address context', async () => {
  const pages = [
    { id: 1n, namespaceId: 1, spaceId: 10n, title: '보호된 공개 문서', protectionLevel: 'official_only', status: 'protected', currentRevisionId: 11n },
    { id: 2n, namespaceId: 1, spaceId: 10n, title: '비공개 리비전', protectionLevel: 'open', status: 'normal', currentRevisionId: 12n },
    { id: 3n, namespaceId: 1, spaceId: 10n, title: 'ACL 차단', protectionLevel: 'open', status: 'normal', currentRevisionId: 13n },
    { id: 4n, namespaceId: 1, spaceId: 10n, title: '교차 연결', protectionLevel: 'open', status: 'normal', currentRevisionId: 14n }
  ];
  const pageQueries: unknown[] = [];
  const prisma = {
    wikiNamespace: {
      async findFirst() { return { id: 1, code: 'main' }; }
    },
    wikiPage: {
      async findMany(input: unknown) { pageQueries.push(input); return pages; }
    },
    wikiPageRevision: {
      async findMany() { return [{ id: 11n, pageId: 1n }, { id: 13n, pageId: 3n }, { id: 14n, pageId: 999n }]; }
    }
  } as unknown as PrismaService;
  let permissionInput: unknown;
  const permissions = {
    async filterReadablePages(input: { pages: typeof pages; requestIp?: string | null }) {
      permissionInput = input;
      return input.pages.filter((page) => page.id === 1n);
    }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getPublicStats('main');

  assert.equal(result.pageCount, 1);
  assert.equal(result.namespace, 'main');
  assert.equal(Number.isNaN(Date.parse(result.generatedAt)), false);
  assert.equal((permissionInput as { requestIp: string }).requestIp, '');
  assert.deepEqual((permissionInput as { pages: typeof pages }).pages.map((page) => page.id), [1n, 3n]);
  assert.deepEqual(pageQueries, [{
    where: {
      namespaceId: 1,
      status: { in: [...PUBLIC_WIKI_PAGE_STATUSES] },
      currentRevisionId: { not: null }
    },
    orderBy: { id: 'asc' },
    take: 500
  }]);
});

test('public pagecount treats an unknown namespace as thetree-compatible site-wide scope and caches it', async () => {
  let namespaceLookups = 0;
  let pageQueries = 0;
  const prisma = {
    wikiNamespace: {
      async findFirst() { namespaceLookups += 1; return null; }
    },
    wikiPage: {
      async findMany() { pageQueries += 1; return []; }
    },
    wikiPageRevision: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const permissions = { async filterReadablePages() { return []; } } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const first = await service.getPublicStats('존재하지않음');
  const second = await service.getPublicStats('다른미등록값');

  assert.equal(first.namespace, null);
  assert.deepEqual(second, first);
  assert.equal(namespaceLookups, 2);
  assert.equal(pageQueries, 1);
});

test('revision reads build an ACL actor from browser sessions while bare account IDs stay claim-free', async () => {
  const page = {
    id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'page', slug: 'page', title: 'Page', displayTitle: 'Page',
    currentRevisionId: 11n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 5n,
    createdAt: new Date(), updatedAt: new Date()
  };
  const prisma = {
    wikiProfile: {
      async findUnique() { return { id: 9n, status: 'active' }; },
      async findMany() { return []; }
    },
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: { async findMany() { return []; } },
    serverWiki: { async findFirst() { return null; } },
  } as unknown as PrismaService;
  const readInputs: Array<Record<string, unknown>> = [];
  const actorInputs: Array<{ readonly session: SessionPayload; readonly profile: { readonly id: bigint; readonly status: string } }> = [];
  const actor = {
    accountId: 'account-1', profileId: 9n, status: 'active', isElevated: true,
    groups: ['admin'], permissions: ['wiki.read.private'], requestIp: '192.0.2.44'
  };
  const permissions = {
    actorFromSession(receivedSession: SessionPayload, profile: { id: bigint; status: string }) {
      actorInputs.push({ session: receivedSession, profile });
      return actor;
    },
    async assertCanReadPage(input: Record<string, unknown>) { readInputs.push(input); },
    async assertCanUsePageAction() {}
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);
  const browserSession = {
    sessionId: 'session-1', userId: 'account-1', tokenVersion: 3, isElevated: true,
    authenticatedAt: '2026-07-16T00:00:00.000Z', groups: ['admin'],
    permissions: ['wiki.read.private'], requestIp: '192.0.2.44'
  } satisfies SessionPayload;

  await service.getRevisions('1', browserSession);
  await service.getRevisions('1', 'token-account');

  assert.deepEqual(actorInputs, [{ session: browserSession, profile: { id: 9n, status: 'active' } }]);
  assert.equal(readInputs[0]?.actor, actor);
  assert.equal(readInputs[0]?.requestIp, browserSession.requestIp);
  assert.equal(readInputs[0]?.accountId, browserSession.userId);
  assert.equal('actor' in readInputs[1]!, false);
  assert.equal('requestIp' in readInputs[1]!, false);
  assert.equal(readInputs[1]?.accountId, 'token-account');
});

test('new document templates are scoped to an explicitly readable wiki space', async () => {
  let templateQuery: unknown;
  let readableSpace: bigint | null = null;
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 9n }; } },
    wikiSpace: { async findUnique() { return { spaceType: 'server_wiki' }; } },
    documentTemplate: {
      async findMany(input: unknown) {
        templateQuery = input;
        return [{
          id: 1n, templateKey: 'server-guide', title: '서버 안내', description: null,
          templateScope: 'space', targetArea: 'wiki', defaultCategory: null, contentRaw: '본문',
        }];
      },
    },
  } as unknown as PrismaService;
  const permissions = {
    actorFromSession() { return { accountId: 'account-1', profileId: 9n, status: 'active', groups: [], permissions: [], requestIp: '' }; },
    async assertCanReadSpace(input: { spaceId: bigint }) { readableSpace = input.spaceId; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);
  const viewer = { userId: 'account-1' } as SessionPayload;

  const result = await service.getDocumentTemplates({ spaceId: '22', viewer });

  assert.equal(readableSpace, 22n);
  assert.equal(result[0]?.scope, 'space');
  assert.deepEqual((templateQuery as { where: { OR: unknown[] } }).where.OR, [
    { templateScope: 'global', spaceId: null },
    { templateScope: 'space', spaceId: 22n },
    { templateScope: 'user', createdBy: 9n, spaceId: 22n },
  ]);
  assert.deepEqual((templateQuery as { where: { targetArea: { in: string[] } } }).where.targetArea.in, ['any', 'official']);
});

test('public block history redacts private reasons and account identity while keeping a stable cursor', async () => {
  const now = new Date('2026-07-15T12:00:00.000Z');
  const events = [
    { id: 3n, targetProfileId: 11n, actorProfileId: 21n, action: 'block', previousStatus: 'active', newStatus: 'blocked', reason: 'private incident details', publicReason: '반복적인 문서 훼손', createdAt: now },
    { id: 2n, targetProfileId: 12n, actorProfileId: 21n, action: 'unblock', previousStatus: 'blocked', newStatus: 'active', reason: 'private appeal details', publicReason: null, createdAt: now }
  ];
  let receivedWhere: unknown;
  const prisma = {
    wikiUserBlockEvent: {
      async findMany(input: { where: unknown }) { receivedWhere = input.where; return events; }
    },
    wikiProfile: {
      async findMany(input: { select: Record<string, boolean> }) {
        assert.equal(input.select.accountId, undefined);
        assert.equal(input.select.email, undefined);
        return [
          { id: 11n, username: 'target', displayName: '대상 사용자' },
          { id: 21n, username: 'moderator', displayName: '관리자' }
        ];
      }
    }
  };
  const service = new WikiReadService(prisma as unknown as PrismaService, {} as WikiPermissionService);
  const result = await service.getPublicBlockHistory({ cursor: '4', limit: '1', action: 'block' });

  assert.deepEqual(receivedWhere, { id: { lt: 4n }, action: 'block' });
  assert.equal(result.items.length, 1);
  assert.equal(result.nextCursor, '3');
  assert.equal(result.items[0]?.publicReason, '반복적인 문서 훼손');
  assert.equal(result.items[0]?.target.username, 'target');
  assert.equal('reason' in (result.items[0] as unknown as Record<string, unknown>), false);
  assert.equal('accountId' in (result.items[0]?.target as unknown as Record<string, unknown>), false);
});

test('public block history validates filters and uses a privacy-safe deleted-profile fallback', async () => {
  const service = new WikiReadService({
    wikiUserBlockEvent: { async findMany() { return [{ id: 1n, targetProfileId: 99n, actorProfileId: 98n, action: 'block', publicReason: null, createdAt: new Date() }]; } },
    wikiProfile: { async findMany() { return []; } }
  } as unknown as PrismaService, {} as WikiPermissionService);

  await assert.rejects(() => service.getPublicBlockHistory({ action: 'delete' }), /action must be block or unblock/u);
  await assert.rejects(() => service.getPublicBlockHistory({ cursor: 'not-an-id' }), /unsigned integer/u);
  const result = await service.getPublicBlockHistory({});
  assert.equal(result.items[0]?.target.displayName, '탈퇴한 사용자');
  assert.equal(result.items[0]?.target.username, null);
  assert.equal(result.items[0]?.publicReason, null);
});

test('public server wiki rendering fails closed when a persisted premium layout has no current entitlement', async () => {
  let entitlementRows: Array<{
    layoutKey: string;
    status: string;
    startsAt: Date;
    expiresAt: Date | null;
  }> = [];
  let serverWikiQuery: unknown;
  const prisma = {
    serverWiki: {
      async findFirst(query: unknown) {
        serverWikiQuery = query;
        return {
          id: 5n,
          voteServerId: null,
          serverName: 'Luna',
          slug: 'luna',
          siteSlug: 'luna-docs',
          host: 'play.example.test',
          port: 25565,
          edition: 'java',
          supportedVersions: ['1.21'],
          genres: ['survival'],
          publicationStatus: 'published',
          layoutKey: 'brand',
        };
      },
    },
    serverWikiLayoutEntitlement: { async findMany() { return entitlementRows; } },
    wikiPage: { async findMany() { return []; } },
    wikiPageRevision: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const permissions = {
    async filterReadablePages({ pages }: { pages: unknown[] }) { return pages; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions) as unknown as {
    findServerWikiContext(namespace: string, spaceId: bigint, pageId: bigint, access: unknown): Promise<{
      context: { layout: string };
    } | null>;
  };

  const withoutEntitlement = await service.findServerWikiContext('server', 7n, 9n, {});
  assert.equal(withoutEntitlement?.context.layout, 'docs');
  assert.deepEqual(serverWikiQuery, {
    where: { spaceId: 7n, status: 'active' },
    select: {
      id: true,
      voteServerId: true,
      serverName: true,
      slug: true,
      siteSlug: true,
      host: true,
      port: true,
      edition: true,
      supportedVersions: true,
        genres: true,
        publicationStatus: true,
        layoutKey: true,
        navigationOrder: true,
        navigationVersion: true,
        contentSettingsVersion: true,
    },
  });

  entitlementRows = [{
    layoutKey: 'brand',
    status: 'active',
    startsAt: new Date(Date.now() - 60_000),
    expiresAt: new Date(Date.now() + 60_000),
  }];
  const entitled = await service.findServerWikiContext('server', 7n, 9n, {});
  assert.equal(entitled?.context.layout, 'brand');
});

test('server wiki identity fails closed only when both the linked name and host conflict', async () => {
  assert.equal(serverWikiIdentityConflicts(
    { serverName: ' Luna Farm ', host: 'PLAY.EXAMPLE.TEST.' },
    { name: 'luna farm', joinHost: 'play.example.test' },
  ), false);
  assert.equal(serverWikiIdentityConflicts(
    { serverName: '이전 이름', host: 'play.example.test' },
    { name: '새 이름', joinHost: 'play.example.test' },
  ), false);
  assert.equal(serverWikiIdentityConflicts(
    { serverName: '루나팜', host: 'lunaf.kr' },
    { name: 'CreeperWiki', joinHost: 'creeper.wiki' },
  ), true);

  const prisma = {
    serverWiki: {
      async findFirst() {
        return {
          id: 6n,
          voteServerId: 'ac256525-0000-0000-0000-000000000000',
          serverName: '루나팜',
          slug: '4cfjfkz-ac256525',
          siteSlug: 'lunafarm',
          host: 'lunaf.kr',
          port: 25565,
          edition: 'java',
          supportedVersions: '1.21',
          genres: 'survival',
          layoutKey: 'docs',
        };
      },
    },
    server: {
      async findUnique() {
        return {
          id: 'ac256525-0000-0000-0000-000000000000',
          shortCode: '4cfjfkz',
          wikiSpaceId: 5643n,
          wikiSlug: '4cfjfkz-ac256525',
          name: 'CreeperWiki',
          joinHost: 'creeper.wiki',
          joinPort: 25565,
          edition: 'java',
          isOnline: true,
          playersOnline: 10,
          playersMax: 100,
        };
      },
    },
    serverWikiLayoutEntitlement: { async findMany() { return []; } },
    wikiPage: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const service = new WikiReadService(prisma, {} as WikiPermissionService) as unknown as {
    findServerWikiContext(namespace: string, spaceId: bigint, pageId: bigint, access: unknown): Promise<unknown>;
  };

  await assert.rejects(
    () => service.findServerWikiContext('server', 5643n, 740n, {}),
    /Server wiki not found/u,
  );
});

test('server wiki context exposes a canonical active directory overview without leaking unsafe links', async () => {
  let listingStatus: 'active' | 'suspended' = 'active';
  let votesTotal = 1000;
  let linkedSpaceId = 5643n;
  let linkedWikiSlug = '4cfjfkz-ac256525';
  let serverQuery: { select?: Record<string, unknown> } | undefined;
  let serverQueries = 0;
  const prisma = {
    serverWiki: {
      async findFirst() {
        return {
          id: 6n,
          voteServerId: 'ac256525-0000-0000-0000-000000000000',
          serverName: '루나팜',
          slug: '4cfjfkz-ac256525',
          siteSlug: 'lunafarm',
          host: 'lunaf.kr',
          port: 25565,
          edition: 'java',
          supportedVersions: '1.21',
          genres: 'survival',
          publicationStatus: 'published',
          layoutKey: 'docs',
          navigationOrder: null,
          navigationVersion: 4,
          contentSettingsVersion: 6,
        };
      },
    },
    server: {
      async findUnique(query: { select?: Record<string, unknown> }) {
        serverQuery = query;
        serverQueries += 1;
        return {
          id: 'ac256525-0000-0000-0000-000000000000',
          shortCode: '4cfjfkz',
          wikiSpaceId: linkedSpaceId,
          wikiSlug: linkedWikiSlug,
          name: '루나팜',
          joinHost: 'lunaf.kr',
          joinPort: 25565,
          edition: 'java',
          listingStatus,
          shortDescription: '공개 서버 소개',
          tags: ['survival', 'economy', 'survival', 7],
          verificationGrade: 'A',
          votes24h: 32,
          votesMonthly: 540,
          reviewsCount: 18,
          websiteUrl: 'https://lunaf.kr/about',
          discordUrl: 'javascript:alert(1)',
          isOnline: true,
          playersOnline: 10,
          playersMax: 100,
          playersLastUpdatedAt: new Date('2026-07-19T06:30:00.000Z'),
          stats: {
            rankCurrent: 3,
            rankDelta24h: 2,
            rankBest: 1,
            votesTotal,
            rankCalculatedAt: new Date('2026-07-19T06:00:00.000Z'),
          },
        };
      },
    },
    serverWikiLayoutEntitlement: { async findMany() { return []; } },
    wikiPage: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const permissions = {
    async filterReadablePages({ pages }: { pages: unknown[] }) { return pages; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions) as unknown as {
    findServerWikiContext(namespace: string, spaceId: bigint, pageId: bigint, access: unknown): Promise<{
      directoryPath: string | null;
      context: { directoryOverview: {
        path: string;
        tags: string[];
        verificationGrade: string;
        rank: { current: number; delta24h: number; best: number; updatedAt: string } | null;
        live: { updatedAt: string | null };
        websiteUrl: string | null;
        discordUrl: string | null;
      } | null };
    }>;
  };

  const active = await service.findServerWikiContext('server', 5643n, 740n, {});
  assert.equal(active.directoryPath, '/servers/4cfjfkz');
  assert.equal(active.context.directoryOverview?.path, '/servers/4cfjfkz');
  assert.deepEqual(active.context.directoryOverview?.tags, ['survival', 'economy', 'survival']);
  assert.equal(active.context.directoryOverview?.verificationGrade, 'Verified');
  assert.deepEqual(active.context.directoryOverview?.rank, {
    current: 3,
    delta24h: 2,
    best: 1,
    updatedAt: '2026-07-19T06:00:00.000Z',
  });
  assert.equal(active.context.directoryOverview?.live.updatedAt, '2026-07-19T06:30:00.000Z');
  assert.equal(active.context.directoryOverview?.websiteUrl, 'https://lunaf.kr/about');
  assert.equal(active.context.directoryOverview?.discordUrl, null);
  assert.equal(serverQueries, 1);
  assert.deepEqual(serverQuery?.select?.stats, {
    select: {
      rankCurrent: true,
      rankDelta24h: true,
      rankBest: true,
      votesTotal: true,
      rankCalculatedAt: true,
    },
  });
  assert.equal(serverQuery?.select?.ownerAccountId, undefined);
  assert.equal(serverQuery?.select?.registrantAccountId, undefined);
  assert.equal(serverQuery?.select?.longDescription, undefined);
  assert.equal(serverQuery?.select?.reviews, undefined);
  assert.equal(serverQuery?.select?.votes, undefined);

  votesTotal = 0;
  const unranked = await service.findServerWikiContext('server', 5643n, 740n, {});
  assert.equal(unranked.context.directoryOverview?.rank, null);

  linkedSpaceId = 9999n;
  const mismatchedSpace = await service.findServerWikiContext('server', 5643n, 740n, {});
  assert.equal(mismatchedSpace.directoryPath, null);
  assert.equal(mismatchedSpace.context.directoryOverview, null);
  linkedSpaceId = 5643n;
  linkedWikiSlug = 'another-wiki';
  const mismatchedSlug = await service.findServerWikiContext('server', 5643n, 740n, {});
  assert.equal(mismatchedSlug.directoryPath, null);
  assert.equal(mismatchedSlug.context.directoryOverview, null);
  linkedWikiSlug = '4cfjfkz-ac256525';

  listingStatus = 'suspended';
  const suspended = await service.findServerWikiContext('server', 5643n, 740n, {});
  assert.equal(suspended.directoryPath, null);
  assert.equal(suspended.context.directoryOverview, null);
});

test('server wiki navigation removes the duplicated space slug', () => {
  assert.equal(buildServerWikiPagePath('luna-main', 'luna-main'), '/server/luna-main');
  assert.equal(buildServerWikiPagePath('luna-main', 'luna-main/규칙'), '/server/luna-main/%EA%B7%9C%EC%B9%99');
  assert.equal(buildServerWikiPagePath('luna-main', 'FAQ'), '/server/luna-main/FAQ');
});

test('server wiki site routes resolve the public site slug to the internal content root', async () => {
  const prisma = {
    serverWiki: {
      async findUnique() {
        return { slug: 'internal-luna-root', status: 'active' };
      },
    },
  } as unknown as PrismaService;
  const service = new WikiReadService(prisma, {} as WikiPermissionService);
  let resolved: unknown[] = [];
  (service as unknown as { getPage: (...args: unknown[]) => Promise<unknown> }).getPage = async (...args: unknown[]) => {
    resolved = args;
    return { id: '1' };
  };

  await service.getPageByPath('/serverWiki/lunafarm/%EA%B0%80%EC%9D%B4%EB%93%9C');

  assert.equal(resolved[0], 'server');
  assert.equal(resolved[1], 'internal-luna-root/가이드');
});

test('server wiki navigation derives a stable document tree depth', () => {
  assert.equal(serverWikiNavigationDepth('luna-main', 'luna-main'), 0);
  assert.equal(serverWikiNavigationDepth('luna-main', 'luna-main/시작하기'), 1);
  assert.equal(serverWikiNavigationDepth('luna-main', 'luna-main/가이드/설치'), 2);
  assert.equal(serverWikiNavigationDepth('luna-main', '운영/권한/ACL'), 3);
});

test('server wiki API deep links use the reserved tool prefix', () => {
  assert.equal(buildServerWikiToolPath('luna', 'luna', 'discuss'), '/server/luna/_tools/discuss');
  assert.equal(
    buildServerWikiToolPath('luna', 'luna/API/requests', 'discuss'),
    '/server/luna/_tools/discuss/API/requests'
  );
});

test('server wiki navigation keeps every document beyond the former 100 item cap', () => {
  const pages = Array.from({ length: 150 }, (_, index) => ({
    id: BigInt(index + 1),
    title: index === 0 ? 'luna' : `luna/guide/doc-${String(index).padStart(3, '0')}`,
    localPath: index === 0 ? 'luna' : `luna/guide/doc-${String(index).padStart(3, '0')}`,
    displayTitle: `문서 ${index}`,
  }));
  const navigation = buildServerWikiNavigation('luna', pages, 150n);
  assert.equal(navigation.length, 150);
  assert.equal(navigation[0]?.path, '/server/luna');
  assert.equal(navigation[0]?.hasChildren, true);
  assert.equal(navigation[1]?.depth, 1);
  assert.equal(navigation.at(-1)?.current, true);
});

test('released server wiki navigation reads compact rows without full-text release vectors and preserves ACL filtering', async () => {
  const nodes = Array.from({ length: 1000 }, (_, index) => ({
    nodeKey: `page:${index + 1}`,
    kind: 'page',
    pageId: BigInt(index + 1),
    parentKey: null,
    title: `문서 ${index + 1}`,
    position: index,
    depth: 0,
    hasChildren: false,
  }));
  const releasedItems = nodes.map((node) => ({
    namespaceId: 7,
    spaceId: 77n,
    pageId: node.pageId!,
    revisionId: BigInt(10_000 + Number(node.pageId)),
    localPath: `luna/page-${node.pageId}`,
    slug: `luna/page-${node.pageId}`,
    title: `luna/page-${node.pageId}`,
    displayTitle: node.title,
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 1n,
    ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-19T00:00:00.000Z'),
  }));
  let releaseItemQuery: { select?: Record<string, boolean> } | undefined;
  const prisma = {
    serverWiki: {
      async findUnique() {
        return {
          id: 8n, spaceId: 77n, slug: 'luna', siteSlug: 'luna-docs', status: 'active',
          publicationStatus: 'published', publishedReleaseId: 9n, navigationOrder: null,
          navigationVersion: 1, contentSettingsVersion: 1,
        };
      },
    },
    serverWikiReleaseNavigationNode: { async findMany() { return nodes; } },
    serverWikiRelease: { async findFirst() { return { presentationSnapshot: {} }; } },
    serverWikiReleaseItem: {
      async findMany(query: { select?: Record<string, boolean> }) {
        releaseItemQuery = query;
        return releasedItems;
      },
    },
    aclRule: { async count() { return 0; } },
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadSpace() {},
    async canPreviewServerWikiSpace() { return false; },
    async filterReadablePages({ pages }: { pages: Array<{ id: bigint }> }) {
      return pages.filter((page) => page.id !== 2n);
    },
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getServerWikiNavigation('luna');

  assert.equal(result.key, 'release:9:v1');
  assert.equal(result.cacheable, true);
  assert.equal(result.items.length, 999);
  assert.equal(result.items.some((item) => item.id === '2'), false);
  assert.equal(releaseItemQuery?.select?.searchVector, undefined);
  assert.equal(releaseItemQuery?.select?.title, true);
});

test('released page context reads bounded adjacent navigation instead of every release document', async () => {
  const releaseItemQueries: Array<{ where?: { pageId?: unknown }; select?: Record<string, boolean> }> = [];
  const navigationQueries: Array<{ take?: number; orderBy?: { position: string } }> = [];
  const releaseItem = (pageId: bigint) => ({
    namespaceId: 7,
    spaceId: 77n,
    pageId,
    revisionId: pageId + 10_000n,
    localPath: `luna/page-${pageId}`,
    slug: `luna/page-${pageId}`,
    title: `luna/page-${pageId}`,
    displayTitle: `문서 ${pageId}`,
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 1n,
    ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-19T00:00:00.000Z'),
  });
  const prisma = {
    serverWiki: {
      async findFirst() {
        return {
          id: 8n, voteServerId: null, serverName: 'Luna', slug: 'luna', siteSlug: 'luna-docs',
          host: null, port: null, edition: 'java', supportedVersions: null, genres: null,
          publicationStatus: 'published', layoutKey: 'docs', navigationOrder: null,
          navigationVersion: 4, contentSettingsVersion: 6,
        };
      },
    },
    serverWikiReleaseNavigationNode: {
      async findFirst() { return { position: 500 }; },
      async findMany(query: { take?: number; orderBy?: { position: string } }) {
        navigationQueries.push(query);
        return query.orderBy?.position === 'desc'
          ? [{ pageId: 499n, title: '이전 문서', position: 499 }]
          : [{ pageId: 501n, title: '다음 문서', position: 501 }];
      },
    },
    serverWikiReleaseItem: {
      async findMany(query: { where?: { pageId?: unknown }; select?: Record<string, boolean> }) {
        releaseItemQueries.push(query);
        const pageIds = (query.where?.pageId as { in?: bigint[] } | undefined)?.in ?? [];
        return pageIds.map(releaseItem);
      },
    },
    serverWikiLayoutEntitlement: { async findMany() { return []; } },
    serverWikiRelease: { async findFirst() { return { presentationSnapshot: {} }; } },
  } as unknown as PrismaService;
  const permissions = {
    async filterReadablePages({ pages }: { pages: Array<{ id: bigint }> }) { return pages; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions) as unknown as {
    findServerWikiContext(namespace: string, spaceId: bigint, pageId: bigint, access: unknown, releaseId: bigint): Promise<{
      context: {
        navigationKey: string;
        navigation: unknown[];
        previousDocument: { id: string } | null;
        nextDocument: { id: string } | null;
      };
    }>;
  };

  const result = await service.findServerWikiContext('server', 77n, 500n, {}, 9n);

  assert.equal(result.context.navigationKey, 'release:9:v1');
  assert.deepEqual(result.context.navigation, []);
  assert.equal(result.context.previousDocument?.id, '499');
  assert.equal(result.context.nextDocument?.id, '501');
  assert.equal(navigationQueries.length, 2);
  assert.ok(navigationQueries.every((query) => query.take === 32));
  assert.equal(releaseItemQueries.length, 2);
  assert.ok(releaseItemQueries.every((query) => query.where?.pageId !== undefined));
  assert.ok(releaseItemQueries.every((query) => query.select?.searchVector === undefined));
});

test('server wiki navigation removes a duplicated server slug from labels', () => {
  const navigation = buildServerWikiNavigation('luna', [
    { id: 1n, title: 'luna', localPath: 'luna', displayTitle: '루나 서버' },
    { id: 2n, title: 'luna/guide', localPath: 'luna/guide', displayTitle: 'luna/가이드' },
    { id: 3n, title: 'luna/guide/install', localPath: 'luna/guide/install', displayTitle: '설치' },
  ], 3n);
  assert.deepEqual(navigation.map((item) => item.title), ['루나 서버', '가이드', '설치']);
  assert.deepEqual(navigation.map((item) => item.depth), [0, 1, 2]);
});

test('server wiki navigation keeps legacy root tree labels but links canonical document identities', () => {
  const navigation = buildServerWikiNavigation('example', [
    { id: 711n, title: 'example', localPath: '대문', displayTitle: '크리퍼타운 SMP' },
    { id: 712n, title: 'example/처음 시작하기', localPath: '처음 시작하기', displayTitle: '처음 시작하기' },
  ], 711n, 'example', '/serverWiki');

  assert.equal(navigation[0]?.path, '/serverWiki/example');
  assert.equal(navigation[0]?.current, true);
  assert.equal(navigation[0]?.depth, 0);
  assert.equal(navigation[1]?.path, '/serverWiki/example/%EC%B2%98%EC%9D%8C_%EC%8B%9C%EC%9E%91%ED%95%98%EA%B8%B0');
});

test('server wiki navigation applies persisted sibling order without flattening descendants', () => {
  const navigation = buildServerWikiNavigation('luna', [
    { id: 1n, title: 'luna', localPath: '대문', displayTitle: '루나 서버' },
    { id: 2n, title: 'luna/guide', localPath: '가이드', displayTitle: '가이드' },
    { id: 3n, title: 'luna/guide/install', localPath: '가이드/설치', displayTitle: '설치' },
    { id: 4n, title: 'luna/rules', localPath: '규칙', displayTitle: '규칙' },
  ], 3n, 'luna', '/serverWiki', ['4', '3', '2', '1']);

  assert.deepEqual(navigation.map((item) => item.id), ['1', '4', '2', '3']);
  assert.deepEqual(navigation.map((item) => item.depth), [0, 1, 1, 2]);
  assert.equal(navigation[0]?.hasChildren, true);
  assert.equal(navigation[2]?.hasChildren, true);
});

test('wiki search cursor is stable and rejects tampering', () => {
  const date = new Date('2026-07-13T12:34:56.000Z');
  const cursor = encodeWikiSearchCursor(date, 42n);
  assert.deepEqual(parseWikiSearchCursor(cursor), { updatedAt: date, id: 42n });
  assert.throws(() => parseWikiSearchCursor('not-a-cursor'), /cursor is invalid/);
});

test('wiki search snippets expose readable prose instead of source markup', () => {
  const snippet = makeSearchSnippet([
    '== 관리자 목록 ==',
    '[[분류:운영]]',
    '> **안내** [관리자 메일](mailto:admin@example.kr)',
    '<table><tr><td>서버 운영 안내&#x20;</td></tr></table>',
    '![](<../assets/server logo (1) (1).png>)\\',
    '**아너** (1) (1).png>)',
  ].join('\n'), '서버', '관리자 목록');

  assert.match(snippet, /안내 관리자 메일/u);
  assert.match(snippet, /서버 운영 안내/u);
  assert.doesNotMatch(snippet, /(?:관리자 목록|\[\[|\]\]|==|<\/?(?:table|tr|td)|mailto:|\*\*|&#x20;|\.png|\\)/u);
});

test('server wiki search resolves the slug to a mandatory tenant space filter', async () => {
  const rawQueries: Array<{ sql: string; values: unknown[] }> = [];
  const prisma = {
    serverWiki: {
      async findFirst() {
        return {
          id: 99n,
          spaceId: 5643n,
          slug: '4cfjfkz-ac256525',
          siteSlug: null,
          status: 'active',
          publicationStatus: 'published',
          publishedReleaseId: 100n,
        };
      },
    },
    wikiNamespace: {
      async findUnique() { return { id: 7, code: 'server' }; },
    },
    async $queryRawUnsafe(sql: string, ...values: unknown[]) {
      rawQueries.push({ sql, values });
      return [];
    },
  } as unknown as PrismaService;

  const permissions = {
    async filterReadablePages({ pages }: { pages: unknown[] }) { return pages; },
    async canPreviewServerWikiSpace() { return true; },
  } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).search({
    q: '명령어',
    serverSlug: '4cfjfkz-ac256525',
  });

  assert.deepEqual(result, { items: [], nextCursor: null });
  assert.equal(rawQueries.length, 1);
  assert.match(rawQueries[0]!.sql, /p\.namespace_id = \?/u);
  assert.match(rawQueries[0]!.sql, /p\.space_id = \?/u);
  assert.match(rawQueries[0]!.sql, /p\.status IN \('normal', 'active', 'published', 'protected'\)/u);
  assert.equal(rawQueries[0]!.values.includes(7), true);
  assert.equal(rawQueries[0]!.values.includes(5643n), true);
});

test('public server wiki reads resolve immutable release items while collaborators keep the draft', async () => {
  let preview = false;
  const item = {
    id: 1n,
    releaseId: 70n,
    serverWikiId: 50n,
    spaceId: 40n,
    namespaceId: 7,
    pageId: 30n,
    revisionId: 20n,
    localPath: 'luna/guide',
    slug: 'luna/guide',
    title: 'luna/guide',
    displayTitle: 'Guide',
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 10n,
    ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-19T00:00:00.000Z'),
    createdAt: new Date('2026-07-19T00:00:00.000Z'),
  };
  const prisma = {
    serverWiki: {
      async findUnique() {
        return { id: 50n, spaceId: 40n, status: 'active', publicationStatus: 'published', publishedReleaseId: 70n };
      },
    },
    serverWikiReleaseItem: { async findFirst() { return item; } },
  } as unknown as PrismaService;
  const permissions = {
    async canPreviewServerWikiSpace() { return preview; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions) as unknown as {
    resolveReleasedServerWikiPage(namespace: string, namespaceId: number, title: string, access: unknown): Promise<{
      releaseId: bigint;
      revisionId: bigint;
      page: { id: bigint; currentRevisionId: bigint; localPath: string };
    } | null | undefined>;
  };

  const released = await service.resolveReleasedServerWikiPage('server', 7, 'luna/guide', {});
  assert.equal(released?.releaseId, 70n);
  assert.equal(released?.revisionId, 20n);
  assert.equal(released?.page.currentRevisionId, 20n);
  assert.equal(released?.page.localPath, 'luna/guide');

  preview = true;
  assert.equal(await service.resolveReleasedServerWikiPage('server', 7, 'luna/guide', {}), undefined);
});

test('released server wiki search matches only the snapshotted revision', async () => {
  const releaseItem = {
    id: 1n,
    releaseId: 70n,
    serverWikiId: 50n,
    spaceId: 40n,
    namespaceId: 7,
    pageId: 30n,
    revisionId: 20n,
    localPath: 'luna/guide',
    slug: 'luna/guide',
    title: 'luna/guide',
    displayTitle: '공개 가이드',
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 10n,
    ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-19T00:00:00.000Z'),
  };
  const prisma = {
    serverWikiReleaseItem: { async findMany() { return [releaseItem]; } },
    wikiPageRevision: {
      async findMany() { return [{ id: 20n, pageId: 30n, contentRaw: '공개 릴리스에만 있는 명령어 안내' }]; },
    },
  } as unknown as PrismaService;
  const permissions = {
    async filterReadablePages({ pages }: { pages: unknown[] }) { return pages; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions) as unknown as {
    searchReleasedServerWiki(input: unknown): Promise<{ items: Array<{ pageId: string; snippet: string; routePath: string }> }>;
  };
  const result = await service.searchReleasedServerWiki({
    wiki: { id: 50n, spaceId: 40n, slug: 'luna', siteSlug: 'luna-docs', publishedReleaseId: 70n },
    namespaceId: 7,
    query: '명령어',
    target: 'all',
    limit: 20,
    cursor: null,
    access: { accountId: null },
  });

  assert.equal(result.items[0]?.pageId, '30');
  assert.match(result.items[0]?.snippet ?? '', /명령어/u);
  assert.equal(result.items[0]?.routePath, '/serverWiki/luna-docs/guide');
});

test('global search and suggestions project server wikis from the active release unless the viewer can preview', async () => {
  const now = new Date('2026-07-19T03:00:00.000Z');
  const draftPage = {
    id: 30n,
    namespaceId: 7,
    spaceId: 40n,
    localPath: 'luna/draft-guide',
    slug: 'luna/draft-guide',
    title: 'luna/draft-guide',
    displayTitle: '초안 가이드',
    currentRevisionId: 21n,
    pageType: 'article',
    protectionLevel: 'open',
    status: 'normal',
    createdBy: 10n,
    ownerProfileId: null,
    createdAt: now,
    updatedAt: now,
  };
  const releaseItem = {
    id: 80n,
    releaseId: 70n,
    serverWikiId: 50n,
    spaceId: 40n,
    namespaceId: 7,
    pageId: 30n,
    revisionId: 20n,
    localPath: 'luna/public-guide',
    slug: 'luna/public-guide',
    title: 'luna/public-guide',
    displayTitle: '공개 가이드',
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 10n,
    ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-18T03:00:00.000Z'),
    searchVector: '공개 가이드 released-only-command',
    createdAt: new Date('2026-07-18T03:00:00.000Z'),
    release: { serverWiki: { slug: 'luna', siteSlug: 'luna-docs' } },
  };
  let preview = false;
  const prisma = {
    async $queryRawUnsafe(sql: string) {
      return sql.includes('server_wiki_release_items AS i') ? [{ id: releaseItem.id }] : [{ id: draftPage.id }];
    },
    wikiNamespace: {
      async findUnique() { return { id: 7, code: 'server' }; },
      async findMany() { return [{ id: 7, code: 'server' }]; },
    },
    wikiPage: { async findMany() { return [draftPage]; } },
    wikiPageRevision: {
      async findMany() {
        return [
          { id: 20n, pageId: 30n, contentRaw: '공개 본문 released-only-command' },
          { id: 21n, pageId: 30n, contentRaw: '비공개 초안 draft-only-secret' },
        ];
      },
    },
    serverWikiReleaseItem: { async findMany() { return [releaseItem]; } },
    serverWiki: {
      async findMany() { return [{ spaceId: 40n, slug: 'luna', siteSlug: 'luna-docs' }]; },
    },
  } as unknown as PrismaService;
  const permissions = {
    async canPreviewServerWikiSpace() { return preview; },
    async filterReadablePages({ pages }: { pages: unknown[] }) { return pages; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const hiddenDraft = await service.search({ q: 'draft-only-secret' });
  const publicRelease = await service.search({ q: 'released-only-command' });
  const publicSuggestions = await service.suggest({ q: '가이드' });

  assert.deepEqual(hiddenDraft.items, []);
  assert.deepEqual(publicRelease.items.map((item) => item.displayTitle), ['공개 가이드']);
  assert.equal(publicRelease.items[0]?.routePath, '/serverWiki/luna-docs/public-guide');
  assert.deepEqual(publicSuggestions.items.map((item) => item.displayTitle), ['공개 가이드']);

  preview = true;
  const visibleDraft = await service.search({ q: 'draft-only-secret' });
  const hiddenOldRelease = await service.search({ q: 'released-only-command' });
  const previewSuggestions = await service.suggest({ q: '가이드' });

  assert.deepEqual(visibleDraft.items.map((item) => item.displayTitle), ['초안 가이드']);
  assert.deepEqual(hiddenOldRelease.items, []);
  assert.deepEqual(previewSuggestions.items.map((item) => item.displayTitle), ['초안 가이드']);
});

test('wiki search batches current revisions and returns a continuation cursor', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const pages = Array.from({ length: 6 }, (_, index) => ({
    id: BigInt(10 - index), namespaceId: 1, spaceId: 1n, localPath: `doc-${index}`, slug: `doc-${index}`,
    title: `검색 문서 ${index}`, displayTitle: `검색 문서 ${index}`, currentRevisionId: BigInt(100 - index),
    pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n,
    createdAt: now, updatedAt: new Date(now.getTime() - index * 1000)
  }));
  let revisionQueryCount = 0;
  const revisionSelects: unknown[] = [];
  let currentSearchQueryCount = 0;
  const prisma = {
    async $queryRawUnsafe() {
      currentSearchQueryCount += 1;
      return pages.map((page) => ({ id: page.id }));
    },
    wikiNamespace: {
      async findUnique() { return null; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    },
    wikiPage: { async findMany() { return pages; } },
    wikiPageRevision: {
      async findMany(args: { select?: { contentRaw?: boolean } }) {
        revisionQueryCount += 1;
        revisionSelects.push(args.select);
        return args.select?.contentRaw
          ? pages.map((page) => ({ id: page.currentRevisionId, pageId: page.id, contentRaw: `본문 검색 ${page.id}` }))
          : pages.map((page) => ({ id: page.currentRevisionId, pageId: page.id, visibility: 'public' }));
      }
    }
  } as unknown as PrismaService;
  const permissions = {
    async filterReadablePages({ pages: candidates }: { pages: typeof pages }) { return [...candidates]; }
  } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).search({ q: '검색', limit: 2 });
  assert.equal(currentSearchQueryCount, 1);
  assert.equal(revisionQueryCount, 1);
  assert.equal(JSON.stringify(revisionSelects[0]).includes('contentRaw'), true);
  assert.equal(result.items.length, 2);
  assert.deepEqual(result.items[0]?.highlights.title, [[0, 2]]);
  assert.deepEqual(result.items[0]?.highlights.snippet, [[3, 2]]);
  assert.ok(result.nextCursor);
});

test('wiki search target filters distinguish title and body matches', async () => {
  const now = new Date('2026-07-16T00:00:00Z');
  const pages = [
    {
      id: 2n, namespaceId: 1, spaceId: 1n, localPath: '검색 제목', slug: '검색_제목',
      title: '검색 제목', displayTitle: '검색 제목', currentRevisionId: 12n,
      pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n,
      createdAt: now, updatedAt: now
    },
    {
      id: 1n, namespaceId: 1, spaceId: 1n, localPath: '다른 문서', slug: '다른_문서',
      title: '다른 문서', displayTitle: '다른 문서', currentRevisionId: 11n,
      pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n,
      createdAt: now, updatedAt: new Date(now.getTime() - 1000)
    }
  ];
  const bodies = new Map([[12n, '관계없는 본문'], [11n, '여기에 검색 본문이 있습니다']]);
  const rawQueries: Array<{ sql: string; values: unknown[] }> = [];
  const prisma = {
    async $queryRawUnsafe(sql: string, ...values: unknown[]) {
      rawQueries.push({ sql, values });
      return pages.map((page) => ({ id: page.id }));
    },
    wikiPage: { async findMany() { return pages; } },
    wikiNamespace: {
      async findUnique() { return null; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    },
    wikiPageRevision: {
      async findMany(input: { select?: { contentRaw?: boolean } }) {
        return input.select?.contentRaw
          ? [...bodies].map(([id, contentRaw]) => ({ id, pageId: pages.find((page) => page.currentRevisionId === id)!.id, contentRaw }))
          : [...bodies.keys()].map((id) => ({ id, pageId: pages.find((page) => page.currentRevisionId === id)!.id, visibility: 'public' }));
      }
    }
  } as unknown as PrismaService;
  const permissions = {
    async filterReadablePages({ pages: candidates }: { pages: typeof pages }) { return [...candidates]; }
  } as unknown as WikiPermissionService;

  const titleResult = await new WikiReadService(prisma, permissions).search({ q: '검색', target: 'title', spaceId: 1n });
  const contentResult = await new WikiReadService(prisma, permissions).search({ q: '검색', target: 'content' });

  assert.deepEqual(titleResult.items.map((item) => item.pageId), ['2']);
  assert.deepEqual(contentResult.items.map((item) => item.pageId), ['1']);
  assert.deepEqual(contentResult.items[0]?.highlights.snippet, [[4, 2]]);
  assert.match(rawQueries[0]!.sql, /p\.space_id = \?/u);
  assert.equal(rawQueries[0]!.values.includes(1n), true);
  await assert.rejects(
    new WikiReadService(prisma, permissions).search({ q: '검색', target: 'invalid' }),
    /target must be all, title, or content/u
  );
});

test('wiki search never uses matching historical revisions as current-document candidates', async () => {
  const now = new Date('2026-07-15T00:00:00Z');
  const currentPage = {
    id: 7n, namespaceId: 1, spaceId: 1n, localPath: 'current', slug: 'current',
    title: '현재 문서', displayTitle: '현재 문서', currentRevisionId: 70n,
    pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n,
    createdAt: now, updatedAt: now
  };
  let rawSql = '';
  const prisma = {
    async $queryRawUnsafe(sql: string) {
      rawSql = sql;
      return [{ id: currentPage.id }];
    },
    wikiNamespace: {
      async findUnique() { return null; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    },
    wikiPage: { async findMany() { return [currentPage]; } },
    wikiPageRevision: {
      async findMany(args: { select?: { contentRaw?: boolean } }) {
        return args.select?.contentRaw
          ? [{ id: 70n, pageId: 7n, contentRaw: '현재 본문 검색어' }]
          : [{ id: 70n, pageId: 7n, visibility: 'public' }];
      }
    }
  } as unknown as PrismaService;
  const permissions = {
    async filterReadablePages({ pages }: { pages: typeof currentPage[] }) { return [...pages]; }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).search({ q: '검색어' });

  assert.match(rawSql, /r\.id = p\.current_revision_id/);
  assert.match(rawSql, /sd\.revision_id = p\.current_revision_id/);
  assert.match(rawSql, /MATCH\(sd\.search_vector\) AGAINST \(\? IN BOOLEAN MODE\)/);
  assert.doesNotMatch(rawSql, /LOCATE|content_raw/);
  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.pageId, '7');
});

test('wiki search rejects oversized queries before reading the database', async () => {
  let queryCount = 0;
  const prisma = {
    async $queryRawUnsafe() { queryCount += 1; return []; }
  } as unknown as PrismaService;
  const permissions = {} as WikiPermissionService;

  await assert.rejects(
    () => new WikiReadService(prisma, permissions).search({ q: '가'.repeat(101) }),
    /q is too long/
  );
  assert.equal(queryCount, 0);
});

test('wiki suggestions rank exact and prefix title matches without reading document bodies', async () => {
  const now = new Date('2026-07-14T00:00:00Z');
  const pages = [
    { id: 2n, namespaceId: 1, spaceId: 1n, localPath: '대문 안내', slug: '대문 안내', title: '대문 안내', displayTitle: '대문 안내', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now },
    { id: 1n, namespaceId: 1, spaceId: 1n, localPath: '대문', slug: '대문', title: '대문', displayTitle: '대문', currentRevisionId: 11n, pageType: 'article', protectionLevel: 'official_only', status: 'protected', createdBy: 1n, createdAt: now, updatedAt: new Date('2025-01-01T00:00:00Z') },
    { id: 3n, namespaceId: 2, spaceId: 2n, localPath: '대문', slug: '대문', title: '대문', displayTitle: '대문', currentRevisionId: 13n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now }
  ];
  let pageQuery: unknown;
  const prisma = {
    wikiPage: { async findMany(args: unknown) { pageQuery = args; return pages; } },
    serverWikiReleaseItem: { async findMany() { return []; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }, { id: 2, code: 'help' }]; } }
  } as unknown as PrismaService;
  const permissions = {
    async filterReadablePages({ pages: candidates }: { pages: typeof pages }) { return [...candidates]; },
    async canPreviewServerWikiSpace() { return false; }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).suggest({ q: '대문', limit: 8 });

  assert.equal(result.exactMatch?.pageId, '1');
  assert.deepEqual(result.items.map((item) => item.pageId), ['1', '3', '2']);
  assert.equal(JSON.stringify(pageQuery).includes('contentRaw'), false);
  assert.deepEqual((pageQuery as { where: { status: { in: string[] } } }).where.status.in, [...PUBLIC_WIKI_PAGE_STATUSES]);
});

test('revision history uses a stable revision number cursor beyond the first page', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  let revisionWhere: unknown;
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'doc', slug: 'doc', title: '문서', displayTitle: '문서', currentRevisionId: 4n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const makeRevision = (revisionNo: number) => ({ id: BigInt(revisionNo), pageId: 1n, revisionNo, editSummary: `요약 ${revisionNo}`, editSummaryHidden: revisionNo === 3, isMinor: false, createdBy: 1n, createdAt: now, contentHash: String(revisionNo), contentSize: revisionNo });
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: { async findMany(args: { where: unknown }) { revisionWhere = args.where; return [makeRevision(4), makeRevision(3), makeRevision(2)]; } },
    wikiProfile: { async findMany() { return [{ id: 1n, displayName: 'editor' }]; } },
    serverWiki: { async findFirst() { return null; } },
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {}, async assertCanUsePageAction() {} } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).getRevisions('1', null, '5', 2);
  assert.deepEqual(revisionWhere, { pageId: 1n, visibility: 'public', revisionNo: { lt: 5 } });
  assert.deepEqual(result.items.map((item) => item.revisionNo), [4, 3]);
  assert.deepEqual(result.items.map((item) => item.previousPublicRevisionId), ['3', '2']);
  assert.deepEqual(result.items.map((item) => item.sizeDelta), [1, 1]);
  assert.deepEqual(result.items.map((item) => [item.editSummary, item.editSummaryHidden]), [['요약 4', false], [null, true]]);
  assert.equal(result.nextCursor, '3');
});

test('public server wiki history lists every distinct published revision and excludes drafts', async () => {
  const now = new Date('2026-07-19T00:00:00Z');
  const page = {
    id: 30n, namespaceId: 7, spaceId: 40n, localPath: 'luna/guide', slug: 'luna/guide',
    title: 'luna/guide', displayTitle: 'Guide', currentRevisionId: 13n, pageType: 'article',
    protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now,
  };
  const revisions = [
    { id: 13n, pageId: 30n, revisionNo: 3, editSummary: 'draft', editSummaryHidden: false, isMinor: false, createdBy: 1n, createdAt: now, contentHash: 'c', contentSize: 30, visibility: 'public' },
    { id: 12n, pageId: 30n, revisionNo: 2, editSummary: 'release two', editSummaryHidden: false, isMinor: false, createdBy: 1n, createdAt: now, contentHash: 'b', contentSize: 20, visibility: 'public' },
    { id: 11n, pageId: 30n, revisionNo: 1, editSummary: 'release one', editSummaryHidden: false, isMinor: false, createdBy: 1n, createdAt: now, contentHash: 'a', contentSize: 10, visibility: 'public' },
  ];
  const releaseItem = (releaseId: bigint, revisionId: bigint, title: string, status = 'normal') => ({
    id: releaseId,
    releaseId,
    serverWikiId: 50n,
    spaceId: 40n,
    namespaceId: 7,
    pageId: 30n,
    revisionId,
    localPath: title,
    slug: title,
    title,
    displayTitle: title,
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: status,
    createdBy: 1n,
    ownerProfileId: null,
    pageUpdatedAt: now,
    searchVector: '',
    createdAt: now,
  });
  const currentItem = releaseItem(71n, 12n, 'luna/guide');
  const historicalItem = releaseItem(70n, 11n, 'luna/old-guide');
  let revisionWhere: { id?: { in: bigint[] }; revisionNo?: { lt: number } } | null = null;
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: {
      async findMany(input: { where: { id?: { in: bigint[] }; revisionNo?: { lt: number } } }) {
        revisionWhere = input.where;
        return revisions.filter((revision) =>
          (!input.where.id || input.where.id.in.includes(revision.id))
          && (!input.where.revisionNo || revision.revisionNo < input.where.revisionNo.lt));
      },
    },
    wikiProfile: { async findMany() { return [{ id: 1n, displayName: 'Writer', username: 'writer' }]; } },
  } as unknown as PrismaService;
  const permissions = {
    async resolvePublishedRevisionScope() {
      return {
        currentItem,
        revisionItems: [currentItem, historicalItem],
      };
    },
    async assertCanReadPage() {},
    async assertCanUsePageAction() {},
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getRevisions('30');

  assert.deepEqual(result.items.map((item) => item.id), ['12', '11']);
  assert.deepEqual(result.items.map((item) => item.sizeDelta), [10, null]);
  assert.equal(revisionWhere?.id?.in.includes(13n), false);
  assert.deepEqual(revisionWhere?.id?.in, [12n, 11n]);
});

test('public server wiki history authorizes release snapshots and paginates past concealed revisions', async () => {
  const now = new Date('2026-07-19T00:00:00Z');
  const page = {
    id: 30n, namespaceId: 7, spaceId: 40n, localPath: 'live-draft', slug: 'live-draft',
    title: 'Live Draft', displayTitle: 'Live Draft', currentRevisionId: 14n, pageType: 'article',
    protectionLevel: 'owner_only', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now,
  };
  const revision = (id: bigint, revisionNo: number) => ({
    id, pageId: 30n, revisionNo, editSummary: `release ${revisionNo}`, editSummaryHidden: false,
    isMinor: false, createdBy: 1n, createdAt: now, contentHash: id.toString(),
    contentSize: revisionNo * 10, visibility: 'public',
  });
  const revisions = [revision(13n, 3), revision(12n, 2), revision(11n, 1)];
  const item = (revisionId: bigint, title: string, pageStatus = 'normal') => ({
    id: revisionId, releaseId: 70n + revisionId, serverWikiId: 50n, spaceId: 40n,
    namespaceId: 7, pageId: 30n, revisionId, localPath: title, slug: title, title,
    displayTitle: title, pageType: 'article', protectionLevel: 'open', pageStatus,
    createdBy: 1n, ownerProfileId: null, pageUpdatedAt: now, searchVector: '', createdAt: now,
  });
  const current = item(13n, 'released/current');
  const concealed = item(12n, 'released/concealed', 'hidden');
  const oldest = item(11n, 'released/oldest');
  const queriedCursors: Array<number | undefined> = [];
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: {
      async findMany(input: { where: { revisionNo?: { lt: number } }; take: number }) {
        queriedCursors.push(input.where.revisionNo?.lt);
        return revisions
          .filter((row) => !input.where.revisionNo || row.revisionNo < input.where.revisionNo.lt)
          .slice(0, input.take);
      },
    },
    wikiProfile: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const authorizedTitles: string[] = [];
  const permissions = {
    async resolvePublishedRevisionScope() {
      return { currentItem: current, revisionItems: [current, concealed, oldest] };
    },
    async assertCanReadPage(input: { page: { title: string; status: string } }) {
      authorizedTitles.push(input.page.title);
      if (input.page.status === 'hidden') throw new NotFoundException('hidden snapshot');
    },
    async assertCanUsePageAction() {},
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const first = await service.getRevisions('30', null, undefined, 1);
  assert.deepEqual(first.items.map((row) => row.id), ['13']);
  assert.equal(first.nextCursor, '3');
  const second = await service.getRevisions('30', null, first.nextCursor ?? undefined, 1);
  assert.deepEqual(second.items.map((row) => row.id), ['11']);
  assert.equal(second.nextCursor, null);
  assert.equal(authorizedTitles.includes('Live Draft'), false);
  assert.equal(authorizedTitles.includes('released/current'), true);
  assert.equal(authorizedTitles.includes('released/concealed'), true);
  assert.deepEqual(queriedCursors, [undefined, 2, 3, 1]);
});

test('page lifecycle history uses an independent id cursor and redacts cross-space identities', async () => {
  const now = new Date('2026-07-18T09:00:00Z');
  const page = { id: 1n, namespaceId: 2, spaceId: 20n, localPath: 'new', slug: 'new', title: 'New', displayTitle: 'New', currentRevisionId: 4n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  let lifecycleWhere: unknown;
  const events = [
    { id: 9n, pageId: 1n, eventType: 'restore', actorProfileId: 3n, reason: 'restore reason', sourceNamespaceId: null, sourceNamespaceCode: null, sourceSpaceId: null, sourceTitle: null, sourcePath: null, destinationNamespaceId: 2, destinationNamespaceCode: 'guide', destinationSpaceId: 20n, destinationTitle: 'New', destinationPath: 'new', createdAt: now },
    { id: 8n, pageId: 1n, eventType: 'move', actorProfileId: 3n, reason: 'private source title', sourceNamespaceId: 1, sourceNamespaceCode: 'main', sourceSpaceId: 10n, sourceTitle: 'Secret', sourcePath: 'secret', destinationNamespaceId: 2, destinationNamespaceCode: 'guide', destinationSpaceId: 20n, destinationTitle: 'New', destinationPath: 'new', createdAt: now },
    { id: 7n, pageId: 1n, eventType: 'delete', actorProfileId: null, reason: null, sourceNamespaceId: 2, sourceNamespaceCode: 'guide', sourceSpaceId: 20n, sourceTitle: 'New', sourcePath: 'new', destinationNamespaceId: null, destinationNamespaceCode: null, destinationSpaceId: null, destinationTitle: null, destinationPath: null, createdAt: now }
  ];
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageLifecycleEvent: { async findMany(args: { where: unknown }) { lifecycleWhere = args.where; return events; } },
    wikiProfile: { async findUnique() { return null; }, async findMany() { return [{ id: 3n, displayName: 'Maintainer', username: 'maintainer' }]; } }
  } as unknown as PrismaService;
  const actions: string[] = [];
  const permissions = {
    async assertCanReadPage() {},
    async assertCanUsePageAction(input: { action: string }) { actions.push(input.action); }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getPageLifecycleEvents('1', null, '10', 2);

  assert.deepEqual(lifecycleWhere, { pageId: 1n, id: { lt: 10n } });
  assert.deepEqual(actions, ['history']);
  assert.equal(result.nextCursor, '8');
  assert.equal(result.items[0]?.destination?.title, 'New');
  assert.equal(result.items[0]?.actorUsername, 'maintainer');
  assert.equal(result.items[1]?.source, null);
  assert.equal(result.items[1]?.destination?.title, 'New');
  assert.equal(result.items[1]?.reason, null);
  assert.equal(result.items[1]?.identityRedacted, true);
});

test('public server wiki lifecycle and ACL history stop at the immutable release capture', async () => {
  const capturedAt = new Date('2026-07-18T09:00:00.000Z');
  const before = new Date('2026-07-18T08:59:00.000Z');
  const after = new Date('2026-07-18T09:01:00.000Z');
  const livePage = {
    id: 1n, namespaceId: 9, spaceId: 20n, title: 'Draft Secret', protectionLevel: 'locked',
    status: 'deleted', createdBy: 1n,
  };
  const releaseItem = {
    id: 100n, releaseId: 200n, serverWikiId: 300n, spaceId: 20n, pageId: 1n,
    namespaceId: 2, localPath: 'guide', slug: 'guide', title: 'Published Guide',
    displayTitle: 'Published Guide', revisionId: 4n, pageType: 'article',
    protectionLevel: 'open', pageStatus: 'normal', createdBy: 1n, ownerProfileId: null,
    pageUpdatedAt: before,
  };
  const boundary = {
    serverWikiId: 300n, spaceId: 20n, currentReleaseId: 200n,
    currentReleaseVersion: 1, currentItem: releaseItem,
  };
  const lifecycleEvents = [
    {
      id: 11n, pageId: 1n, eventType: 'move', actorProfileId: 3n, reason: 'published move',
      sourceNamespaceId: 2, sourceNamespaceCode: 'guide', sourceSpaceId: 20n,
      sourceTitle: 'Old', sourcePath: 'old', destinationNamespaceId: 2,
      destinationNamespaceCode: 'guide', destinationSpaceId: 20n,
      destinationTitle: 'Published Guide', destinationPath: 'guide', createdAt: before,
    },
    {
      id: 12n, pageId: 1n, eventType: 'move', actorProfileId: 3n, reason: 'draft secret',
      sourceNamespaceId: 2, sourceNamespaceCode: 'guide', sourceSpaceId: 20n,
      sourceTitle: 'Published Guide', sourcePath: 'guide', destinationNamespaceId: 9,
      destinationNamespaceCode: 'dev', destinationSpaceId: 20n,
      destinationTitle: 'Draft Secret', destinationPath: 'draft-secret', createdAt: after,
    },
  ];
  const aclEvents = [
    { id: 21n, targetType: 'page', targetId: 1n, actionType: 'create', oldRuleJson: null, newRuleJson: {}, reason: 'published ACL', changedBy: 3n, createdAt: before },
    { id: 22n, targetType: 'page', targetId: 1n, actionType: 'reset', oldRuleJson: {}, newRuleJson: {}, reason: 'draft ACL', changedBy: 3n, createdAt: after },
  ];
  const lifecycleWhere: unknown[] = [];
  const aclWhere: unknown[] = [];
  const prisma = {
    wikiPage: { async findUnique() { return livePage; } },
    serverWikiRelease: {
      async findFirst(input: { where: unknown }) {
        assert.deepEqual(input.where, { id: 200n, serverWikiId: 300n });
        return { publishedAt: new Date('2026-07-18T10:00:00.000Z'), candidate: { createdAt: capturedAt } };
      },
    },
    wikiPageLifecycleEvent: {
      async findMany(input: { where: { createdAt?: { lte: Date } } }) {
        lifecycleWhere.push(input.where);
        return lifecycleEvents.filter((event) => !input.where.createdAt || event.createdAt <= input.where.createdAt.lte);
      },
    },
    aclChangeLog: {
      async findMany(input: { where: { createdAt?: { lte: Date } } }) {
        aclWhere.push(input.where);
        return aclEvents.filter((event) => !input.where.createdAt || event.createdAt <= input.where.createdAt.lte);
      },
    },
    wikiProfile: {
      async findMany() { return [{ id: 3n, displayName: 'Maintainer', username: 'maintainer' }]; },
    },
  } as unknown as PrismaService;
  const permissionPages: Array<{ title: string; status: string; proof: unknown }> = [];
  const permissions = {
    async resolvePublishedPageBoundary() { return boundary; },
    async assertCanReadPage(input: { page: { title: string; status: string }; publicationProof?: unknown }) {
      permissionPages.push({ title: input.page.title, status: input.page.status, proof: input.publicationProof });
    },
    async assertCanUsePageAction(input: { page: { title: string; status: string }; publicationProof?: unknown }) {
      permissionPages.push({ title: input.page.title, status: input.page.status, proof: input.publicationProof });
    },
    async canManagePageAcl() { return { allowed: false, reason: 'page_manager_required' }; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const [lifecycle, acl] = await Promise.all([
    service.getPageLifecycleEvents('1'),
    service.getPageAclHistoryEvents('1'),
  ]);

  assert.deepEqual(lifecycle.items.map((item) => item.reason), ['published move']);
  assert.deepEqual(acl.items.map((item) => item.actionType), ['create']);
  assert.deepEqual(lifecycleWhere, [{ pageId: 1n, createdAt: { lte: capturedAt } }]);
  assert.deepEqual(aclWhere, [{ targetType: 'page', targetId: 1n, createdAt: { lte: capturedAt } }]);
  assert.equal(permissionPages.every((entry) => entry.title === 'Published Guide'), true);
  assert.equal(permissionPages.every((entry) => entry.status === 'normal'), true);
  assert.equal(permissionPages.every((entry) => Boolean(entry.proof)), true);
});

test('deleted-page recovery hides page existence from an unrelated authenticated actor', async () => {
  const now = new Date('2026-07-19T00:00:00Z');
  let revisionsQueried = false;
  const prisma = {
    wikiPage: { async findUnique() { return { id: 1n, namespaceId: 1, spaceId: 2n, status: 'deleted', createdBy: 3n, updatedAt: now }; } },
    wikiProfile: { async findUnique() { return { id: 9n, status: 'active' }; } },
    wikiPageRevision: { async findMany() { revisionsQueried = true; return []; } }
  } as unknown as PrismaService;
  const permissions = {
    actorFromSession() { return { accountId: 'other', profileId: 9n, status: 'active' }; },
    async assertCanRestorePage() { throw new ForbiddenException('denied'); }
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  await assert.rejects(
    service.getDeletedPageRecovery({ pageId: '1', viewer: { userId: 'other' } as SessionPayload }),
    (error: unknown) => error instanceof NotFoundException
  );
  assert.equal(revisionsQueried, false);
});

test('deleted page inbox uses a stable updated-at and id cursor beyond the first hundred records', async () => {
  const firstAt = new Date('2026-07-19T02:00:00.000Z');
  const secondAt = new Date('2026-07-19T01:00:00.000Z');
  const pages = [
    { id: 30n, namespaceId: 1, spaceId: 1n, title: 'A', displayTitle: 'A', updatedAt: firstAt },
    { id: 20n, namespaceId: 1, spaceId: 1n, title: 'B', displayTitle: 'B', updatedAt: secondAt },
    { id: 10n, namespaceId: 1, spaceId: 1n, title: 'C', displayTitle: 'C', updatedAt: secondAt }
  ];
  const whereInputs: unknown[] = [];
  const prisma = {
    wikiPage: { async findMany(input: { where: unknown }) { whereInputs.push(input.where); return pages; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const service = new WikiReadService(prisma, {} as WikiPermissionService);

  const first = await service.getDeletedPages({ accountId: 'admin', profileId: 1n, includeAll: true, limit: 2 });
  assert.deepEqual(first.items.map((page) => page.id), ['30', '20']);
  assert.ok(first.nextCursor);

  await service.getDeletedPages({ accountId: 'admin', profileId: 1n, includeAll: true, limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(whereInputs[1], {
    status: 'deleted',
    AND: [{}, { OR: [{ updatedAt: { lt: secondAt } }, { updatedAt: secondAt, id: { lt: 20n } }] }]
  });
});

test('deleted-page recovery never previews a hidden or foreign source revision', async () => {
  const now = new Date('2026-07-19T00:00:00Z');
  const page = { id: 1n, namespaceId: 1, spaceId: 2n, localPath: 'deleted', slug: 'deleted', title: 'Deleted', displayTitle: 'Deleted', currentRevisionId: 10n, pageType: 'article', protectionLevel: 'open', status: 'deleted', createdBy: 3n, createdAt: now, updatedAt: now };
  const latest = { id: 10n, pageId: 1n, revisionNo: 2, parentRevisionId: 9n, contentRaw: 'latest', contentHash: 'a'.repeat(64), contentSize: 6, syntaxVersion: 'bwm-0.3', editSummary: null, editSummaryHidden: false, isMinor: false, editTags: null, contentAst: null, createdBy: 3n, actorType: 'user', actorUserId: 3n, actorIp: null, actorIpText: null, actorIpHash: null, createdAt: now, visibility: 'public' };
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiProfile: { async findUnique() { return { id: 3n, status: 'active' }; } },
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; } },
    wikiPageRevision: {
      async findMany() { return [latest]; },
      async findFirst() { return latest; },
      async findUnique() { return { ...latest, id: 11n, pageId: 99n, visibility: 'hidden' }; }
    }
  } as unknown as PrismaService;
  const permissions = {
    actorFromSession() { return { accountId: 'owner', profileId: 3n, status: 'active' }; },
    async assertCanRestorePage() {}
  } as unknown as WikiPermissionService;

  await assert.rejects(
    new WikiReadService(prisma, permissions).getDeletedPageRecovery({
      pageId: '1',
      viewer: { userId: 'owner' } as SessionPayload,
      revisionId: '11'
    }),
    (error: unknown) => error instanceof NotFoundException
  );
});

test('page ACL history keeps a stable cursor and exposes rule snapshots only to ACL managers', async () => {
  const now = new Date('2026-07-18T10:00:00Z');
  const page = { id: 1n, namespaceId: 2, spaceId: 20n, title: 'Policy', status: 'normal', createdBy: 1n };
  let historyWhere: unknown;
  const events = [
    { id: 12n, targetType: 'page', targetId: 1n, actionType: 'reset', oldRuleJson: null, newRuleJson: { action: 'edit', subjectType: 'user', subjectValue: '99' }, reason: 'private reason', changedBy: 3n, createdAt: now },
    { id: 11n, targetType: 'page', targetId: 1n, actionType: 'delete', oldRuleJson: { action: 'read', subjectType: 'ip', subjectValue: '192.0.2.1' }, newRuleJson: null, reason: 'remove address rule', changedBy: 3n, createdAt: now },
    { id: 10n, targetType: 'page', targetId: 1n, actionType: 'reorder', oldRuleJson: [], newRuleJson: [], reason: null, changedBy: null, createdAt: now }
  ];
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    aclChangeLog: { async findMany(args: { where: unknown }) { historyWhere = args.where; return events; } },
    wikiProfile: {
      async findUnique() { return { id: 3n, status: 'active' }; },
      async findMany() { return [{ id: 3n, displayName: 'Maintainer', username: 'maintainer' }]; }
    }
  } as unknown as PrismaService;
  let manager = false;
  const permissions = {
    actorFromSession() { return { profileId: 3n, status: 'active' }; },
    async assertCanReadPage() {},
    async assertCanUsePageAction() {},
    async canManagePageAcl() { return { allowed: manager, reason: manager ? 'page_manager_acl' : 'page_manager_required' }; }
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const publicResult = await service.getPageAclHistoryEvents('1', null, '13', 2);
  assert.deepEqual(historyWhere, { targetType: 'page', targetId: 1n, id: { lt: 13n } });
  assert.equal(publicResult.nextCursor, '11');
  assert.equal(publicResult.items[0]?.actionType, 'reset');
  assert.equal(publicResult.detailsVisible, false);
  assert.equal(publicResult.items[0]?.reason, null);
  assert.equal(publicResult.items[0]?.newRules, null);
  assert.equal(publicResult.items[1]?.oldRules, null);
  assert.equal(publicResult.items[0]?.actorUsername, 'maintainer');

  manager = true;
  const managerResult = await service.getPageAclHistoryEvents('1', {
    userId: 'account', isElevated: false, permissions: [], groups: [], requestIp: null
  } as unknown as SessionPayload, undefined, 1);
  assert.equal(managerResult.detailsVisible, true);
  assert.equal(managerResult.items[0]?.reason, 'private reason');
  assert.deepEqual(managerResult.items[0]?.newRules, { action: 'edit', subjectType: 'user', subjectValue: '99' });
});

test('historical revision rendering keeps raw source private and applies read plus history ACLs', async () => {
  const now = new Date('2026-07-16T00:00:00Z');
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'history', slug: 'history', title: 'History', displayTitle: 'History', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const revision = { id: 11n, pageId: 1n, revisionNo: 3, parentRevisionId: 10n, contentRaw: '= Historical =\nRendered body', contentHash: 'hash', contentSize: 28, syntaxVersion: 'bwm-0.3', editSummary: 'old copy', editSummaryHidden: false, isMinor: true, editTags: null, contentAst: null, createdBy: 2n, actorType: 'user', actorUserId: 2n, actorIp: null, actorIpText: null, actorIpHash: null, createdAt: now, visibility: 'public' };
  const prisma = {
    wikiPage: { async findUnique() { return page; }, async findFirst() { return { namespaceId: 1 }; } },
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; } },
    wikiPageRevision: { async findFirst(input: { where: { id: bigint } }) { return input.where.id === 11n ? revision : null; } },
    wikiPageRenderCache: { async findUnique() { return null; }, async create() { return {}; } },
    serverWiki: { async findFirst() { return null; } },
  } as unknown as PrismaService;
  const actions: string[] = [];
  let readRevisionId: bigint | undefined;
  const permissions = {
    async assertCanReadPage(input: { revision?: { id: bigint } }) { readRevisionId = input.revision?.id; },
    async assertCanUsePageAction(input: { action: string }) { actions.push(input.action); }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getRenderedRevision('11');

  assert.equal(result.id, '1');
  assert.equal(result.revision.id, '11');
  assert.equal(result.revision.editSummary, 'old copy');
  assert.equal(result.revision.editSummaryHidden, false);
  assert.equal(result.revision.isCurrent, false);
  assert.equal(result.currentRevisionId, '12');
  assert.equal(result.routePath, '/wiki/History');
  assert.equal(result.render.dependencyMode, 'live-current');
  assert.equal(result.render.releaseId, null);
  assert.match(result.html, /Historical/u);
  assert.equal('contentRaw' in (result as unknown as Record<string, unknown>), false);
  assert.equal(readRevisionId, 11n);
  assert.deepEqual(actions, ['history']);

  revision.editSummaryHidden = true;
  const redacted = await new WikiReadService(prisma, permissions).getRenderedRevision('11');
  assert.equal(redacted.revision.editSummary, null);
  assert.equal(redacted.revision.editSummaryHidden, true);
});

test('public server wiki renders a historical revision from its immutable release snapshot', async () => {
  const now = new Date('2026-07-19T00:00:00Z');
  const page = {
    id: 30n, namespaceId: 7, spaceId: 40n, localPath: 'luna/current-guide', slug: 'luna/current-guide',
    title: 'luna/current-guide', displayTitle: 'Current guide', currentRevisionId: 13n, pageType: 'article',
    protectionLevel: 'open', status: 'normal', createdBy: 1n, ownerProfileId: null, createdAt: now, updatedAt: now,
  };
  const revision = {
    id: 11n, pageId: 30n, revisionNo: 1, parentRevisionId: null, contentRaw: 'historical', contentHash: 'a', contentSize: 10,
    syntaxVersion: 'bwm-0.3', editSummary: 'first release', editSummaryHidden: false, isMinor: false, editTags: null,
    contentAst: null, createdBy: 1n, actorType: 'user', actorUserId: 1n, actorIp: null, actorIpText: null, actorIpHash: null,
    createdAt: now, visibility: 'public',
  };
  const historicalItem = {
    id: 101n, releaseId: 70n, serverWikiId: 50n, spaceId: 40n, namespaceId: 7, pageId: 30n, revisionId: 11n,
    localPath: 'luna/old-guide', slug: 'luna/old-guide', title: 'luna/old-guide', displayTitle: 'Old guide',
    pageType: 'article', protectionLevel: 'open', pageStatus: 'normal', createdBy: 1n, ownerProfileId: null,
    pageUpdatedAt: now, searchVector: '', createdAt: now,
  };
  const currentItem = { ...historicalItem, id: 102n, releaseId: 71n, revisionId: 12n };
  const prisma = {
    wikiPageRevision: { async findFirst() { return revision; } },
    wikiPage: { async findUnique() { return page; } },
    wikiNamespace: { async findUnique() { return { id: 7, code: 'server' }; } },
  } as unknown as PrismaService;
  let renderedInput: { localPath: string; revisionId?: bigint; releaseId?: bigint } | null = null;
  const permissions = {
    async resolvePublishedRevisionScope() {
      return { currentItem, revisionItems: [currentItem, historicalItem] };
    },
    async assertCanReadPage() {},
    async assertCanUsePageAction() {},
  } as unknown as WikiPermissionService;
  const routes = {
    async preload() { return { routePath(input: { localPath: string }) { return `/server/${input.localPath}`; } }; },
  } as unknown as WikiRoutePathResolver;
  const service = new WikiReadService(prisma, permissions, undefined, undefined, routes);
  (service as unknown as {
    renderPage(namespace: string, pageInput: typeof page, access: unknown, options: { revisionId?: bigint; releaseId?: bigint }): Promise<unknown>;
  }).renderPage = async (_namespace, pageInput, _access, options) => {
    renderedInput = { localPath: pageInput.localPath, revisionId: options.revisionId, releaseId: options.releaseId };
    return {
      id: '30', namespace: 'server', spaceId: '40', slug: pageInput.slug, title: pageInput.title,
      displayTitle: pageInput.displayTitle, pageType: 'article', protectionLevel: 'open', status: 'normal',
      updatedAt: now.toISOString(), revision: { id: '11', revisionNo: 1, contentHash: 'a', createdAt: now.toISOString(), createdBy: '1' },
      html: '<p>historical</p>', links: [], categories: [], headings: [], redirectTarget: null, redirectedFrom: null,
      serverDirectoryPath: null, serverWiki: null,
    };
  };

  const result = await service.getRenderedRevision('11');

  assert.deepEqual(renderedInput, { localPath: 'luna/old-guide', revisionId: 11n, releaseId: 70n });
  assert.equal(result.render.dependencyMode, 'release-snapshot');
  assert.equal(result.render.releaseId, '70');
  assert.equal(result.currentRevisionId, '12');
  assert.equal(result.revision.isCurrent, false);
  assert.equal(result.routePath, '/server/luna/old-guide');
});

test('historical revision rendering conceals non-public revisions before ACL evaluation', async () => {
  let permissionChecks = 0;
  const service = new WikiReadService({
    wikiPageRevision: { async findFirst() { return null; } }
  } as unknown as PrismaService, {
    async assertCanReadPage() { permissionChecks += 1; }
  } as unknown as WikiPermissionService);

  await assert.rejects(() => service.getRenderedRevision('99'), /Public wiki revision not found/u);
  assert.equal(permissionChecks, 0);
});

test('recent changes use filters, a stable cursor, and one page visibility check per document', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const readablePage = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'alpha/공개 문서', title: '공개 문서', createdBy: 1n, protectionLevel: 'open', status: 'normal' };
  const hiddenPage = { ...readablePage, id: 2n, title: '비공개 문서' };
  let recentQuery: unknown;
  let pageQueryCount = 0;
  const change = (id: bigint, pageId: bigint, title: string) => ({ id, pageId, revisionId: id + 100n, actorId: 3n, changeType: 'edit', title, namespaceCode: 'server', summary: null, isMinor: false, createdAt: now });
  const prisma = {
    wikiRecentChange: {
      async findMany(args: unknown) {
        recentQuery = args;
        return [change(10n, 1n, '공개 문서'), change(9n, 2n, '비공개 문서'), change(8n, 1n, '공개 문서')];
      }
    },
    wikiPageRevision: {
      async findMany(args: { where: { id: { in: bigint[] } } }) {
        return args.where.id.in.map((id) => ({ id, editSummaryHidden: false }));
      }
    },
    wikiPage: {
      async findMany() {
        pageQueryCount += 1;
        return [readablePage, hiddenPage];
      }
    },
    serverWiki: {
      async findMany(args: { select?: { publishedReleaseId?: boolean } }) {
        return args.select?.publishedReleaseId ? [] : [{ spaceId: 1n, slug: 'alpha' }];
      }
    }
  } as unknown as PrismaService;
  const checked = new Map<bigint, number>();
  const permissions = {
    async assertCanReadPage({ page }: { page: { id: bigint } | null }) {
      if (!page) throw new Error('missing');
      checked.set(page.id, (checked.get(page.id) ?? 0) + 1);
      if (page.id === 2n) throw new Error('hidden');
    }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getRecent({ cursor: '11', limit: 2, changeType: 'edit', namespace: 'server', spaceId: '1', minor: 'false' });

  assert.deepEqual(recentQuery, {
    where: { id: { lt: 11n }, changeType: 'edit', namespaceCode: 'server', spaceId: 1n, isMinor: false },
    orderBy: [{ id: 'desc' }],
    take: 9
  });
  assert.equal(pageQueryCount, 1);
  assert.deepEqual([...checked.entries()], [[1n, 1], [2n, 1]]);
  assert.deepEqual(result.items.map((item) => item.id), ['10', '8']);
  assert.equal(result.items[0]?.routePath, '/serverWiki/alpha/%EA%B3%B5%EA%B0%9C_%EB%AC%B8%EC%84%9C');
  assert.equal(result.nextCursor, '8');
});

test('public server wiki recent changes require release membership at the candidate capture boundary', async () => {
  const capturedAt = new Date('2026-07-19T04:30:00.000Z');
  const publishedAt = new Date('2026-07-19T05:00:00.000Z');
  const page = {
    id: 20n, namespaceId: 7, spaceId: 40n, slug: 'draft-page', title: '초안 문서', displayTitle: '초안 문서',
    currentRevisionId: 202n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, ownerProfileId: null, createdAt: new Date('2026-07-18T00:00:00.000Z'),
    updatedAt: new Date('2026-07-19T04:45:00.000Z'), localPath: 'luna/draft-page',
  };
  const wiki = {
    id: 50n, spaceId: 40n, slug: 'luna', siteSlug: 'public-docs', status: 'active',
    publicationStatus: 'published', publishedReleaseId: 70n, publishedRelease: { version: 2, publishedAt },
  };
  const releaseItem = {
    id: 80n, releaseId: 70n, serverWikiId: 50n, spaceId: 40n, pageId: 20n, revisionId: 200n,
    namespaceId: 7, slug: 'luna/public-page', title: 'luna/public-page', displayTitle: '공개 문서', localPath: 'luna/public-page',
    pageType: 'article', protectionLevel: 'open', pageStatus: 'normal', createdBy: 5n, ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-19T04:00:00.000Z'), searchVector: '', createdAt: publishedAt,
  };
  const previousReleaseItem = {
    ...releaseItem,
    id: 79n,
    releaseId: 69n,
    revisionId: 199n,
    displayTitle: '이전 공개 문서',
    pageUpdatedAt: new Date('2026-07-19T03:00:00.000Z'),
  };
  const change = (id: bigint, revisionId: bigint, title: string, createdAt: Date) => ({
    id, spaceId: 40n, pageId: 20n, revisionId, previousPublicRevisionId: null, actorId: 5n,
    changeType: 'edit', title, localPath: 'luna/draft-page', namespaceCode: 'server', summary: title,
    sizeDelta: 1, eventAudience: 'public', isMinor: false, createdAt,
  });
  const changes = [
    change(12n, 202n, '후보 캡처 후 초안', new Date('2026-07-19T04:45:00.000Z')),
    change(11n, 200n, '배포판', new Date('2026-07-19T04:00:00.000Z')),
    change(10n, 199n, '이전 공개판', new Date('2026-07-19T03:00:00.000Z')),
  ];
  let preview = false;
  const prisma = {
    wikiRecentChange: { async findMany() { return changes; } },
    wikiPageRevision: {
      async findMany(args: { where: { id: { in: bigint[] } } }) {
        return args.where.id.in.map((id) => ({ id, editSummaryHidden: false, actorType: 'user', visibility: 'public' }));
      }
    },
    wikiPage: { async findMany() { return [page]; } },
    wikiProfile: { async findMany() { return [{ id: 5n, username: 'editor', displayName: '편집자' }]; } },
    serverWiki: { async findMany() { return [wiki]; } },
    serverWikiReleaseItem: {
      async findMany(args: { include?: unknown }) {
        if (!args.include) return [releaseItem];
        return [
          { ...releaseItem, release: { version: 2, candidate: { createdAt: capturedAt } } },
          { ...previousReleaseItem, release: { version: 1, candidate: { createdAt: new Date('2026-07-19T03:30:00.000Z') } } },
        ];
      }
    },
  } as unknown as PrismaService;
  const permissions = {
    async canPreviewServerWikiSpace() { return preview; },
    async assertCanReadPage() {},
    async assertCanUsePageAction() {},
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const publicResult = await service.getRecent({ spaceId: '40' });
  assert.deepEqual(publicResult.items.map((item) => [item.id, item.title]), [['11', 'luna/public-page'], ['10', 'luna/public-page']]);
  assert.deepEqual(publicResult.items.map((item) => item.routePath), [
    '/serverWiki/public-docs/public-page',
    '/serverWiki/public-docs/public-page',
  ]);

  preview = true;
  const previewResult = await service.getRecent({ spaceId: '40' });
  assert.deepEqual(previewResult.items.map((item) => item.id), ['12', '11', '10']);
  assert.equal(previewResult.items[0]?.title, '후보 캡처 후 초안');
});

test('recent changes expose only public deletion snapshots with a generic reason', async () => {
  const now = new Date('2026-07-19T00:00:00Z');
  const deleted = { id: 7n, namespaceId: 1, spaceId: 5n, localPath: '삭제됨', title: '삭제됨', protectionLevel: 'open', status: 'deleted' };
  const row = (id: bigint, eventAudience: string) => ({
    id, pageId: deleted.id, revisionId: 70n, previousPublicRevisionId: null, actorId: 9n,
    spaceId: 5n, changeType: 'delete', title: '삭제됨', localPath: '삭제됨', namespaceCode: 'main',
    summary: '개인정보가 포함된 내부 삭제 사유', sizeDelta: 0, eventAudience, isMinor: false, createdAt: now,
  });
  const prisma = {
    wikiRecentChange: { async findMany() { return [row(2n, 'public'), row(1n, 'restricted')]; } },
    wikiPage: { async findMany() { return [deleted]; } },
    wikiPageRevision: { async findMany() { return [{ id: 70n, editSummaryHidden: false, actorType: 'user', visibility: 'public' }]; } },
    wikiProfile: { async findMany() { return [{ id: 9n, username: 'editor', displayName: '편집자' }]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
    serverWiki: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() { throw new Error('deleted'); } } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getRecent({ spaceId: '5' });

  assert.equal(result.items.length, 1);
  assert.equal(result.items[0]?.summary, '문서 삭제');
  assert.equal(result.items[0]?.actorName, '편집자');
  assert.equal(result.items[0]?.canViewDiff, false);
  assert.doesNotMatch(JSON.stringify(result), /개인정보가 포함된 내부 삭제 사유/u);
});

test('recent changes redact stale denormalized summaries from hidden or missing source revisions', async () => {
  const now = new Date('2026-07-17T00:00:00Z');
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: '문서', slug: '문서', title: '문서', displayTitle: '문서', currentRevisionId: 110n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const prisma = {
    wikiRecentChange: {
      async findMany() {
        return [
          { id: 10n, pageId: 1n, revisionId: 110n, actorId: 3n, changeType: 'edit', title: '문서', namespaceCode: 'main', summary: '숨겨진 복사본', isMinor: false, createdAt: now },
          { id: 9n, pageId: 1n, revisionId: 109n, actorId: 3n, changeType: 'edit', title: '문서', namespaceCode: 'main', summary: '고아 복사본', isMinor: false, createdAt: now }
        ];
      }
    },
    wikiPageRevision: { async findMany() { return [{ id: 110n, editSummaryHidden: true }]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getRecent({ limit: 10 });

  assert.deepEqual(result.items.map((item) => [item.summary, item.summaryHidden]), [[null, true], [null, true]]);
});

test('blocked profiles keep their public contribution ledger', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 7n, username: 'blocked', displayName: '차단 사용자', status: 'blocked', createdAt: now, updatedAt: now }; } },
    wikiRecentChange: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const result = await new WikiReadService(prisma, {} as WikiPermissionService).getContributions({ profileId: '7' });
  assert.equal(result.profile.status, 'blocked');
  assert.deepEqual(result.items, []);
});

test('special long documents are sorted by current public source size', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const pages = [
    { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'short', slug: 'short', title: '짧음', displayTitle: '짧음', currentRevisionId: 11n, currentContentSize: 5, currentCategoryCount: 0, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now },
    { id: 2n, namespaceId: 1, spaceId: 1n, localPath: 'long', slug: 'long', title: '김', displayTitle: '김', currentRevisionId: 12n, currentContentSize: 500, currentCategoryCount: 0, pageType: 'article', protectionLevel: 'official_only', status: 'protected', createdBy: 1n, createdAt: now, updatedAt: now }
  ];
  let pageQuery: unknown;
  const prisma = {
    wikiPage: { async findMany(args: unknown) { pageQuery = args; return [pages[1]!, pages[0]!]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
  } as unknown as PrismaService;
  const permissions = { async filterReadablePages({ pages }: { pages: typeof pages }) { return [...pages]; } } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'long' });

  assert.deepEqual(result.items.map((item) => [item.pageId, item.value]), [['2', 500], ['1', 5]]);
  assert.deepEqual((pageQuery as { orderBy: unknown }).orderBy, [{ currentContentSize: 'desc' }, { id: 'desc' }]);
  assert.equal((pageQuery as { take: number }).take, 250);
  assert.deepEqual((pageQuery as { where: { status: { in: string[] } } }).where.status.in, [...PUBLIC_WIKI_PAGE_STATUSES]);
  assert.equal(JSON.stringify(pageQuery).includes('contentRaw'), false);
});

test('special old documents are sorted by the oldest current update first', async () => {
  const old = new Date('2025-01-01T00:00:00Z');
  const recent = new Date('2026-07-13T00:00:00Z');
  const pages = [
    { id: 2n, namespaceId: 1, spaceId: 1n, localPath: 'recent', slug: 'recent', title: '최근', displayTitle: '최근', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: recent, updatedAt: recent },
    { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'old', slug: 'old', title: '오래됨', displayTitle: '오래됨', currentRevisionId: 11n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: old, updatedAt: old }
  ];
  const prisma = {
    wikiPage: { async findMany() { return [pages[1]!, pages[0]!]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const permissions = { async filterReadablePages({ pages: candidates }: { pages: typeof pages }) { return [...candidates]; } } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'old' });

  assert.deepEqual(result.items.map((item) => [item.pageId, item.updatedAt]), [
    ['1', old.toISOString()], ['2', recent.toISOString()]
  ]);
});

test('special uncategorized documents use bounded materialized metrics without reading source bodies', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = {
    id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'no-category', slug: 'no-category',
    title: '분류 없음', displayTitle: '분류 없음', currentRevisionId: 11n,
    currentContentSize: 300, currentCategoryCount: 0, pageType: 'article', protectionLevel: 'open',
    status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now
  };
  let pageQuery: unknown;
  let revisionReads = 0;
  const prisma = {
    wikiPage: { async findMany(args: unknown) { pageQuery = args; return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
    wikiPageRevision: { async findMany() { revisionReads += 1; return []; } }
  } as unknown as PrismaService;
  const permissions = { async filterReadablePages({ pages }: { pages: typeof page[] }) { return [...pages]; } } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'uncategorized', limit: 20 });

  assert.deepEqual(result.items.map((item) => item.pageId), ['1']);
  assert.equal(revisionReads, 0);
  assert.equal((pageQuery as { take: number }).take, 100);
  assert.equal(JSON.stringify(pageQuery).includes('currentCategoryCount'), true);
  assert.equal(JSON.stringify(pageQuery).includes('contentRaw'), false);
});

test('special wanted documents aggregate unresolved current links', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  let linkReads = 0;
  const prisma = {
    wikiNamespace: { async findUnique() { return null; } },
    wikiSpecialSnapshot: { async findUnique() { return {
      generation: 'generation-1', generatedAt: now, items: { projectionVersion: 2, items: [
        { id: 'wanted:main:없는_문서', pageId: null, namespace: 'main', title: '없는_문서', displayTitle: '없는_문서', routePath: '/wiki/%EC%97%86%EB%8A%94_%EB%AC%B8%EC%84%9C', value: 2, updatedAt: null }
      ] }
    }; } },
    wikiPageLink: { async findMany() { linkReads += 1; return []; } }
  } as unknown as PrismaService;
  const permissions = { async filterReadablePages() { return []; } } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'wanted' });

  assert.equal(result.items[0]?.title, '없는_문서');
  assert.equal(result.items[0]?.value, 2);
  assert.equal(result.generation, 'generation-1');
  assert.equal(linkReads, 0);
});

test('special category list counts only current categories from readable documents', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  let linkReads = 0;
  const prisma = {
    wikiNamespace: { async findUnique() { return null; } },
    wikiSpecialSnapshot: { async findUnique() { return {
      generation: 'generation-2', generatedAt: now, items: { projectionVersion: 2, items: [
        { id: 'category:가이드', pageId: null, namespace: 'category', title: '가이드', displayTitle: '가이드', routePath: '/wiki/category/%EA%B0%80%EC%9D%B4%EB%93%9C', value: 1, updatedAt: null },
        { id: 'category:초보자', pageId: null, namespace: 'category', title: '초보자', displayTitle: '초보자', routePath: '/wiki/category/%EC%B4%88%EB%B3%B4%EC%9E%90', value: 1, updatedAt: null }
      ] }
    }; } },
    wikiPageLink: { async findMany() { linkReads += 1; return []; } }
  } as unknown as PrismaService;
  const permissions = { async filterReadablePages() { return []; } } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'categories' });

  assert.deepEqual(result.items.map((item) => [item.title, item.value, item.routePath]), [
    ['가이드', 1, '/wiki/category/%EA%B0%80%EC%9D%B4%EB%93%9C'],
    ['초보자', 1, '/wiki/category/%EC%B4%88%EB%B3%B4%EC%9E%90']
  ]);
  assert.equal(linkReads, 0);
});

test('indexed special documents paginate without duplicate rows and bind the cursor to its filters', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z');
  const pages = [3n, 2n, 1n].map((id) => ({
    id, namespaceId: 1, spaceId: 1n, localPath: `page-${id}`, slug: `page-${id}`,
    title: `문서 ${id}`, displayTitle: `문서 ${id}`, currentRevisionId: id + 10n,
    currentContentSize: Number(id) * 100, currentCategoryCount: 0, pageType: 'article',
    protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now,
  }));
  let pageRead = 0;
  const prisma = {
    wikiPage: { async findMany() { pageRead += 1; return pageRead === 1 ? pages : [pages[2]!]; } },
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; }, async findMany() { return [{ id: 1, code: 'main' }]; } },
  } as unknown as PrismaService;
  const permissions = { async filterReadablePages({ pages: candidates }: { pages: typeof pages }) { return candidates; } } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions, undefined, undefined, undefined, specialCursorCodec);

  const first = await service.getSpecialDocuments({ type: 'long', namespace: 'main', limit: 2 });
  assert.deepEqual(first.items.map((item) => item.pageId), ['3', '2']);
  assert.ok(first.nextCursor);
  const second = await service.getSpecialDocuments({ type: 'long', namespace: 'main', limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.items.map((item) => item.pageId), ['1']);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    () => service.getSpecialDocuments({ type: 'short', namespace: 'main', limit: 2, cursor: first.nextCursor! }),
    /유효하지 않거나/u,
  );
});

test('public server wiki special documents use the immutable release and reject cross-tenant cursors', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z');
  const releaseItems = [2n, 1n].map((pageId) => ({
    id: pageId + 100n,
    releaseId: 70n,
    serverWikiId: 50n,
    spaceId: 40n,
    namespaceId: 9,
    pageId,
    revisionId: pageId + 200n,
    localPath: `guide-${pageId}`,
    slug: `guide-${pageId}`,
    title: `가이드 ${pageId}`,
    displayTitle: `가이드 ${pageId}`,
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 7n,
    ownerProfileId: null,
    pageUpdatedAt: new Date(now.getTime() - Number(pageId) * 1_000),
    searchVector: '',
    createdAt: now,
    revision: { contentSize: Number(pageId) * 100 },
  }));
  const prisma = {
    serverWiki: {
      async findFirst(args: { where: { OR: Array<{ siteSlug?: string; slug?: string }> } }) {
        const requested = args.where.OR[0]?.siteSlug ?? args.where.OR[1]?.slug;
        return requested === 'other'
          ? { id: 51n, spaceId: 41n, slug: 'other', siteSlug: null, publicationStatus: 'published', publishedReleaseId: 71n }
          : { id: 50n, spaceId: 40n, slug: 'alpha', siteSlug: 'alpha-site', publicationStatus: 'published', publishedReleaseId: 70n };
      },
    },
    wikiNamespace: { async findUnique() { return { id: 9, code: 'server' }; } },
    serverWikiReleaseItem: { async findMany() { return releaseItems; } },
    serverWikiReleaseLink: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const permissions = {
    async canPreviewServerWikiSpace() { return false; },
    async filterReadablePages({ pages }: { pages: unknown[] }) { return pages; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions, undefined, undefined, undefined, specialCursorCodec);

  const first = await service.getSpecialDocuments({ type: 'long', serverSlug: 'alpha-site', limit: 1 });
  assert.deepEqual(first.items.map((item) => [item.pageId, item.value, item.routePath]), [
    ['2', 200, '/serverWiki/alpha-site/%EA%B0%80%EC%9D%B4%EB%93%9C_2'],
  ]);
  assert.ok(first.nextCursor);
  await assert.rejects(
    () => service.getSpecialDocuments({ type: 'long', serverSlug: 'other', limit: 1, cursor: first.nextCursor! }),
    /유효하지 않거나/u,
  );
});

test('graph special snapshots remain reachable beyond the legacy five-hundred item cutoff', async () => {
  const now = new Date('2026-07-18T00:00:00.000Z');
  const items = Array.from({ length: 501 }, (_, index) => ({
    id: `wanted:main:missing-${index}`,
    pageId: null,
    namespace: 'main',
    title: `missing-${index}`,
    displayTitle: `Missing ${index}`,
    routePath: `/wiki/missing-${index}`,
    value: 1,
    updatedAt: null,
  }));
  const prisma = {
    wikiNamespace: { async findUnique() { return null; } },
    wikiSpecialSnapshot: { async findUnique() { return {
      generation: 'generation-501', generatedAt: now, items: { projectionVersion: 2, items },
    }; } },
    wikiPage: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const permissions = { async filterReadablePages() { return []; } } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions, undefined, undefined, undefined, specialCursorCodec);
  let cursor: string | undefined;
  const reached: string[] = [];
  do {
    const page = await service.getSpecialDocuments({ type: 'wanted', limit: 100, cursor });
    reached.push(...page.items.map((item) => item.id));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(reached.length, 501);
  assert.equal(new Set(reached).size, 501);
  assert.equal(reached.at(-1), 'wanted:main:missing-500');
});

test('identified special snapshot reads remove denied source contributions from wanted and category aggregates', async () => {
  const now = new Date('2026-07-17T00:00:00Z');
  const sourcePage = (id: bigint, title: string) => ({
    id, namespaceId: 1, spaceId: 1n, localPath: title, slug: title, title, displayTitle: title,
    currentRevisionId: id + 1000n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 1n, createdAt: now, updatedAt: now
  });
  const readableSource = sourcePage(901n, '읽기 가능');
  const deniedSource = sourcePage(902n, '그룹 ACL 차단');
  const snapshotItem = (
    type: 'wanted' | 'categories',
    title: string,
    value: number,
    sourceContributions: ReadonlyArray<{ pageId: string; count: number }>
  ) => ({
    id: `${type}:${title}`,
    pageId: null,
    namespace: type === 'categories' ? 'category' : 'main',
    title,
    displayTitle: title,
    routePath: type === 'categories' ? `/wiki/category/${title}` : `/wiki/${title}`,
    value,
    updatedAt: null,
    sourceContributions,
    sourceContributionsComplete: true
  });
  const snapshots = {
    wanted: [
      snapshotItem('wanted', '읽을_수_있는_대상', 3, [{ pageId: '901', count: 1 }, { pageId: '902', count: 2 }]),
      snapshotItem('wanted', '숨겨진_대상', 1, [{ pageId: '902', count: 1 }])
    ],
    categories: [
      snapshotItem('categories', '공개_분류', 2, [{ pageId: '901', count: 1 }, { pageId: '902', count: 1 }]),
      snapshotItem('categories', '비밀_분류', 1, [{ pageId: '902', count: 1 }])
    ]
  };
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 77n, status: 'active' }; } },
    wikiNamespace: { async findUnique() { return null; } },
    wikiSpecialSnapshot: {
      async findUnique(args: { where: { type_namespaceCode: { type: 'wanted' | 'categories' } } }) {
        return {
          generation: `generation-${args.where.type_namespaceCode.type}`,
          generatedAt: now,
          items: { projectionVersion: 2, items: snapshots[args.where.type_namespaceCode.type] }
        };
      }
    },
    wikiPage: { async findMany() { return [readableSource, deniedSource]; } }
  } as unknown as PrismaService;
  const actor = { accountId: 'account-77', profileId: 77n, status: 'active', groups: ['restricted'] };
  const permissions = {
    actorFromSession() { return actor; },
    async filterReadablePages({ pages, actor: receivedActor }: { pages: typeof readableSource[]; actor: typeof actor }) {
      assert.equal(receivedActor, actor);
      return pages.filter((candidate) => candidate.id === readableSource.id);
    }
  } as unknown as WikiPermissionService;
  const viewer = {
    sessionId: 'session-77', userId: 'account-77', tokenVersion: 1, isElevated: false,
    authenticatedAt: now.toISOString(), groups: ['restricted']
  } satisfies SessionPayload;
  const service = new WikiReadService(prisma, permissions);

  const wanted = await service.getSpecialDocuments({ type: 'wanted', viewer });
  const categories = await service.getSpecialDocuments({ type: 'categories', viewer });

  assert.deepEqual(wanted.items.map((item) => [item.title, item.value]), [['읽을_수_있는_대상', 1]]);
  assert.deepEqual(categories.items.map((item) => [item.title, item.value]), [['공개_분류', 1]]);
  assert.equal(JSON.stringify([wanted, categories]).includes('sourceContributions'), false);
  assert.equal(JSON.stringify([wanted, categories]).includes('902'), false);
});

test('identified special snapshot reads fail closed for legacy snapshot envelopes', async () => {
  const now = new Date('2026-07-17T00:00:00Z');
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 7n, status: 'active' }; } },
    wikiNamespace: { async findUnique() { return null; } },
    wikiSpecialSnapshot: { async findUnique() { return {
      generation: 'legacy-generation', generatedAt: now, items: [
        { id: 'wanted:legacy', pageId: null, namespace: 'main', title: 'legacy', displayTitle: 'legacy', routePath: '/wiki/legacy', value: 9, updatedAt: null },
        {
          id: 'wanted:truncated', pageId: null, namespace: 'main', title: 'truncated', displayTitle: 'truncated',
          routePath: '/wiki/truncated', value: 9, updatedAt: null,
          sourceContributions: [{ pageId: '1', count: 1 }], sourceContributionsComplete: false
        }
      ]
    }; } },
    wikiPage: { async findMany() { throw new Error('incomplete metadata must not be queried'); } }
  } as unknown as PrismaService;
  const permissions = {
    actorFromSession() { return { accountId: 'account-7', profileId: 7n, status: 'active' }; },
    async filterReadablePages() { return []; }
  } as unknown as WikiPermissionService;
  const viewer = {
    sessionId: 'session-7', userId: 'account-7', tokenVersion: 1, isElevated: false,
    authenticatedAt: now.toISOString()
  } satisfies SessionPayload;

  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'wanted', viewer });

  assert.deepEqual(result.items, []);
  assert.equal(result.generation, 'legacy-generation');
  assert.equal(result.generatedAt, now.toISOString());
  assert.equal(result.isRebuilding, true);
  assert.equal(result.isStale, true);
});

test('blame keeps attribution for lines preserved across later revisions', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'doc', slug: 'doc', title: '문서', displayTitle: '문서', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    serverWiki: { async findFirst() { return null; } },
    wikiPageRevision: {
      async count() { return 2; },
      async findMany() { return [
        { id: 11n, revisionNo: 1, contentRaw: 'alpha\nbeta', createdBy: 1n, createdAt: now },
        { id: 12n, revisionNo: 2, contentRaw: 'new\nalpha\nbeta', createdBy: 2n, createdAt: new Date('2026-07-13T01:00:00Z') }
      ]; }
    },
    wikiProfile: { async findMany() { return [{ id: 1n, displayName: 'first' }, { id: 2n, displayName: 'second' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {}, async assertCanUsePageAction() {} } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).getBlame('1');

  assert.deepEqual(result.lines.map((line) => [line.content, line.revisionNo, line.createdByName]), [
    ['new', 2, 'second'], ['alpha', 1, 'first'], ['beta', 1, 'first']
  ]);
});

test('public server wiki blame stops at the released revision and conceals later draft content', async () => {
  const now = new Date('2026-07-19T00:00:00Z');
  const page = {
    id: 1n, namespaceId: 7, spaceId: 40n, localPath: 'luna/guide', slug: 'luna/guide',
    title: 'luna/guide', displayTitle: 'Guide', currentRevisionId: 13n, pageType: 'article',
    protectionLevel: 'open', status: 'deleted', createdBy: 1n, createdAt: now, updatedAt: now,
  };
  const whereInputs: unknown[] = [];
  const permissionInputs: Array<{ page: { title: string }; publicationProof?: { item: { revisionId: bigint } } }> = [];
  const releaseItem = {
    id: 80n, releaseId: 70n, serverWikiId: 50n, spaceId: 40n, pageId: 1n, revisionId: 12n,
    namespaceId: 7, slug: 'luna/public-guide', title: 'luna/public-guide', displayTitle: 'Public guide',
    localPath: 'luna/public-guide', pageType: 'article', protectionLevel: 'open', pageStatus: 'normal',
    createdBy: 1n, ownerProfileId: null, pageUpdatedAt: new Date('2026-07-19T01:00:00Z'),
    searchVector: '', createdAt: now,
  };
  const revisions = [
    { id: 11n, revisionNo: 1, contentRaw: '공개 첫 줄', createdBy: 1n, createdAt: now },
    { id: 12n, revisionNo: 2, contentRaw: '공개 첫 줄\n공개 둘째 줄', createdBy: 2n, createdAt: new Date('2026-07-19T01:00:00Z') },
    { id: 13n, revisionNo: 3, contentRaw: '재발행 전 비밀 초안', createdBy: 2n, createdAt: new Date('2026-07-19T02:00:00Z') },
  ];
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    serverWiki: {
      async findFirst() {
        return { id: 50n, spaceId: 40n, publicationStatus: 'published', status: 'active', publishedReleaseId: 70n };
      },
    },
    wikiPageRevision: {
      async count(args: { where: unknown }) { whereInputs.push(args.where); return 2; },
      async findMany(args: { where: { id?: { in: bigint[] }; serverWikiReleaseItems?: unknown } }) {
        whereInputs.push(args.where);
        return revisions.filter((revision) => revision.id !== 13n);
      },
    },
    wikiProfile: { async findMany() { return [{ id: 1n, displayName: 'first' }, { id: 2n, displayName: 'second' }]; } },
  } as unknown as PrismaService;
  const permissions = {
    async resolvePublishedPageBoundary() {
      return {
        serverWikiId: 50n,
        spaceId: 40n,
        currentReleaseId: 70n,
        currentReleaseVersion: 3,
        currentItem: releaseItem,
      };
    },
    async assertCanReadPage(input: { page: { title: string }; publicationProof?: { item: { revisionId: bigint } } }) {
      permissionInputs.push(input);
    },
    async assertCanUsePageAction(input: { page: { title: string }; publicationProof?: { item: { revisionId: bigint } } }) {
      permissionInputs.push(input);
    },
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getBlame('1');

  assert.equal(whereInputs.every((where) => {
    const relation = (where as { serverWikiReleaseItems?: { some?: { release?: { version?: { lte?: number } } } } }).serverWikiReleaseItems;
    return relation?.some?.release?.version?.lte === 3;
  }), true);
  assert.equal(permissionInputs.every((input) => (
    input.page.title === 'luna/public-guide' && input.publicationProof?.item.revisionId === 12n
  )), true);
  assert.equal(result.revisionId, '12');
  assert.doesNotMatch(JSON.stringify(result), /비밀 초안/u);
});

test('blame keeps deleted non-server pages hidden', async () => {
  const prisma = {
    wikiPage: { async findUnique() { return { id: 1n, spaceId: 1n, status: 'deleted' }; } },
    serverWiki: { async findFirst() { return null; } },
  } as unknown as PrismaService;
  const permissions = {} as unknown as WikiPermissionService;

  await assert.rejects(
    () => new WikiReadService(prisma, permissions).getBlame('1'),
    /not found/i,
  );
});

test('backlinks expose only links from the current readable source revision', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const target = {
    id: 10n, namespaceId: 1, spaceId: 1n, slug: '대문', title: '대문', displayTitle: '대문',
    currentRevisionId: 100n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 1n, createdAt: now, updatedAt: now, localPath: '대문'
  };
  const currentSource = { ...target, id: 20n, slug: '현재', title: '현재', displayTitle: '현재', currentRevisionId: 200n };
  const staleSource = { ...target, id: 30n, slug: '과거', title: '과거', displayTitle: '과거', currentRevisionId: 301n };
  const prisma = {
    wikiPage: {
      async findUnique() { return target; },
      async findMany() { return [currentSource, staleSource]; }
    },
    wikiNamespace: {
      async findUnique() { return { id: 1, code: 'main' }; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    },
    wikiPageLink: {
      async findMany() {
        return [
          { id: 2n, sourcePageId: 20n, sourceRevisionId: 200n, linkType: 'link' },
          { id: 1n, sourcePageId: 30n, sourceRevisionId: 300n, linkType: 'link' }
        ];
      }
    },
    wikiPageRevision: {
      async findUnique() { return { visibility: 'public' }; },
      async findMany() { return [{ id: 200n }]; }
    }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {}
  } as unknown as WikiPermissionService;

  const response = await new WikiReadService(prisma, permissions).getBacklinks({ pageId: '10' });

  assert.equal(response.items.length, 1);
  assert.equal(response.items[0]?.sourcePageId, '20');
  assert.equal(response.items[0]?.routePath, '/wiki/%ED%98%84%EC%9E%AC');
  assert.deepEqual(response.items[0]?.linkTypes, ['link']);
  assert.deepEqual(response.summary.namespaceCounts, [{ namespace: 'main', count: 1 }]);
  assert.deepEqual(response.summary.typeCounts, [{ type: 'link', count: 1 }]);
  assert.deepEqual(response.filters, { types: ['link', 'file', 'include', 'redirect'], namespace: 'main' });
});

test('public server wiki backlinks use released target and source identities while preview uses the draft', async () => {
  const now = new Date('2026-07-19T04:00:00.000Z');
  const target = {
    id: 10n, namespaceId: 7, spaceId: 40n, slug: 'luna/draft-target', title: 'luna/draft-target',
    displayTitle: '초안 대상', currentRevisionId: 101n, pageType: 'article', protectionLevel: 'open',
    status: 'normal', createdBy: 1n, ownerProfileId: null, createdAt: now, updatedAt: now, localPath: 'luna/draft-target',
  };
  const source = {
    ...target,
    id: 20n,
    slug: 'luna/draft-source',
    title: 'luna/draft-source',
    displayTitle: '비공개 초안 소스',
    localPath: 'luna/draft-source',
    currentRevisionId: 201n,
  };
  const releaseBase = {
    releaseId: 70n,
    serverWikiId: 50n,
    spaceId: 40n,
    namespaceId: 7,
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 1n,
    ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-18T04:00:00.000Z'),
    searchVector: 'release',
    createdAt: new Date('2026-07-18T04:00:00.000Z'),
  };
  const releasedTarget = {
    ...releaseBase,
    id: 80n,
    pageId: 10n,
    revisionId: 100n,
    slug: 'luna/public-target',
    title: 'luna/public-target',
    displayTitle: '공개 대상',
    localPath: 'luna/public-target',
  };
  const releasedSource = {
    ...releaseBase,
    id: 81n,
    pageId: 20n,
    revisionId: 200n,
    slug: 'luna/public-source',
    title: 'luna/public-source',
    displayTitle: '공개 소스',
    localPath: 'luna/public-source',
  };
  const wiki = {
    id: 50n,
    spaceId: 40n,
    slug: 'luna',
    siteSlug: 'luna-docs',
    publicationStatus: 'published',
    publishedReleaseId: 70n,
  };
  let preview = false;
  const linkQueries: Array<Record<string, unknown>> = [];
  const prisma = {
    wikiPage: {
      async findUnique() { return target; },
      async findMany() { return [source]; },
    },
    wikiNamespace: {
      async findUnique() { return { id: 7, code: 'server' }; },
      async findMany() { return [{ id: 7, code: 'server' }]; },
    },
    wikiPageRevision: {
      async findUnique() { return { visibility: 'public' }; },
      async findMany() { return [{ id: 201n }]; },
    },
    wikiPageLink: {
      async findMany(args: { where: Record<string, unknown> }) {
        linkQueries.push(args.where);
        return [{ id: 2n, sourcePageId: 20n, sourceRevisionId: 201n, linkType: 'link' }];
      },
    },
    serverWikiReleaseLink: {
      async findMany() {
        return [{ id: 1n, sourcePageId: 20n, sourceRevisionId: 200n, linkType: 'link' }];
      },
    },
    serverWiki: {
      async findFirst() { return wiki; },
      async findMany() { return [wiki]; },
    },
    serverWikiReleaseItem: {
      async findFirst() { return releasedTarget; },
      async findMany() { return [releasedSource]; },
    },
  } as unknown as PrismaService;
  const permissions = {
    async canPreviewServerWikiSpace() { return preview; },
    async assertCanReadPage() {},
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const publicResult = await service.getBacklinks({ pageId: '10' });
  assert.equal(linkQueries[0]?.targetSlug, 'luna/public-target');
  assert.deepEqual(publicResult.items.map((item) => [item.displayTitle, item.sourceRevisionId]), [['공개 소스', '200']]);
  assert.equal(publicResult.items[0]?.routePath, '/serverWiki/luna-docs/public-source');

  preview = true;
  const previewResult = await service.getBacklinks({ pageId: '10' });
  assert.equal(linkQueries[1]?.targetSlug, 'luna/draft-target');
  assert.deepEqual(previewResult.items.map((item) => [item.displayTitle, item.sourceRevisionId]), [['비공개 초안 소스', '201']]);
});

test('backlinks validate and forward type filters without leaking hidden namespace counts', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const target = { id: 10n, namespaceId: 1, spaceId: 1n, slug: '대문', title: '대문', displayTitle: '대문', currentRevisionId: 100n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now, localPath: '대문' };
  const visible = { ...target, id: 20n, namespaceId: 2, slug: '파일 사용', title: '파일 사용', displayTitle: '파일 사용', currentRevisionId: 200n };
  const hidden = { ...target, id: 30n, namespaceId: 3, slug: '비공개', title: '비공개', displayTitle: '비공개', currentRevisionId: 300n };
  const queries: Array<Record<string, unknown>> = [];
  let sourcePageWhere: unknown;
  const prisma = {
    wikiPage: { async findUnique() { return target; }, async findMany(args: { where: unknown }) { sourcePageWhere = args.where; return [visible, hidden]; } },
    wikiNamespace: {
      async findUnique() { return { id: 1, code: 'main' }; },
      async findMany() { return [{ id: 2, code: 'guide' }, { id: 3, code: 'secret' }]; }
    },
    wikiPageLink: { async findMany(args: { where: Record<string, unknown> }) { queries.push(args.where); return [
      { id: 3n, sourcePageId: 20n, sourceRevisionId: 200n, linkType: 'redirect' },
      { id: 2n, sourcePageId: 20n, sourceRevisionId: 200n, linkType: 'file' },
      { id: 1n, sourcePageId: 30n, sourceRevisionId: 300n, linkType: 'redirect' }
    ]; } },
    wikiPageRevision: {
      async findUnique() { return { visibility: 'public' }; },
      async findMany() { return [{ id: 200n }, { id: 300n }]; }
    }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage({ page }: { page: { id: bigint } }) { if (page.id === 30n) throw new Error('hidden'); } } as unknown as WikiPermissionService;

  const service = new WikiReadService(prisma, permissions);
  const response = await service.getBacklinks({ pageId: '10', types: 'file,redirect', namespace: 'guide', sourceSpaceId: 1n });

  assert.deepEqual(queries[0]?.linkType, { in: ['link', 'file', 'include', 'redirect'] });
  assert.deepEqual(sourcePageWhere, { id: { in: [20n, 30n] }, spaceId: 1n });
  assert.deepEqual(response.items.map((item) => item.sourcePageId), ['20']);
  assert.deepEqual(response.items[0]?.linkTypes, ['file', 'redirect']);
  assert.deepEqual(response.summary.namespaceCounts, [{ namespace: 'guide', count: 1 }]);
  assert.deepEqual(response.summary.typeCounts, [{ type: 'file', count: 1 }, { type: 'redirect', count: 1 }]);
  assert.deepEqual(response.filters, { types: ['file', 'redirect'], namespace: 'guide' });
  await assert.rejects(() => service.getBacklinks({ pageId: '10', types: 'script' }), /types must contain only/u);
});

test('backlinks use deterministic title cursors in both directions and bind them to filters', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const target = { id: 10n, namespaceId: 1, spaceId: 1n, slug: '대문', title: '대문', displayTitle: '대문', currentRevisionId: 100n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now, localPath: '대문' };
  const sources = [
    { ...target, id: 21n, title: 'Bravo', displayTitle: 'Bravo', slug: 'bravo', currentRevisionId: 201n },
    { ...target, id: 20n, title: 'alpha', displayTitle: 'alpha', slug: 'alpha', currentRevisionId: 200n },
    { ...target, id: 22n, title: 'Charlie', displayTitle: 'Charlie', slug: 'charlie', currentRevisionId: 202n }
  ];
  const prisma = {
    wikiPage: { async findUnique() { return target; }, async findMany() { return sources; } },
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; }, async findMany() { return [{ id: 1, code: 'main' }]; } },
    wikiPageRevision: { async findUnique() { return { visibility: 'public' }; }, async findMany() { return sources.map((source) => ({ id: source.currentRevisionId })); } },
    wikiPageLink: { async findMany() { return sources.map((source, index) => ({ id: BigInt(index + 1), sourcePageId: source.id, sourceRevisionId: source.currentRevisionId, linkType: 'link' })); } }
  } as unknown as PrismaService;
  const service = new WikiReadService(prisma, { async assertCanReadPage() {} } as unknown as WikiPermissionService);

  const first = await service.getBacklinks({ pageId: '10', limit: 1 });
  const second = await service.getBacklinks({ pageId: '10', limit: 1, cursor: first.nextCursor! });
  const back = await service.getBacklinks({ pageId: '10', limit: 1, cursor: second.prevCursor! });

  assert.deepEqual(first.items.map((item) => item.displayTitle), ['alpha']);
  assert.deepEqual(second.items.map((item) => item.displayTitle), ['Bravo']);
  assert.deepEqual(back.items.map((item) => item.displayTitle), ['alpha']);
  assert.equal(first.prevCursor, null);
  assert.ok(second.prevCursor);
  assert.ok(second.nextCursor);
  await assert.rejects(() => service.getBacklinks({ pageId: '10', limit: 1, types: 'file', cursor: first.nextCursor! }), /cursor is invalid for the selected backlink filters/u);
});

test('category membership exposes only current readable documents', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const current = { id: 20n, namespaceId: 1, spaceId: 1n, slug: '가이드', title: '가이드', displayTitle: '가이드', currentRevisionId: 200n, pageType: 'article', protectionLevel: 'official_only', status: 'protected', createdBy: 1n, createdAt: now, updatedAt: now, localPath: '가이드' };
  const stale = { ...current, id: 30n, slug: '과거', title: '과거', displayTitle: '과거', currentRevisionId: 301n };
  const hidden = { ...current, id: 40n, slug: '비공개', title: '비공개', displayTitle: '비공개', currentRevisionId: 400n };
  const prisma = {
    wikiPageLink: {
      async findMany(args: { take?: number }) {
        if (args.take === 501) return [];
        return [
          { id: 3n, sourcePageId: 20n, sourceRevisionId: 200n },
          { id: 2n, sourcePageId: 30n, sourceRevisionId: 300n },
          { id: 1n, sourcePageId: 40n, sourceRevisionId: 400n }
        ];
      }
    },
    serverWikiReleaseLink: { async findMany() { return []; } },
    wikiPageRevision: { async findMany() { return [{ id: 200n }, { id: 301n }, { id: 400n }]; } },
    wikiPage: {
      async findUnique() { return null; },
      async findMany() {
        return [current, stale, hidden];
      }
    },
    wikiNamespace: {
      async findUnique() { return { id: 2, code: 'category' }; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage({ page }: { page: { id: bigint } }) { if (page.id === 40n) throw new Error('hidden'); } } as unknown as WikiPermissionService;

  const response = await new WikiReadService(prisma, permissions).getCategoryMembers({ category: '초보자', limit: 30 });

  assert.equal(response.category, '초보자');
  assert.deepEqual(response.items.map((item) => item.pageId), ['20']);
  assert.equal(response.items[0]?.routePath, '/wiki/%EA%B0%80%EC%9D%B4%EB%93%9C');
});

test('category membership mixes released and preview server spaces without exposing draft links', async () => {
  const now = new Date('2026-07-19T08:00:00.000Z');
  const serverPage = (id: bigint, spaceId: bigint, revisionId: bigint, title: string) => ({
    id, namespaceId: 7, spaceId, slug: title, title, displayTitle: title,
    currentRevisionId: revisionId, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 1n, ownerProfileId: null, createdAt: now, updatedAt: now, localPath: title,
  });
  const publicDraft = serverPage(20n, 40n, 201n, '공개 공간 초안');
  const previewDraft = serverPage(21n, 41n, 301n, '미리보기 초안');
  const wiki = (id: bigint, spaceId: bigint, releaseId: bigint, siteSlug: string) => ({
    id, spaceId, releaseId, siteSlug, slug: siteSlug, status: 'active', publicationStatus: 'published', publishedReleaseId: releaseId,
  });
  const publicWiki = wiki(50n, 40n, 70n, 'public-docs');
  const previewWiki = wiki(51n, 41n, 71n, 'preview-docs');
  const releasedPublic = {
    id: 80n, releaseId: 70n, serverWikiId: 50n, spaceId: 40n, pageId: 20n, revisionId: 200n,
    namespaceId: 7, slug: '공개-배포', title: '공개 배포', displayTitle: '공개 배포', localPath: '공개-배포',
    pageType: 'article', protectionLevel: 'open', pageStatus: 'normal', createdBy: 1n, ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-18T08:00:00.000Z'), searchVector: '', createdAt: now,
  };
  const currentLinks = [
    { id: 1n, sourcePageId: 20n, sourceRevisionId: 201n, linkType: 'category' },
    { id: 2n, sourcePageId: 21n, sourceRevisionId: 301n, linkType: 'category' },
  ];
  const releasedLinks = [
    { id: 1n, releaseId: 70n, serverWikiId: 50n, spaceId: 40n, sourcePageId: 20n, sourceRevisionId: 200n, linkType: 'category' },
    { id: 2n, releaseId: 71n, serverWikiId: 51n, spaceId: 41n, sourcePageId: 21n, sourceRevisionId: 300n, linkType: 'category' },
  ];
  const prisma = {
    wikiNamespace: {
      async findUnique() { return { id: 2, code: 'category' }; },
      async findMany() { return [{ id: 7, code: 'server' }]; },
    },
    wikiPage: { async findUnique() { return null; }, async findMany() { return [publicDraft, previewDraft]; } },
    wikiPageRevision: { async findMany() { return [{ id: 201n }, { id: 301n }]; } },
    wikiPageLink: { async findMany(args: { take?: number }) { return args.take === 501 ? [] : currentLinks; } },
    serverWikiReleaseLink: { async findMany() { return releasedLinks; } },
    serverWiki: { async findMany() { return [publicWiki, previewWiki]; } },
    serverWikiReleaseItem: { async findMany() { return [releasedPublic]; } },
  } as unknown as PrismaService;
  const permissions = {
    async canPreviewServerWikiSpace({ spaceId }: { spaceId: bigint }) { return spaceId === 41n; },
    async assertCanReadPage() {},
  } as unknown as WikiPermissionService;

  const response = await new WikiReadService(prisma, permissions).getCategoryMembers({ category: '초보자' });

  assert.deepEqual(response.items.map((item) => [item.id, item.displayTitle]), [
    ['21', '미리보기 초안'],
    ['20', '공개 배포'],
  ]);
  assert.equal(new Set(response.items.map((item) => item.id)).size, 2);
  assert.equal(response.items.some((item) => item.displayTitle === '공개 공간 초안'), false);
});

test('category membership cursor is deterministic, ACL-complete, and bound to publication filters', async () => {
  const page = (id: bigint, updatedAt: string) => ({
    id, namespaceId: 1, spaceId: 1n, slug: `문서-${id}`, title: `문서 ${id}`, displayTitle: `문서 ${id}`,
    currentRevisionId: id * 10n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 1n, createdAt: new Date(updatedAt), updatedAt: new Date(updatedAt), localPath: `문서-${id}`,
  });
  const pages = [
    page(24n, '2026-07-19T04:00:00.000Z'),
    page(23n, '2026-07-19T03:00:00.000Z'),
    page(22n, '2026-07-19T03:00:00.000Z'),
    page(21n, '2026-07-19T02:00:00.000Z'),
  ];
  const prisma = {
    wikiNamespace: {
      async findUnique(args: { where: { code: string } }) { return args.where.code === 'category' ? { id: 2, code: 'category' } : null; },
      async findMany() { return [{ id: 1, code: 'main' }]; },
    },
    wikiPage: { async findUnique() { return null; }, async findMany() { return pages; } },
    wikiPageRevision: { async findMany() { return pages.map((item) => ({ id: item.currentRevisionId })); } },
    wikiPageLink: {
      async findMany(args: { take?: number }) {
        return args.take === 501 ? [] : pages.map((item) => ({ id: item.id, sourcePageId: item.id, sourceRevisionId: item.currentRevisionId, linkType: 'category' }));
      },
    },
    serverWikiReleaseLink: { async findMany() { return []; } },
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage({ page: candidate }: { page: { id: bigint } }) { if (candidate.id === 23n) throw new Error('hidden'); },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const first = await service.getCategoryMembers({ category: '초보자', limit: 2 });
  assert.deepEqual(first.items.map((item) => item.pageId), ['24', '22']);
  assert.ok(first.nextCursor);
  const second = await service.getCategoryMembers({ category: '초보자', limit: 2, cursor: first.nextCursor! });
  assert.deepEqual(second.items.map((item) => item.pageId), ['21']);
  assert.equal(second.nextCursor, null);
  await assert.rejects(
    () => service.getCategoryMembers({ category: '다른 분류', limit: 2, cursor: first.nextCursor! }),
    /cursor is invalid for the selected category filters or publication state/u,
  );
  await assert.rejects(
    () => service.getCategoryMembers({ category: '초보자', cursor: '24' }),
    /cursor is invalid for the selected category filters or publication state/u,
  );
});

test('category hierarchy exposes its document, parents, and current readable subcategories', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const category = { id: 101n, namespaceId: 2, spaceId: 2n, slug: '몹', title: '몹', displayTitle: '몹', currentRevisionId: 1001n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now, localPath: '몹' };
  const child = { ...category, id: 102n, slug: '적대적_몹', title: '적대적 몹', displayTitle: '적대적 몹', currentRevisionId: 1002n };
  const member = { ...category, id: 20n, namespaceId: 1, spaceId: 1n, slug: '좀비', title: '좀비', displayTitle: '좀비', currentRevisionId: 200n };
  const parentLink = { id: 10n, sourcePageId: 101n, sourceRevisionId: 1001n, targetSlug: '분류' };
  const childLink = { id: 9n, sourcePageId: 102n, sourceRevisionId: 1002n, targetSlug: '몹' };
  const memberLink = { id: 8n, sourcePageId: 20n, sourceRevisionId: 200n, targetSlug: '몹' };
  const prisma = {
    wikiNamespace: {
      async findUnique() { return { id: 2, code: 'category' }; },
      async findMany() { return [{ id: 1, code: 'main' }]; }
    },
    wikiPage: {
      async findUnique() { return category; },
      async findMany(args: { where: { namespaceId?: number | { not: number } } }) {
        return typeof args.where.namespaceId === 'number' ? [child] : [member];
      }
    },
    wikiPageLink: {
      async findMany(args: { where: { sourcePageId?: bigint }; take?: number }) {
        if (args.where.sourcePageId === category.id) return [parentLink];
        return [childLink, memberLink];
      }
    },
    serverWikiReleaseLink: { async findMany() { return []; } },
    wikiPageRevision: { async findMany() { return [{ id: 200n }]; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {},
    async filterReadableThreads({ items }: { items: unknown[] }) { return items; }
  } as unknown as WikiPermissionService;

  const response = await new WikiReadService(prisma, permissions).getCategoryMembers({ category: '몹' });

  assert.deepEqual(response.document, { pageId: '101', routePath: '/wiki/category/%EB%AA%B9' });
  assert.deepEqual(response.parents, [{ category: '분류', routePath: '/wiki/category/%EB%B6%84%EB%A5%98' }]);
  assert.deepEqual(response.subcategories.map((item) => item.pageId), ['102']);
  assert.deepEqual(response.items.map((item) => item.pageId), ['20']);
  assert.equal(response.isOrphan, false);
});

test('category hierarchy detects a cycle that cannot reach the root', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const categoryA = { id: 101n, namespaceId: 2, spaceId: 2n, slug: 'A', title: 'A', displayTitle: 'A', currentRevisionId: 1001n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now, localPath: 'A' };
  const categoryB = { ...categoryA, id: 102n, slug: 'B', title: 'B', displayTitle: 'B', currentRevisionId: 1002n };
  const linkAtoB = { id: 10n, sourcePageId: 101n, sourceRevisionId: 1001n, targetSlug: 'B' };
  const linkBtoA = { id: 9n, sourcePageId: 102n, sourceRevisionId: 1002n, targetSlug: 'A' };
  const prisma = {
    wikiNamespace: {
      async findUnique() { return { id: 2, code: 'category' }; },
      async findMany() { return []; }
    },
    wikiPage: {
      async findUnique(args: { where: { namespaceId_slug: { slug: string } } }) {
        return args.where.namespaceId_slug.slug === 'B' ? categoryB : categoryA;
      },
      async findMany(args: { where: { namespaceId?: number | { not: number } } }) {
        return typeof args.where.namespaceId === 'number' ? [categoryB] : [];
      }
    },
    wikiPageLink: {
      async findMany(args: { where: { sourcePageId?: bigint }; take?: number }) {
        if (args.where.sourcePageId === categoryA.id) return [linkAtoB];
        if (args.where.sourcePageId === categoryB.id) return [linkBtoA];
        return [linkBtoA];
      }
    },
    serverWikiReleaseLink: { async findMany() { return []; } },
    wikiPageRevision: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const response = await new WikiReadService(prisma, permissions).getCategoryMembers({ category: 'A' });

  assert.equal(response.isOrphan, true);
});

test('special orphaned categories excludes descendants reachable from the root', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = (id: bigint, slug: string, revisionId: bigint) => ({
    id, namespaceId: 2, spaceId: 2n, slug, title: slug, displayTitle: slug,
    currentRevisionId: revisionId, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 1n, createdAt: now, updatedAt: now, localPath: slug
  });
  const pages = [page(1n, '분류', 11n), page(2n, '연결됨', 12n), page(3n, '고립_A', 13n), page(4n, '고립_B', 14n)];
  const prisma = {
    wikiNamespace: { async findUnique() { return { id: 2, code: 'category' }; } },
    wikiPage: { async findMany() { return pages; } },
    wikiSpecialSnapshot: { async findUnique() { return {
      generation: 'generation-3', generatedAt: now, items: { projectionVersion: 2, items: pages.slice(2).map((item) => ({
        id: `page:${item.id}`, pageId: item.id.toString(), namespace: 'category', title: item.title,
        displayTitle: item.displayTitle, routePath: `/wiki/category/${encodeURIComponent(item.slug)}`, value: null, updatedAt: now.toISOString()
      })) }
    }; } }
  } as unknown as PrismaService;
  const permissions = { async filterReadablePages({ pages: candidates }: { pages: typeof pages }) { return [...candidates]; } } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getSpecialDocuments({ type: 'orphaned_categories' });

  assert.deepEqual(result.items.map((item) => item.pageId), ['3', '4']);
  assert.deepEqual(result.items.map((item) => item.routePath), [
    '/wiki/category/%EA%B3%A0%EB%A6%BD_A',
    '/wiki/category/%EA%B3%A0%EB%A6%BD_B'
  ]);
});

test('contributions resolve public changes to stable document routes', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = {
    id: 20n, namespaceId: 1, spaceId: 1n, slug: '기여_문서', title: '기여 문서', displayTitle: '기여 문서',
    currentRevisionId: 200n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, createdAt: now, updatedAt: now, localPath: '기여_문서'
  };
  const prisma = {
    wikiProfile: {
      async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; }
    },
    wikiRecentChange: {
      async findMany() {
        return [{ id: 9n, pageId: 20n, revisionId: 200n, changeType: 'edit', namespaceCode: 'main', summary: '보강', isMinor: false, createdAt: now }];
      }
    },
    wikiPageRevision: { async findMany() { return [{ id: 200n, editSummaryHidden: false }]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getContributions({ profileId: '5' });

  assert.equal(result.profile.displayName, '편집자');
  assert.equal(result.items[0]?.routePath, '/wiki/%EA%B8%B0%EC%97%AC_%EB%AC%B8%EC%84%9C');
  assert.equal(result.items[0]?.summary, '보강');
  assert.equal(result.items[0]?.summaryHidden, false);
});

test('server wiki edit contributions stop at the release and use its immutable page identity', async () => {
  const capturedAt = new Date('2026-07-19T04:30:00.000Z');
  const publishedAt = new Date('2026-07-19T05:00:00.000Z');
  const draftPage = {
    id: 20n, namespaceId: 7, spaceId: 40n, slug: 'draft-page', title: '초안 문서', displayTitle: '초안 문서',
    currentRevisionId: 202n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, ownerProfileId: null, createdAt: new Date('2026-07-18T00:00:00.000Z'),
    updatedAt: new Date('2026-07-19T06:00:00.000Z'), localPath: 'luna/draft-page',
  };
  const wiki = {
    id: 50n, spaceId: 40n, slug: 'luna', siteSlug: 'public-docs', status: 'active',
    publicationStatus: 'published', publishedReleaseId: 70n, publishedRelease: { version: 2, publishedAt },
  };
  const releaseItem = {
    id: 80n, releaseId: 70n, serverWikiId: 50n, spaceId: 40n, pageId: 20n, revisionId: 200n,
    namespaceId: 7, slug: 'luna/public-page', title: 'luna/public-page', displayTitle: '공개 문서', localPath: 'luna/public-page',
    pageType: 'article', protectionLevel: 'open', pageStatus: 'normal', createdBy: 5n, ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-19T04:00:00.000Z'), searchVector: '', createdAt: publishedAt,
  };
  const previousReleaseItem = {
    ...releaseItem,
    id: 79n,
    releaseId: 69n,
    revisionId: 199n,
    displayTitle: '이전 공개 문서',
    pageUpdatedAt: new Date('2026-07-19T03:00:00.000Z'),
  };
  const changes = [
    { id: 12n, spaceId: 40n, pageId: 20n, revisionId: 202n, changeType: 'edit', namespaceCode: 'server', summary: '후보 캡처 후 초안', isMinor: false, createdAt: new Date('2026-07-19T04:45:00.000Z') },
    { id: 11n, spaceId: 40n, pageId: 20n, revisionId: 200n, changeType: 'edit', namespaceCode: 'server', summary: '배포판', isMinor: false, createdAt: new Date('2026-07-19T04:00:00.000Z') },
    { id: 10n, spaceId: 40n, pageId: 20n, revisionId: 199n, changeType: 'edit', namespaceCode: 'server', summary: '이전 공개판', isMinor: false, createdAt: new Date('2026-07-19T03:00:00.000Z') },
  ];
  let preview = false;
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; } },
    wikiRecentChange: { async findMany() { return changes; } },
    wikiPageRevision: { async findMany() { return [199n, 200n, 202n].map((id) => ({ id, editSummaryHidden: false })); } },
    wikiPage: { async findMany() { return [draftPage]; } },
    wikiNamespace: { async findMany() { return [{ id: 7, code: 'server' }]; } },
    serverWiki: { async findMany() { return [wiki]; } },
    serverWikiReleaseItem: {
      async findMany(args: { include?: unknown }) {
        if (!args.include) return [releaseItem];
        return [
          { ...releaseItem, release: { version: 2, candidate: { createdAt: capturedAt } } },
          { ...previousReleaseItem, release: { version: 1, candidate: { createdAt: new Date('2026-07-19T03:30:00.000Z') } } },
        ];
      }
    },
  } as unknown as PrismaService;
  const permissions = {
    async canPreviewServerWikiSpace() { return preview; },
    async assertCanReadPage() {},
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const publicResult = await service.getContributions({ profileId: '5' });
  assert.deepEqual(publicResult.items.map((item) => [item.id, item.title]), [['11', '공개 문서'], ['10', '이전 공개 문서']]);
  assert.equal(publicResult.items[0]?.href, '/wiki/revision/200');
  assert.equal(publicResult.items[1]?.href, '/wiki/revision/199');

  preview = true;
  const previewResult = await service.getContributions({ profileId: '5' });
  assert.deepEqual(previewResult.items.map((item) => item.id), ['12', '11', '10']);
  assert.equal(previewResult.items[0]?.title, '초안 문서');
});

test('server wiki edit-request contributions expose only accepted release-era work outside preview', async () => {
  const publishedAt = new Date('2026-07-19T05:00:00.000Z');
  const draftPage = {
    id: 20n, namespaceId: 7, spaceId: 40n, slug: 'draft-page', title: '초안 문서', displayTitle: '초안 문서',
    currentRevisionId: 201n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, ownerProfileId: null, createdAt: publishedAt, updatedAt: new Date('2026-07-19T06:00:00.000Z'), localPath: 'luna/draft-page',
  };
  const wiki = {
    id: 50n, spaceId: 40n, slug: 'luna', siteSlug: 'public-docs', status: 'active',
    publicationStatus: 'published', publishedReleaseId: 70n, publishedRelease: { publishedAt },
  };
  const releaseItem = {
    id: 80n, releaseId: 70n, serverWikiId: 50n, spaceId: 40n, pageId: 20n, revisionId: 200n,
    namespaceId: 7, slug: 'luna/public-page', title: 'luna/public-page', displayTitle: '공개 문서', localPath: 'luna/public-page',
    pageType: 'article', protectionLevel: 'open', pageStatus: 'normal', createdBy: 5n, ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-19T04:00:00.000Z'), searchVector: '', createdAt: publishedAt,
  };
  const request = (id: bigint, acceptedRevisionId: bigint | null, createdAt: Date) => ({
    id, requestKind: 'edit', pageId: 20n, baseRevisionId: 199n, proposedContent: '제안 본문', editSummary: `제안 ${id}`,
    isMinor: false, status: acceptedRevisionId ? 'accepted' : 'pending', createdBy: 5n, reviewedBy: acceptedRevisionId ? 5n : null,
    reviewNote: acceptedRevisionId ? '승인' : null, acceptedRevisionId, createdAt, updatedAt: createdAt,
    reviewedAt: acceptedRevisionId ? createdAt : null,
  });
  const requests = [
    request(32n, null, new Date('2026-07-19T06:00:00.000Z')),
    request(31n, 200n, new Date('2026-07-19T04:00:00.000Z')),
  ];
  let preview = false;
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; } },
    wikiEditRequest: { async findMany() { return requests; } },
    wikiPageRevision: { async findMany() { return [{ id: 200n, editSummaryHidden: false }, { id: 201n, editSummaryHidden: false }]; } },
    wikiPage: { async findMany() { return [draftPage]; } },
    wikiNamespace: { async findMany() { return [{ id: 7, code: 'server' }]; } },
    serverWiki: { async findMany() { return [wiki]; } },
    serverWikiReleaseItem: { async findMany() { return [releaseItem]; } },
  } as unknown as PrismaService;
  const permissions = {
    async canPreviewServerWikiSpace() { return preview; },
    async assertCanReadPage() {},
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const publicResult = await service.getContributions({ profileId: '5', activity: 'edit-requests' });
  assert.deepEqual(publicResult.items.map((item) => [item.id, item.title]), [['31', '공개 문서']]);
  assert.equal(publicResult.items[0]?.href, '/serverWiki/public-docs/_tools/requests/public-page?request=31');

  preview = true;
  const previewResult = await service.getContributions({ profileId: '5', activity: 'edit-requests' });
  assert.deepEqual(previewResult.items.map((item) => item.id), ['32', '31']);
  assert.equal(previewResult.items[0]?.title, '초안 문서');
});

test('contributions redact a hidden revision summary even when the activity copy still contains it', async () => {
  const now = new Date('2026-07-17T00:00:00Z');
  const page = {
    id: 20n, namespaceId: 1, spaceId: 1n, slug: '기여_문서', title: '기여 문서', displayTitle: '기여 문서',
    currentRevisionId: 200n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, createdAt: now, updatedAt: now, localPath: '기여_문서'
  };
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; } },
    wikiRecentChange: { async findMany() { return [{ id: 9n, pageId: 20n, revisionId: 200n, changeType: 'edit', namespaceCode: 'main', summary: '유출되면 안 되는 요약', isMinor: false, createdAt: now }]; } },
    wikiPageRevision: { async findMany() { return [{ id: 200n, editSummaryHidden: true }]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getContributions({ profileId: '5' });
  assert.equal(result.items[0]?.summary, null);
  assert.equal(result.items[0]?.summaryHidden, true);
});

test('contribution tabs expose discussion, edit-request, and reviewer ledgers', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = {
    id: 20n, namespaceId: 1, spaceId: 1n, slug: '기여_문서', title: '기여 문서', displayTitle: '기여 문서',
    currentRevisionId: 200n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, createdAt: now, updatedAt: now, localPath: '기여_문서'
  };
  const editRequest = {
    id: 31n, pageId: 20n, baseRevisionId: 200n, proposedContent: '내용', editSummary: '수정 제안', isMinor: false,
    status: 'accepted', createdBy: 5n, reviewedBy: 5n, reviewNote: '승인함', acceptedRevisionId: 201n,
    createdAt: now, updatedAt: now, reviewedAt: now
  };
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; } },
    wikiDiscussionComment: { async findMany() { return [{ id: 41n, threadId: 40n, content: '토론 의견', status: 'normal', createdBy: 5n, createdAt: now, updatedAt: null }]; } },
    wikiDiscussionThread: { async findMany() { return [{ id: 40n, pageId: 20n, title: '문서 방향', status: 'open', createdBy: 5n, createdAt: now, updatedAt: now, pinnedCommentId: null }]; } },
    wikiEditRequest: { async findMany() { return [editRequest]; } },
    wikiPageRevision: { async findMany() { return [{ id: 200n, editSummaryHidden: false }, { id: 201n, editSummaryHidden: true }]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {},
    async filterReadableThreads({ items }: { items: unknown[] }) { return items; }
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const discussions = await service.getContributions({ profileId: '5', activity: 'discussions' });
  assert.equal(discussions.activity, 'discussions');
  assert.equal(discussions.items[0]?.href, '/wiki/discuss/20?thread=40&comment=41');
  assert.equal(discussions.items[0]?.summary, '토론 의견');

  const requests = await service.getContributions({ profileId: '5', activity: 'edit-requests' });
  assert.equal(requests.items[0]?.kind, 'edit_request');
  assert.equal(requests.items[0]?.status, 'accepted');
  assert.equal(requests.items[0]?.summary, null);
  assert.equal(requests.items[0]?.summaryHidden, true);

  const reviews = await service.getContributions({ profileId: '5', activity: 'reviews' });
  assert.equal(reviews.items[0]?.kind, 'review');
  assert.equal(reviews.items[0]?.summary, '승인함');
  assert.equal(reviews.items[0]?.summaryHidden, false);
  assert.equal(reviews.items[0]?.createdAt, now.toISOString());
});

test('create-page requests remain visible in author and reviewer contribution ledgers', async () => {
  const now = new Date('2026-07-17T00:00:00Z');
  const createRequest = (input: {
    id: bigint;
    title: string;
    status: string;
    createdBy: bigint;
    reviewedBy?: bigint | null;
    reviewNote?: string | null;
  }) => ({
    id: input.id,
    requestKind: 'create',
    pageId: null,
    baseRevisionId: null,
    targetNamespaceId: 1,
    targetNamespaceCode: 'main',
    targetSpaceId: 1n,
    targetTitle: input.title,
    targetSlug: input.title,
    targetDisplayTitle: input.title.replaceAll('_', ' '),
    targetPageType: 'article',
    targetOwnerProfileId: null,
    proposedContent: '새 문서 본문',
    editSummary: `${input.title} 제안`,
    isMinor: false,
    status: input.status,
    createdBy: input.createdBy,
    reviewedBy: input.reviewedBy ?? null,
    reviewNote: input.reviewNote ?? null,
    acceptedRevisionId: null,
    createdAt: now,
    updatedAt: now,
    reviewedAt: input.reviewedBy ? now : null,
    contributionPolicyVersion: null
  });
  const hidden = createRequest({ id: 33n, title: '숨김_대상', status: 'pending', createdBy: 5n });
  const visible = createRequest({ id: 32n, title: '공개_대상', status: 'pending', createdBy: 5n });
  const rejected = createRequest({
    id: 31n,
    title: '거절된_대상',
    status: 'rejected',
    createdBy: 9n,
    reviewedBy: 5n,
    reviewNote: '정책에 맞지 않음'
  });
  const prisma = {
    wikiProfile: {
      async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active', mergedIntoProfileId: null }; }
    },
    wikiEditRequest: {
      async findMany(args: { where: { reviewedBy?: unknown } }) {
        return args.where.reviewedBy ? [rejected] : [hidden, visible];
      }
    },
    wikiPageRevision: { async findMany() { return []; } },
    wikiPage: { async findMany() { return []; } },
    wikiNamespace: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadCreateTarget(input: { title: string }) {
      if (input.title === hidden.targetTitle) throw new Error('hidden target');
    }
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const requests = await service.getContributions({ profileId: '5', activity: 'edit-requests' });
  assert.equal(requests.items.length, 1, 'the scan must continue past a denied target');
  assert.deepEqual(requests.items[0], {
    id: '32',
    kind: 'edit_request',
    pageId: null,
    revisionId: null,
    changeType: 'edit_request',
    title: '공개 대상',
    namespace: 'main',
    routePath: '/wiki/%EA%B3%B5%EA%B0%9C_%EB%8C%80%EC%83%81',
    href: '/wiki/edit-requests/request/32?returnTo=%2Fwiki%2F%25EA%25B3%25B5%25EA%25B0%259C_%25EB%258C%2580%25EC%2583%2581',
    summary: '공개_대상 제안',
    summaryHidden: false,
    isMinor: false,
    status: 'pending',
    createdAt: now.toISOString()
  });

  const reviews = await service.getContributions({ profileId: '5', activity: 'reviews' });
  assert.equal(reviews.items[0]?.pageId, null);
  assert.equal(reviews.items[0]?.status, 'rejected');
  assert.equal(reviews.items[0]?.summary, '정책에 맞지 않음');
  assert.equal(reviews.items[0]?.href.startsWith('/wiki/edit-requests/request/31?'), true);
});

test('server wiki discussion contributions keep the canonical workspace route', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = {
    id: 20n, namespaceId: 2, spaceId: 9n, slug: 'luna_API_requests', title: 'luna/API/requests', displayTitle: 'API requests',
    currentRevisionId: 200n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, createdAt: now, updatedAt: now, localPath: 'luna/API/requests'
  };
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; } },
    wikiDiscussionComment: { async findMany() { return [{ id: 41n, threadId: 40n, content: '토론 의견', status: 'normal', createdBy: 5n, createdAt: now, updatedAt: null }]; } },
    wikiDiscussionThread: { async findMany() { return [{ id: 40n, pageId: 20n, title: '문서 방향', status: 'open', createdBy: 5n, createdAt: now, updatedAt: now, pinnedCommentId: null }]; } },
    wikiEditRequest: { async findMany() { return [{ id: 31n, pageId: 20n, baseRevisionId: 200n, proposedContent: '내용', editSummary: '수정 제안', isMinor: false, status: 'accepted', createdBy: 5n, reviewedBy: 5n, reviewNote: '승인함', acceptedRevisionId: 201n, createdAt: now, updatedAt: now, reviewedAt: now }]; } },
    wikiPageRevision: { async findMany() { return [{ id: 200n, editSummaryHidden: false }, { id: 201n, editSummaryHidden: false }]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 2, code: 'server' }]; } },
    serverWiki: { async findMany() { return [{ id: 50n, spaceId: 9n, slug: 'luna', siteSlug: 'luna-docs', status: 'active', publicationStatus: 'published', publishedReleaseId: 70n }]; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {},
    async canPreviewServerWikiSpace() { return true; },
    async filterReadableThreads({ items }: { items: unknown[] }) { return items; }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getContributions({ profileId: '5', activity: 'discussions' });

  assert.equal(result.items[0]?.routePath, '/serverWiki/luna-docs/API/requests');
  assert.equal(result.items[0]?.href, '/serverWiki/luna-docs/_tools/discuss/API/requests?thread=40&comment=41');

  const requests = await new WikiReadService(prisma, permissions).getContributions({ profileId: '5', activity: 'edit-requests' });
  assert.equal(requests.items[0]?.routePath, '/serverWiki/luna-docs/API/requests');
  assert.equal(requests.items[0]?.href, '/serverWiki/luna-docs/_tools/requests/API/requests?request=31');
});

test('server wiki discussion contributions use released identity and conceal unpublished draft pages', async () => {
  const now = new Date('2026-07-19T07:00:00.000Z');
  const page = {
    id: 20n, namespaceId: 2, spaceId: 9n, slug: 'draft-page', title: 'luna/draft-page', displayTitle: '초안 문서',
    currentRevisionId: 201n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 5n,
    createdAt: now, updatedAt: now, localPath: 'luna/draft-page',
  };
  const wiki = {
    id: 50n, spaceId: 9n, slug: 'luna', siteSlug: 'public-docs', status: 'active',
    publicationStatus: 'published', publishedReleaseId: 70n as bigint | null, publishedRelease: { publishedAt: new Date('2026-07-19T05:00:00.000Z') },
  };
  const releaseItem = {
    id: 80n, releaseId: 70n, serverWikiId: 50n, spaceId: 9n, pageId: 20n, revisionId: 200n,
    namespaceId: 2, slug: 'luna/public-page', title: 'luna/public-page', displayTitle: '공개 문서', localPath: 'luna/public-page',
    pageType: 'article', protectionLevel: 'open', pageStatus: 'normal', createdBy: 5n, ownerProfileId: null,
    pageUpdatedAt: new Date('2026-07-19T04:00:00.000Z'), searchVector: '', createdAt: now,
  };
  let preview = false;
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; } },
    wikiDiscussionComment: { async findMany() { return [{ id: 41n, threadId: 40n, content: '배포 후 토론', status: 'normal', createdBy: 5n, createdAt: now, updatedAt: null }]; } },
    wikiDiscussionThread: { async findMany() { return [{ id: 40n, pageId: 20n, title: '문서 방향', status: 'open', createdBy: 5n, createdAt: now, updatedAt: now, pinnedCommentId: null }]; } },
    wikiPageRevision: { async findMany() { return [{ id: 201n }]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 2, code: 'server' }]; } },
    serverWiki: { async findMany() { return [wiki]; } },
    serverWikiReleaseItem: { async findMany() { return [releaseItem]; } },
  } as unknown as PrismaService;
  const permissions = {
    async canPreviewServerWikiSpace() { return preview; },
    async filterReadableThreads({ items }: { items: unknown[] }) { return items; },
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions);

  const publicResult = await service.getContributions({ profileId: '5', activity: 'discussions' });
  assert.equal(publicResult.items[0]?.routePath, '/serverWiki/public-docs/public-page');
  assert.equal(publicResult.items[0]?.href, '/serverWiki/public-docs/_tools/discuss/public-page?thread=40&comment=41');

  wiki.publicationStatus = 'draft';
  wiki.publishedReleaseId = null;
  const unpublished = await service.getContributions({ profileId: '5', activity: 'discussions' });
  assert.deepEqual(unpublished.items, []);

  preview = true;
  const previewResult = await service.getContributions({ profileId: '5', activity: 'discussions' });
  assert.equal(previewResult.items[0]?.routePath, '/serverWiki/public-docs/draft-page');
});

test('discussion contributions omit threads hidden by thread ACL in one batch', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = {
    id: 20n, namespaceId: 1, spaceId: 1n, slug: 'private', title: 'private', displayTitle: 'Private',
    currentRevisionId: 200n, pageType: 'article', protectionLevel: 'open', status: 'normal',
    createdBy: 5n, createdAt: now, updatedAt: now, localPath: 'private'
  };
  let batches = 0;
  const prisma = {
    wikiProfile: { async findUnique() { return { id: 5n, username: 'editor', displayName: '편집자', status: 'active' }; } },
    wikiDiscussionComment: { async findMany() { return [{ id: 41n, threadId: 40n, content: '비공개 의견', status: 'normal', createdBy: 5n, createdAt: now, updatedAt: null }]; } },
    wikiDiscussionThread: { async findMany() { return [{ id: 40n, pageId: 20n, title: '비공개 토론', status: 'open', createdBy: 5n, createdAt: now, updatedAt: now, pinnedCommentId: null }]; } },
    wikiPageRevision: { async findMany() { return [{ id: 200n }]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } }
  } as unknown as PrismaService;
  const permissions = {
    async filterReadableThreads() { batches += 1; return []; }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getContributions({ profileId: '5', activity: 'discussions' });

  assert.equal(batches, 1);
  assert.deepEqual(result.items, []);
});

function createReadService(options: {
  readonly cacheHtml?: string | null;
  readonly contentRaw?: string;
  readonly onCacheLookup?: (where: unknown) => void;
  readonly onCacheCreate?: (data: unknown) => void;
  readonly files?: ReadonlyArray<{
    filename: string;
    publicPath: string;
    mimeType: string;
    originalName: string | null;
    visibility?: string;
    ownerAccountId?: string | null;
    linkedResourceType?: string | null;
    linkedResourceId?: string | null;
    license?: string | null;
    sourceUrl?: string | null;
    sourceText?: string | null;
  }>;
  readonly includeService?: WikiIncludeService;
  readonly denyLinkedPage?: boolean;
  readonly existingLinkSlugs?: readonly string[];
  readonly onIndexWrite?: () => void;
}) {
  const now = new Date('2026-07-05T00:00:00.000Z');
  const prisma = {
    wikiNamespace: {
      async findUnique() {
        return { id: 1, code: 'main' };
      },
      async findMany() {
        return [{ id: 1, code: 'main' }];
      }
    },
    wikiPage: {
      async findUnique(args?: { where?: { id?: bigint } }) {
        return {
          id: args?.where?.id ?? 10n,
          spaceId: 20n,
          slug: '대문',
          title: '대문',
          displayTitle: '대문',
          currentRevisionId: 30n,
          pageType: 'article',
          protectionLevel: 'open',
          status: 'normal',
          updatedAt: now
        };
      },
      async findMany() {
        return (options.existingLinkSlugs ?? []).map((slug, index) => ({
          id: BigInt(100 + index),
          namespaceId: 1,
          spaceId: 20n,
          localPath: slug,
          slug,
          title: slug,
          displayTitle: slug,
          currentRevisionId: BigInt(200 + index),
          pageType: 'article',
          protectionLevel: 'open',
          status: 'normal',
          createdBy: null,
          updatedAt: now
        }));
      }
    },
    wikiPageRevision: {
      async findFirst() {
        return {
          id: 30n,
          pageId: 10n,
          revisionNo: 1,
          contentHash: 'a'.repeat(64),
          contentRaw: options.contentRaw ?? "'''현재''' 문서",
          createdAt: now,
          createdBy: 40n,
          visibility: 'public'
        };
      },
      async findMany() {
        return (options.existingLinkSlugs ?? []).map((_, index) => ({
          id: BigInt(200 + index),
          pageId: BigInt(100 + index),
          visibility: 'public'
        }));
      }
    },
    wikiPageRenderCache: {
      async findUnique(args: { where: unknown }) {
        options.onCacheLookup?.(args.where);
        return options.cacheHtml ? { html: options.cacheHtml } : null;
      },
      async create(args: { data: unknown }) {
        options.onCacheCreate?.(args.data);
        return { id: 1n };
      }
    },
    uploadedFile: {
      async findMany() {
        return (options.files ?? []).map((file) => ({
          usageContext: 'wiki_editor',
          visibility: 'public',
          status: 'active',
          ownerAccountId: null,
          linkedResourceType: null,
          linkedResourceId: null,
          license: null,
          sourceUrl: null,
          sourceText: null,
          ...file
        }));
      }
    },
    serverWiki: {
      async findFirst() {
        return null;
      }
    },
    server: {
      async findUnique() {
        return null;
      }
    }
  };
  const permissions = {
    async assertCanReadPage({ page }: { page: { id: bigint } | null }) {
      if (options.denyLinkedPage && page?.id !== 10n) throw new Error('denied');
      return undefined;
    },
    async assertCanReadSpace() { return undefined; }
  };
  return new WikiReadService(
    prisma as unknown as PrismaService,
    permissions as unknown as WikiPermissionService,
    { async replaceForRevision() { options.onIndexWrite?.(); } } as never,
    options.includeService
  );
}

test('wiki reads never rewrite link or search indexes', async () => {
  let indexWrites = 0;
  const service = createReadService({
    contentRaw: '[[연결 문서]] [[분류:가이드]]',
    onIndexWrite() { indexWrites += 1; }
  });

  await service.getPage('main', '대문');

  assert.equal(indexWrites, 0);
});

test('wiki read uses matching renderer cache version', async () => {
  let lookupWhere: unknown;
  let created = false;
  const service = createReadService({
    cacheHtml: '<p>cached current renderer</p>',
    onCacheLookup(where) {
      lookupWhere = where;
    },
    onCacheCreate() {
      created = true;
    }
  });

  const page = await service.getPage('main', '대문');

  assert.equal(page.html, '<p>cached current renderer</p>');
  assert.deepEqual(lookupWhere, {
    revisionId_rendererVersion: {
      revisionId: 30n,
      rendererVersion: WIKI_RENDERER_VERSION
    }
  });
  assert.equal(created, false);
});

test('wiki read ignores stale renderer cache and writes current version', async () => {
  let createdData: unknown;
  const service = createReadService({
    cacheHtml: null,
    onCacheCreate(data) {
      createdData = data;
    }
  });

  const page = await service.getPage('main', '대문');

  assert.notEqual(page.html, '<p>legacy renderer</p>');
  assert.equal(page.html.includes('<strong>현재</strong> 문서'), true);
  const data = createdData as {
    pageId: bigint;
    revisionId: bigint;
    rendererVersion: string;
    html: string;
    createdAt: Date;
  };
  assert.equal(data.pageId, 10n);
  assert.equal(data.revisionId, 30n);
  assert.equal(data.rendererVersion, WIKI_RENDERER_VERSION);
  assert.equal(data.html, page.html);
  assert.equal(data.createdAt instanceof Date, true);
});

test('wiki read ignores persistent render caches for file-dependent revisions', async () => {
  let lookedUpCache = false;
  let createdCache = false;
  const service = createReadService({
    cacheHtml: '<p>파일 없음: logo.png</p>',
    contentRaw: '[[파일:logo.png|섬네일|width=320&align=center&object-fit=contain&caption=서버+로고]]',
    files: [{ filename: 'logo.png', publicPath: '/files/logo.png', mimeType: 'image/png', originalName: 'logo.png' }],
    onCacheLookup() { lookedUpCache = true; },
    onCacheCreate() { createdCache = true; }
  });
  const page = await service.getPage('main', '대문');
  assert.equal(lookedUpCache, false);
  assert.equal(createdCache, false);
  assert.match(page.html, /<img class="wiki-file-image" src="\/files\/logo\.png"/);
  assert.match(page.html, /wiki-file-align-center/);
  assert.match(page.html, /style="width:320px"/);
  assert.equal(page.html.includes('파일 없음'), false);
});

test('wiki read resolves inline files inside prose, lists, and table cells', async () => {
  const service = createReadService({
    contentRaw: '본문 [[파일:logo.png|본문 아이콘]]\n * 목록 [[파일:logo.png|목록 아이콘]]\n||셀 [[파일:logo.png|표 아이콘]]||',
    files: [{ filename: 'logo.png', publicPath: '/files/logo.png', mimeType: 'image/png', originalName: 'logo.png' }],
  });

  const page = await service.getPage('main', '대문');

  assert.equal((page.html.match(/<img class="wiki-file-image" src="\/files\/logo\.png"/g) ?? []).length, 3);
  assert.equal(page.html.includes('파일 없음'), false);
});

test('wiki read marks only readable missing links and bypasses shared render cache', async () => {
  let lookedUpCache = false;
  let createdCache = false;
  const service = createReadService({
    cacheHtml: '<p>stale link cache</p>',
    contentRaw: '[[있는 문서]] · [[없는 문서]]',
    existingLinkSlugs: ['있는_문서'],
    onCacheLookup() { lookedUpCache = true; },
    onCacheCreate() { createdCache = true; }
  });

  const page = await service.getPage('main', '대문');

  assert.equal(lookedUpCache, false);
  assert.equal(createdCache, false);
  assert.match(page.html, /class="wiki-link" href="\/wiki\/%EC%9E%88%EB%8A%94_%EB%AC%B8%EC%84%9C"/);
  assert.match(page.html, /class="wiki-link missing" href="\/wiki\/%EC%97%86%EB%8A%94_%EB%AC%B8%EC%84%9C" title="문서 없음"/);
});

test('released server wiki link existence is pinned to the release instead of the draft worktree', async () => {
  const now = new Date('2026-07-19T00:00:00.000Z');
  const releaseItem = {
    id: 1n,
    releaseId: 70n,
    serverWikiId: 50n,
    spaceId: 40n,
    namespaceId: 7,
    pageId: 30n,
    revisionId: 20n,
    localPath: 'luna/공개',
    slug: 'luna/공개',
    title: 'luna/공개',
    displayTitle: '공개',
    pageType: 'article',
    protectionLevel: 'open',
    pageStatus: 'normal',
    createdBy: 10n,
    ownerProfileId: null,
    pageUpdatedAt: now,
    createdAt: now,
  };
  const prisma = {
    wikiNamespace: {
      async findMany() { return [{ id: 7, code: 'server' }]; },
    },
    serverWikiReleaseItem: {
      async findMany() { return [releaseItem]; },
    },
    wikiPageRevision: {
      async findMany() { return [{ id: 20n, pageId: 30n, visibility: 'public' }]; },
    },
    wikiPage: {
      async findMany() { throw new Error('same-tenant draft pages must not decide released link existence'); },
    },
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {},
  } as unknown as WikiPermissionService;
  const service = new WikiReadService(prisma, permissions) as unknown as {
    findMissingLinks(
      sourceNamespace: string,
      sourceLocalPath: string,
      targets: readonly string[],
      access: unknown,
      releaseId?: bigint,
    ): Promise<Set<string>>;
  };

  const missing = await service.findMissingLinks('server', 'luna/대문', ['공개', '초안'], { accountId: null }, 70n);

  assert.equal(missing.has('main:공개'), false);
  assert.equal(missing.has('main:초안'), true);
});

test('wiki read applies missing-link ACL state to links introduced by includes', async () => {
  const included = parseMarkup('포함 본문 [[없는 포함 링크]]');
  const includeService = {
    async expand() {
      return {
        ast: [{ type: 'include' as const, target: '틀:링크', params: {}, state: 'resolved' as const, children: included.ast }],
        includedSourceBytes: 32
      };
    }
  } as unknown as WikiIncludeService;
  const service = createReadService({
    contentRaw: '[include(틀:링크)]',
    includeService
  });

  const page = await service.getPage('main', '대문');

  assert.deepEqual(page.links, ['없는 포함 링크']);
  assert.match(page.html, /class="wiki-link missing"[^>]+title="문서 없음"/u);
});

test('wiki read exposes attribution only for files readable through their linked resource', async () => {
  const readable = createReadService({
    contentRaw: '[[파일:licensed.webp|섬네일|가이드]]',
    files: [{
      filename: 'licensed.webp',
      publicPath: '/v1/files/public/licensed.webp/raw',
      mimeType: 'image/webp',
      originalName: 'licensed.png',
      visibility: 'restricted',
      linkedResourceType: 'wiki_page',
      linkedResourceId: '11',
      license: 'cc-by-4.0',
      sourceUrl: 'https://example.com/source',
      sourceText: '원 제작자'
    }]
  });
  const denied = createReadService({
    contentRaw: '[[파일:licensed.webp|섬네일|가이드]]',
    files: [{
      filename: 'licensed.webp',
      publicPath: '/v1/files/public/licensed.webp/raw',
      mimeType: 'image/webp',
      originalName: 'licensed.png',
      visibility: 'restricted',
      linkedResourceType: 'wiki_page',
      linkedResourceId: '11',
      license: 'cc-by-4.0',
      sourceUrl: 'https://example.com/source',
      sourceText: '비공개 제작자'
    }],
    denyLinkedPage: true
  });

  const readablePage = await readable.getPage('main', '대문');
  const deniedPage = await denied.getPage('main', '대문');
  assert.match(readablePage.html, /CC BY 4\.0/);
  assert.match(readablePage.html, /원 제작자/);
  assert.match(deniedPage.html, /파일 없음/);
  assert.equal(deniedPage.html.includes('비공개 제작자'), false);
  assert.equal(deniedPage.html.includes('example.com'), false);
});

test('wiki read never reuses or stores persistent caches for include-dependent revisions', async () => {
  let lookedUpCache = false;
  let createdCache = false;
  const service = createReadService({
    cacheHtml: '<p>비공개 포함 결과</p>',
    contentRaw: '[include(틀:권한별 안내)]',
    onCacheLookup() { lookedUpCache = true; },
    onCacheCreate() { createdCache = true; }
  });

  const page = await service.getPage('main', '대문');

  assert.equal(lookedUpCache, false);
  assert.equal(createdCache, false);
  assert.equal(page.html.includes('비공개 포함 결과'), false);
  assert.match(page.html, /포함 문서는 저장한 뒤/);
});

test('wiki read rejects expanded include output beyond the rendered HTML limit', async () => {
  const includeService = {
    async expand() {
      return {
        ast: [{ type: 'paragraph' as const, children: [{ type: 'text' as const, text: '&'.repeat(500_000) }] }],
        includedSourceBytes: 500_000
      };
    }
  } as unknown as WikiIncludeService;
  const service = createReadService({
    contentRaw: '[include(틀:큰 문서)]',
    includeService
  });

  await assert.rejects(service.getPage('main', '대문'), /exceeds the size limit/);
});

function createRedirectReadService(
  pages: Record<string, { id: bigint; title: string; contentRaw: string }>,
  usernameAliases: Record<string, string> = {},
) {
  const now = new Date('2026-07-05T00:00:00.000Z');
  let currentSlug = '대문';
  const prisma = {
    wikiNamespace: {
      async findUnique(args: { where: { code?: string; id?: number } }) {
        return { id: 1, code: args.where.code ?? 'user' };
      }
    },
    wikiPage: {
      async findUnique(args: { where: { namespaceId_slug: { slug: string } } }) {
        currentSlug = args.where.namespaceId_slug.slug;
        const page = pages[currentSlug];
        if (!page) {
          return null;
        }
        return {
          id: page.id,
          spaceId: 20n,
          namespaceId: 1,
          localPath: currentSlug,
          slug: currentSlug,
          title: page.title,
          displayTitle: page.title,
          currentRevisionId: page.id + 100n,
          pageType: 'article',
          protectionLevel: 'open',
          status: 'normal',
          updatedAt: now
        };
      }
    },
    wikiUsernameAlias: {
      async findUnique(args: { where: { oldUsername: string } }) {
        return usernameAliases[args.where.oldUsername] ? { profileId: 99n } : null;
      }
    },
    wikiProfile: {
      async findUnique() {
        const username = Object.values(usernameAliases)[0];
        return username ? { username, status: 'active' } : null;
      }
    },
    wikiPageRevision: {
      async findFirst() {
        const page = pages[currentSlug];
        return page
          ? {
              id: page.id + 100n,
              pageId: page.id,
              revisionNo: 1,
              contentHash: 'b'.repeat(64),
              contentRaw: page.contentRaw,
              createdAt: now,
              createdBy: 40n,
              visibility: 'public'
            }
          : null;
      }
    },
    wikiPageRenderCache: {
      async findUnique() {
        return null;
      },
      async create() {
        return { id: 1n };
      }
    },
    uploadedFile: {
      async findMany() {
        return [];
      }
    },
    serverWiki: {
      async findFirst() {
        return null;
      }
    },
    server: {
      async findUnique() {
        return null;
      }
    }
  };
  const permissions = {
    async assertCanReadPage() {
      return undefined;
    },
    async assertCanUsePageAction() {
      return undefined;
    }
  };
  return new WikiReadService(
    prisma as unknown as PrismaService,
    permissions as unknown as WikiPermissionService
  );
}

test('wiki username aliases redirect both the root and descendant paths to the canonical tree', async () => {
  const service = createRedirectReadService({
    newname: { id: 20n, title: 'newname', contentRaw: 'root' },
    'newname/child': { id: 21n, title: 'newname/child', contentRaw: 'child' },
  }, { oldname: 'newname' });

  const root = await service.getPage('user', 'oldname');
  const child = await service.getPage('user', 'oldname/child');

  assert.equal(root.title, 'newname');
  assert.equal(root.redirectedFrom?.title, 'oldname');
  assert.equal(child.title, 'newname/child');
  assert.equal(child.redirectedFrom?.title, 'oldname/child');
});

test('wiki read follows redirect pages by default', async () => {
  const service = createRedirectReadService({
    대문: { id: 10n, title: '대문', contentRaw: '#REDIRECT [[목표]]' },
    목표: { id: 11n, title: '목표', contentRaw: "'''목표''' 문서" }
  });

  const page = await service.getPage('main', '대문');

  assert.equal(page.id, '11');
  assert.equal(page.redirectTarget, null);
  assert.deepEqual(page.redirectedFrom, {
    namespace: 'main',
    title: '대문',
    path: '/wiki/%EB%8C%80%EB%AC%B8'
  });
});

test('wiki read can return redirect page when redirect is disabled', async () => {
  const service = createRedirectReadService({
    대문: { id: 10n, title: '대문', contentRaw: '#REDIRECT [[목표]]' },
    목표: { id: 11n, title: '목표', contentRaw: "'''목표''' 문서" }
  });

  const page = await service.getPage('main', '대문', null, { followRedirects: false });

  assert.equal(page.id, '10');
  assert.equal(page.redirectTarget, '목표');
  assert.equal(page.redirectedFrom, null);
});

test('wiki read detects redirect loops', async () => {
  const service = createRedirectReadService({
    대문: { id: 10n, title: '대문', contentRaw: '#REDIRECT [[목표]]' },
    목표: { id: 11n, title: '목표', contentRaw: '#REDIRECT [[대문]]' }
  });

  await assert.rejects(() => service.getPage('main', '대문'), /redirect loop/i);
});
