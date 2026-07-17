import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ConfigService } from '@minewiki/config';
import type { Prisma } from '@prisma/client';
import type { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import { WikiWatchService } from './wiki-watch.service';

const session = { userId: 'account-1' } as SessionPayload;
const cursorSecret = 'wiki-watchlist-test-secret';
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

interface CandidateRow {
  readonly watchId: bigint;
  readonly profileId: bigint;
  readonly pageId: bigint;
  readonly lastSeenRevisionId: bigint | null;
  readonly namespaceId: number;
  readonly spaceId: bigint;
  readonly localPath: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly currentRevisionId: bigint | null;
  readonly protectionLevel: string;
  readonly status: string;
  readonly createdBy: bigint | null;
  pageUpdatedAt: Date;
  watchCreatedAt: Date;
  watchUpdatedAt: Date;
  revisionHistory: Date[];
}

function candidate(
  watchId: bigint,
  pageId: bigint,
  pageUpdatedAt: Date,
  overrides: Partial<CandidateRow> = {}
): CandidateRow {
  return {
    watchId,
    profileId: 20n,
    pageId,
    lastSeenRevisionId: 29n,
    namespaceId: 1,
    spaceId: 2n,
    localPath: `page-${pageId.toString()}`,
    title: `Page ${pageId.toString()}`,
    displayTitle: `Page ${pageId.toString()}`,
    currentRevisionId: 30n,
    protectionLevel: 'open',
    status: 'normal',
    createdBy: 20n,
    pageUpdatedAt,
    watchCreatedAt: new Date('2026-01-01T00:00:00Z'),
    watchUpdatedAt: new Date('2026-01-01T00:00:00Z'),
    revisionHistory: [pageUpdatedAt],
    ...overrides
  };
}

function testConfig(): ConfigService {
  return {
    get(key: string) {
      assert.equal(key, 'APP_ENCRYPTION_KEY');
      return cursorSecret;
    }
  } as unknown as ConfigService;
}

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
  return new WikiWatchService(prisma, profiles, permissions, testConfig());
}

function createListService(
  sourceRows: CandidateRow[],
  options: {
    readonly readable?: (pageId: bigint) => boolean;
    readonly activeServerSpaces?: ReadonlyMap<bigint, string>;
  } = {}
) {
  const sql: string[] = [];
  let rawCalls = 0;
  let aclCalls = 0;
  let markReadData: { lastSeenRevisionId: bigint | null; updatedAt: Date } | undefined;
  const prisma = {
    async $queryRaw(query: Prisma.Sql) {
      rawCalls += 1;
      sql.push(query.strings.join('?'));
      const values = query.values as unknown[];
      const snapshotAt = values[0] as Date;
      const profileId = values[1] as bigint;
      const take = Number(values.at(-1));
      const position = values.length > 4
        ? { pageUpdatedAt: values[3] as Date, watchId: values[5] as bigint }
        : null;
      return sourceRows
        .filter((row) => row.profileId === profileId && row.watchCreatedAt <= snapshotAt)
        .flatMap((row) => {
          const snapshotRevisionAt = row.revisionHistory
            .filter((createdAt) => createdAt <= snapshotAt)
            .sort((left, right) => right.getTime() - left.getTime())[0];
          return snapshotRevisionAt ? [{ ...row, pageUpdatedAt: snapshotRevisionAt }] : [];
        })
        .filter((row) => !position || row.pageUpdatedAt < position.pageUpdatedAt || (
          row.pageUpdatedAt.getTime() === position.pageUpdatedAt.getTime() && row.watchId < position.watchId
        ))
        .sort((left, right) => right.pageUpdatedAt.getTime() - left.pageUpdatedAt.getTime()
          || Number(right.watchId - left.watchId))
        .slice(0, take);
    },
    wikiPage: {
      async findUnique({ where }: { where: { id: bigint } }) {
        const row = sourceRows.find((candidateRow) => candidateRow.pageId === where.id);
        return row ? {
          ...page,
          id: row.pageId,
          namespaceId: row.namespaceId,
          spaceId: row.spaceId,
          localPath: row.localPath,
          title: row.title,
          displayTitle: row.displayTitle,
          currentRevisionId: row.currentRevisionId,
          protectionLevel: row.protectionLevel,
          status: row.status,
          createdBy: row.createdBy,
          updatedAt: row.pageUpdatedAt
        } : null;
      }
    },
    wikiPageWatch: {
      async updateMany(args: { where: { profileId: bigint; pageId: bigint }; data: typeof markReadData }) {
        markReadData = args.data;
        const row = sourceRows.find((candidateRow) =>
          candidateRow.profileId === args.where.profileId && candidateRow.pageId === args.where.pageId
        );
        if (!row || !args.data) return { count: 0 };
        row.watchUpdatedAt = args.data.updatedAt;
        return { count: 1 };
      }
    },
    wikiNamespace: {
      async findMany({ where }: { where: { id: { in: number[] } } }) {
        return where.id.in.map((id) => ({ id, code: id === 2 ? 'server' : 'main' }));
      }
    },
    serverWiki: {
      async findMany({ where }: { where: { spaceId: { in: bigint[] }; status: string } }) {
        assert.equal(where.status, 'active');
        return where.spaceId.in.flatMap((spaceId) => {
          const slug = options.activeServerSpaces?.get(spaceId);
          return slug ? [{ spaceId, slug }] : [];
        });
      }
    }
  } as unknown as PrismaService;
  const profiles = {
    async ensureWikiProfile(accountId: string) {
      return { id: accountId === 'account-1' ? 20n : 21n, status: 'active' };
    }
  } as unknown as WikiProfileService;
  const permissions = {
    async assertCanReadPage() {},
    actorFromSession(currentSession: SessionPayload, profile: { id: bigint; status: string }) {
      return { accountId: currentSession.userId, profileId: profile.id, status: profile.status };
    },
    async filterReadablePages({ pages }: { pages: Array<{ id: bigint }> }) {
      aclCalls += 1;
      return pages.filter((candidatePage) => options.readable?.(candidatePage.id) ?? true);
    }
  } as unknown as WikiPermissionService;
  return {
    service: new WikiWatchService(prisma, profiles, permissions, testConfig()),
    stats: {
      get rawCalls() { return rawCalls; },
      get aclCalls() { return aclCalls; },
      get markReadData() { return markReadData; },
      sql
    }
  };
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

test('watchlist orders newest document changes first', async () => {
  const older = new Date('2026-07-14T00:00:00Z');
  const newer = new Date('2026-07-16T00:00:00Z');
  const { service, stats } = createListService([
    candidate(91n, 11n, older),
    candidate(92n, 12n, newer)
  ]);

  const result = await service.list(session);

  assert.deepEqual(result.items.map((item) => item.pageId), ['12', '11']);
  assert.match(stats.sql[0] ?? '', /ORDER BY snapshot_revision\.created_at DESC, w\.id DESC/u);
  assert.match(stats.sql[0] ?? '', /INNER JOIN pages p ON p\.id = w\.page_id/u);
  assert.match(stats.sql[0] ?? '', /candidate_revision\.created_at <=/u);
  assert.match(stats.sql[0] ?? '', /w\.created_at <=/u);
});

test('watchlist breaks equal page update times by descending watch id', async () => {
  const sameTime = new Date('2026-07-16T00:00:00Z');
  const { service } = createListService([
    candidate(40n, 11n, sameTime),
    candidate(42n, 12n, sameTime),
    candidate(41n, 13n, sameTime)
  ]);

  const result = await service.list(session);

  assert.deepEqual(result.items.map((item) => item.pageId), ['12', '13', '11']);
});

test('marking a page read does not reorder the watchlist', async () => {
  const rows = [
    candidate(51n, 11n, new Date('2026-07-16T00:00:00Z')),
    candidate(52n, 12n, new Date('2026-07-15T00:00:00Z'))
  ];
  const { service, stats } = createListService(rows);
  const before = await service.list(session);

  assert.deepEqual(await service.markRead(session, '12'), { watched: true, unread: false });
  const after = await service.list(session);

  assert.deepEqual(before.items.map((item) => item.pageId), ['11', '12']);
  assert.deepEqual(after.items.map((item) => item.pageId), ['11', '12']);
  assert.equal(stats.markReadData?.lastSeenRevisionId, 30n);
  assert.ok(rows[1].watchUpdatedAt > rows[0].watchUpdatedAt);
});

test('watchlist cursor rejects payload tampering and use by another profile', async () => {
  const { service } = createListService([
    candidate(61n, 11n, new Date('2026-07-16T00:00:00Z')),
    candidate(60n, 12n, new Date('2026-07-15T00:00:00Z'))
  ]);
  const first = await service.list(session, undefined, 1);
  assert.ok(first.nextCursor);
  const [payload, signature] = first.nextCursor.split('.') as [string, string];
  const decoded = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as { watchId: string };
  decoded.watchId = '1';
  const tampered = `${Buffer.from(JSON.stringify(decoded)).toString('base64url')}.${signature}`;

  await assert.rejects(service.list(session, tampered, 1), /cursor not found/u);
  await assert.rejects(
    service.list({ ...session, userId: 'account-2' }, first.nextCursor, 1),
    /cursor not found/u
  );
});

test('watchlist cursor fences new watches and keeps the snapshot revision order after later edits', async () => {
  const firstRow = candidate(72n, 11n, new Date('2026-07-16T00:00:00Z'));
  const secondRow = candidate(71n, 12n, new Date('2026-07-15T00:00:00Z'));
  const rows = [firstRow, secondRow];
  const { service } = createListService(rows);
  const first = await service.list(session, undefined, 1);
  assert.deepEqual(first.items.map((item) => item.pageId), ['11']);
  assert.ok(first.nextCursor);

  const later = new Date('2999-01-01T00:00:00Z');
  secondRow.pageUpdatedAt = later;
  secondRow.revisionHistory.push(later);
  rows.push(candidate(73n, 13n, new Date('2026-07-14T00:00:00Z'), { watchCreatedAt: later }));

  const second = await service.list(session, first.nextCursor, 10);
  assert.deepEqual(second.items.map((item) => item.pageId), ['12']);
  assert.equal(second.items[0]?.updatedAt, '2026-07-15T00:00:00.000Z');
  assert.equal(second.nextCursor, null);
});

test('bounded ACL scans advance by the last scanned row without skips or duplicates', async () => {
  const base = Date.parse('2026-07-16T00:00:00Z');
  const deniedRows = Array.from({ length: 501 }, (_, index) => candidate(
    BigInt(1_000 - index),
    BigInt(10_000 + index),
    new Date(base - index * 1_000)
  ));
  const visibleRow = candidate(499n, 20_000n, new Date(base - 501_000));
  const { service, stats } = createListService([...deniedRows, visibleRow], {
    readable: (pageId) => pageId === visibleRow.pageId
  });

  const first = await service.list(session, undefined, 2);
  assert.deepEqual(first.items, []);
  assert.ok(first.nextCursor);
  assert.equal(stats.rawCalls, 5);
  assert.equal(stats.aclCalls, 5);

  const second = await service.list(session, first.nextCursor, 2);
  assert.deepEqual(second.items.map((item) => item.pageId), [visibleRow.pageId.toString()]);
  assert.equal(second.nextCursor, null);
});

test('watchlist hides server pages whose linked server wiki is not active', async () => {
  const serverPage = candidate(1n, 10n, new Date('2026-07-16T00:00:00Z'), {
    namespaceId: 2,
    spaceId: 9n,
    localPath: 'luna/guide'
  });
  const { service } = createListService([serverPage]);

  const result = await service.list(session);

  assert.deepEqual(result.items, []);
});
