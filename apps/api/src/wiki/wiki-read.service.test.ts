import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseMarkup, WIKI_RENDERER_VERSION } from '@minewiki/wiki-core';
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

test('public pagecount filters revisions, ACLs, and namespaces without request-specific address context', async () => {
  const pages = [
    { id: 1n, namespaceId: 1, spaceId: 10n, title: '공개', protectionLevel: 'open', status: 'normal', currentRevisionId: 11n },
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
      status: { in: ['normal', 'active', 'published'] },
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
    wikiPageRevision: { async findMany() { return []; } }
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
      async findFirst() { return { spaceId: 5643n, status: 'active' }; },
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
  } as unknown as WikiPermissionService;
  const result = await new WikiReadService(prisma, permissions).search({
    q: '명령어',
    serverSlug: '4cfjfkz-ac256525',
  });

  assert.deepEqual(result, { items: [], nextCursor: null });
  assert.equal(rawQueries.length, 1);
  assert.match(rawQueries[0]!.sql, /p\.namespace_id = \?/u);
  assert.match(rawQueries[0]!.sql, /p\.space_id = \?/u);
  assert.equal(rawQueries[0]!.values.includes(7), true);
  assert.equal(rawQueries[0]!.values.includes(5643n), true);
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
  assert.equal(revisionQueryCount, 2);
  assert.equal(JSON.stringify(revisionSelects[0]).includes('contentRaw'), false);
  assert.equal(JSON.stringify(revisionSelects[1]).includes('contentRaw'), true);
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
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
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
    { id: 1n, namespaceId: 1, spaceId: 1n, localPath: '대문', slug: '대문', title: '대문', displayTitle: '대문', currentRevisionId: 11n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: new Date('2025-01-01T00:00:00Z') },
    { id: 3n, namespaceId: 2, spaceId: 2n, localPath: '대문', slug: '대문', title: '대문', displayTitle: '대문', currentRevisionId: 13n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now }
  ];
  let pageQuery: unknown;
  const prisma = {
    wikiPage: { async findMany(args: unknown) { pageQuery = args; return pages; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }, { id: 2, code: 'help' }]; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {},
    async filterReadableThreads({ items }: { items: unknown[] }) { return items; }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).suggest({ q: '대문', limit: 8 });

  assert.equal(result.exactMatch?.pageId, '1');
  assert.deepEqual(result.items.map((item) => item.pageId), ['1', '3', '2']);
  assert.equal(JSON.stringify(pageQuery).includes('contentRaw'), false);
});

test('revision history uses a stable revision number cursor beyond the first page', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  let revisionWhere: unknown;
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'doc', slug: 'doc', title: '문서', displayTitle: '문서', currentRevisionId: 4n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const makeRevision = (revisionNo: number) => ({ id: BigInt(revisionNo), pageId: 1n, revisionNo, editSummary: `요약 ${revisionNo}`, editSummaryHidden: revisionNo === 3, isMinor: false, createdBy: 1n, createdAt: now, contentHash: String(revisionNo), contentSize: revisionNo });
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageRevision: { async findMany(args: { where: unknown }) { revisionWhere = args.where; return [makeRevision(4), makeRevision(3), makeRevision(2)]; } },
    wikiProfile: { async findMany() { return [{ id: 1n, displayName: 'editor' }]; } }
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

test('historical revision rendering keeps raw source private and applies read plus history ACLs', async () => {
  const now = new Date('2026-07-16T00:00:00Z');
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'history', slug: 'history', title: 'History', displayTitle: 'History', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const revision = { id: 11n, pageId: 1n, revisionNo: 3, parentRevisionId: 10n, contentRaw: '= Historical =\nRendered body', contentHash: 'hash', contentSize: 28, syntaxVersion: 'bwm-0.3', editSummary: 'old copy', editSummaryHidden: false, isMinor: true, editTags: null, contentAst: null, createdBy: 2n, actorType: 'user', actorUserId: 2n, actorIp: null, actorIpText: null, actorIpHash: null, createdAt: now, visibility: 'public' };
  const prisma = {
    wikiPage: { async findUnique() { return page; }, async findFirst() { return { namespaceId: 1 }; } },
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; } },
    wikiPageRevision: { async findFirst(input: { where: { id: bigint } }) { return input.where.id === 11n ? revision : null; } },
    wikiPageRenderCache: { async findUnique() { return null; }, async create() { return {}; } }
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
  assert.match(result.html, /Historical/u);
  assert.equal('contentRaw' in (result as unknown as Record<string, unknown>), false);
  assert.equal(readRevisionId, 11n);
  assert.deepEqual(actions, ['history']);

  revision.editSummaryHidden = true;
  const redacted = await new WikiReadService(prisma, permissions).getRenderedRevision('11');
  assert.equal(redacted.revision.editSummary, null);
  assert.equal(redacted.revision.editSummaryHidden, true);
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
      async findMany() { return [{ spaceId: 1n, slug: 'alpha' }]; }
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

  const result = await new WikiReadService(prisma, permissions).getRecent({ cursor: '11', limit: 2, changeType: 'edit', namespace: 'server', minor: 'false' });

  assert.deepEqual(recentQuery, {
    where: { id: { lt: 11n }, changeType: 'edit', namespaceCode: 'server', isMinor: false },
    orderBy: [{ id: 'desc' }],
    take: 9
  });
  assert.equal(pageQueryCount, 1);
  assert.deepEqual([...checked.entries()], [[1n, 1], [2n, 1]]);
  assert.deepEqual(result.items.map((item) => item.id), ['10', '8']);
  assert.equal(result.items[0]?.routePath, '/serverWiki/alpha/%EA%B3%B5%EA%B0%9C_%EB%AC%B8%EC%84%9C');
  assert.equal(result.nextCursor, '8');
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
    { id: 2n, namespaceId: 1, spaceId: 1n, localPath: 'long', slug: 'long', title: '김', displayTitle: '김', currentRevisionId: 12n, currentContentSize: 500, currentCategoryCount: 0, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now }
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
      generation: 'generation-1', generatedAt: now, items: [
        { id: 'wanted:main:없는_문서', pageId: null, namespace: 'main', title: '없는_문서', displayTitle: '없는_문서', routePath: '/wiki/%EC%97%86%EB%8A%94_%EB%AC%B8%EC%84%9C', value: 2, updatedAt: null }
      ]
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
      generation: 'generation-2', generatedAt: now, items: [
        { id: 'category:가이드', pageId: null, namespace: 'category', title: '가이드', displayTitle: '가이드', routePath: '/wiki/category/%EA%B0%80%EC%9D%B4%EB%93%9C', value: 1, updatedAt: null },
        { id: 'category:초보자', pageId: null, namespace: 'category', title: '초보자', displayTitle: '초보자', routePath: '/wiki/category/%EC%B4%88%EB%B3%B4%EC%9E%90', value: 1, updatedAt: null }
      ]
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
          items: snapshots[args.where.type_namespaceCode.type]
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

test('identified special snapshot reads fail closed for legacy or truncated aggregate metadata', async () => {
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
});

test('blame keeps attribution for lines preserved across later revisions', async () => {
  const now = new Date('2026-07-13T00:00:00Z');
  const page = { id: 1n, namespaceId: 1, spaceId: 1n, localPath: 'doc', slug: 'doc', title: '문서', displayTitle: '문서', currentRevisionId: 12n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now };
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
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
  const current = { id: 20n, namespaceId: 1, spaceId: 1n, slug: '가이드', title: '가이드', displayTitle: '가이드', currentRevisionId: 200n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n, createdAt: now, updatedAt: now, localPath: '가이드' };
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
    wikiPage: {
      async findUnique() { return null; },
      async findMany() { return [current, stale, hidden]; }
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
    }
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
    }
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
      generation: 'generation-3', generatedAt: now, items: pages.slice(2).map((item) => ({
        id: `page:${item.id}`, pageId: item.id.toString(), namespace: 'category', title: item.title,
        displayTitle: item.displayTitle, routePath: `/wiki/category/${encodeURIComponent(item.slug)}`, value: null, updatedAt: now.toISOString()
      }))
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
    wikiPageRevision: { async findMany() { return [{ id: 201n, editSummaryHidden: true }]; } },
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
    wikiPageRevision: { async findMany() { return [{ id: 201n, editSummaryHidden: false }]; } },
    wikiPage: { async findMany() { return [page]; } },
    wikiNamespace: { async findMany() { return [{ id: 2, code: 'server' }]; } },
    serverWiki: { async findMany() { return [{ spaceId: 9n, slug: 'luna', siteSlug: 'luna-docs' }]; } }
  } as unknown as PrismaService;
  const permissions = {
    async assertCanReadPage() {},
    async filterReadableThreads({ items }: { items: unknown[] }) { return items; }
  } as unknown as WikiPermissionService;

  const result = await new WikiReadService(prisma, permissions).getContributions({ profileId: '5', activity: 'discussions' });

  assert.equal(result.items[0]?.routePath, '/serverWiki/luna-docs/API/requests');
  assert.equal(result.items[0]?.href, '/serverWiki/luna-docs/_tools/discuss/API/requests?thread=40&comment=41');

  const requests = await new WikiReadService(prisma, permissions).getContributions({ profileId: '5', activity: 'edit-requests' });
  assert.equal(requests.items[0]?.routePath, '/serverWiki/luna-docs/API/requests');
  assert.equal(requests.items[0]?.href, '/serverWiki/luna-docs/_tools/requests/API/requests?request=31');
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
