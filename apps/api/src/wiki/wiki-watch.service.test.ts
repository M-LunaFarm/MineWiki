import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import { WikiWatchService } from './wiki-watch.service';

const session = { userId: 'account-1' } as SessionPayload;
const page = {
  id: 10n,
  namespaceId: 1,
  spaceId: 2n,
  localPath: 'guide',
  slug: 'guide',
  title: 'Guide',
  displayTitle: 'Guide',
  currentRevisionId: 30n,
  pageType: 'article',
  protectionLevel: 'open',
  status: 'normal',
  createdBy: 20n,
  createdAt: new Date('2026-01-01T00:00:00Z'),
  updatedAt: new Date('2026-01-02T00:00:00Z')
};

function createService(watch: { lastSeenRevisionId: bigint | null } | null, onUpsert?: (args: unknown) => void) {
  const prisma = {
    wikiPage: { async findUnique() { return page; } },
    wikiPageWatch: {
      async findUnique() { return watch; },
      async upsert(args: unknown) { onUpsert?.(args); return {}; }
    }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n }; } } as unknown as WikiProfileService;
  const permissions = { async assertCanReadPage() {} } as unknown as WikiPermissionService;
  return new WikiWatchService(prisma, profiles, permissions);
}

test('watch status marks a changed current revision as unread', async () => {
  const watches = createService({ lastSeenRevisionId: 29n });
  assert.deepEqual(await watches.status(session, page.id.toString()), { watched: true, unread: true });
});

test('watching a page records the current revision as seen', async () => {
  let upsert: { create: { lastSeenRevisionId: bigint | null }; update: { lastSeenRevisionId: bigint | null } } | undefined;
  const watches = createService(null, (args) => {
    upsert = args as typeof upsert;
  });
  assert.deepEqual(await watches.watch(session, page.id.toString()), { watched: true, unread: false });
  assert.equal(upsert?.create.lastSeenRevisionId, page.currentRevisionId);
  assert.equal(upsert?.update.lastSeenRevisionId, page.currentRevisionId);
});

test('watchlist uses bounded cursor overfetch and one batched ACL decision', async () => {
  const updatedAt = new Date('2026-07-16T00:00:00Z');
  const watches = Array.from({ length: 6 }, (_, index) => ({
    id: BigInt(60 - index), profileId: 20n, pageId: BigInt(10 + index),
    lastSeenRevisionId: 29n, createdAt: updatedAt, updatedAt
  }));
  const pages = watches.map((watch, index) => ({
    ...page, id: watch.pageId, title: `Page ${index}`, displayTitle: `Page ${index}`,
    localPath: `page-${index}`, updatedAt
  }));
  let watchQuery: { take: number; where: unknown } | undefined;
  let aclCalls = 0;
  const prisma = {
    wikiPageWatch: { async findMany(args: { take: number; where: unknown }) { watchQuery = args; return watches; } },
    wikiPage: { async findMany() { return pages; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
    serverWiki: { async findMany() { return []; } }
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async filterReadablePages({ pages: candidates }: { pages: typeof pages }) {
      aclCalls += 1;
      return candidates.filter((candidate) => candidate.id !== 10n);
    }
  } as unknown as WikiPermissionService;
  const service = new WikiWatchService(prisma, profiles, permissions);

  const result = await service.list(session, undefined, 1);

  assert.equal(watchQuery?.take, 6);
  assert.equal(aclCalls, 1);
  assert.deepEqual(result.items.map((item) => item.pageId), ['11']);
  assert.ok(result.nextCursor);
  await assert.rejects(service.list(session, 'tampered', 1), /cursor not found/u);
});

test('watchlist hides server pages whose linked server wiki is not active', async () => {
  const serverPage = { ...page, namespaceId: 2, spaceId: 9n, localPath: 'luna/guide' };
  let serverWikiQuery: unknown;
  const prisma = {
    wikiPageWatch: {
      async findMany() {
        return [{ id: 1n, profileId: 20n, pageId: serverPage.id, lastSeenRevisionId: 29n, createdAt: serverPage.createdAt, updatedAt: serverPage.updatedAt }];
      },
    },
    wikiPage: { async findMany() { return [serverPage]; } },
    wikiNamespace: { async findMany() { return [{ id: 2, code: 'server' }]; } },
    serverWiki: {
      async findMany(query: unknown) {
        serverWikiQuery = query;
        return [];
      },
    },
  } as unknown as PrismaService;
  const profiles = { async ensureWikiProfile() { return { id: 20n, status: 'active' }; } } as unknown as WikiProfileService;
  const permissions = {
    actorFromSession() { return { accountId: session.userId, profileId: 20n, status: 'active' }; },
    async filterReadablePages({ pages }: { pages: Array<typeof serverPage> }) { return pages; },
  } as unknown as WikiPermissionService;

  const result = await new WikiWatchService(prisma, profiles, permissions).list(session);

  assert.deepEqual(result.items, []);
  assert.deepEqual(serverWikiQuery, {
    where: { spaceId: { in: [9n] }, status: 'active' },
    select: { spaceId: true, slug: true },
  });
});
