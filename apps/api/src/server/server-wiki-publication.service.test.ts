import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ServerWikiPublicationService } from './server-wiki-publication.service';

const serverId = '11111111-1111-4111-8111-111111111111';
const ownerAccountId = '22222222-2222-4222-8222-222222222222';
const managerAccountId = '33333333-3333-4333-8333-333333333333';
const editorAccountId = '44444444-4444-4444-8444-444444444444';

interface FixtureOptions {
  readonly publicationStatus?: string;
  readonly publicationVersion?: number;
  readonly actorAccountId?: string;
  readonly actorPermissions?: readonly string[];
  readonly actorRole?: string;
  readonly siteSlug?: string | null;
  readonly missingRoot?: boolean;
  readonly rootVisibility?: string;
  readonly invalidLink?: boolean;
}

function createFixture(options: FixtureOptions = {}) {
  const now = new Date('2026-07-18T00:00:00.000Z');
  const wiki = {
    id: 88n,
    voteServerId: serverId,
    spaceId: 77n,
    slug: 'test-server',
    siteSlug: options.siteSlug === undefined ? 'test-server' : options.siteSlug,
    status: 'active',
    publicationStatus: options.publicationStatus ?? 'draft',
    publicationVersion: options.publicationVersion ?? 0,
    publishedAt: null as Date | null,
    unpublishedAt: null as Date | null,
    publicationUpdatedAt: null as Date | null,
    publicationUpdatedBy: null as bigint | null,
  };
  const audits: Array<Record<string, unknown>> = [];
  const isolationLevels: string[] = [];
  const lockQueries: string[] = [];
  const profiles = new Map([
    [ownerAccountId, { id: 1n, status: 'active', mergedIntoProfileId: null }],
    [managerAccountId, { id: 2n, status: 'active', mergedIntoProfileId: null }],
    [editorAccountId, { id: 3n, status: 'active', mergedIntoProfileId: null }],
  ]);
  const actorAccountId = options.actorAccountId ?? ownerAccountId;
  const actor = { accountId: actorAccountId, permissions: options.actorPermissions ?? [] };
  const tx = {
    async $queryRaw(strings: TemplateStringsArray) {
      lockQueries.push(strings.join('?').replace(/\s+/gu, ' ').trim());
      return [];
    },
    server: {
      async findUnique() {
        return {
          id: serverId,
          ownerAccountId,
          wikiSpaceId: 77n,
          wikiPageId: 100n,
          wikiSlug: options.invalidLink ? 'other-server' : 'test-server',
        };
      },
    },
    serverWiki: {
      async findUnique(args: { where: { voteServerId?: string; id?: bigint }; select?: Record<string, boolean> }) {
        if (args.where.id && args.where.id !== wiki.id) return null;
        return { ...wiki };
      },
      async updateMany(args: {
        where: { id: bigint; status: string; publicationVersion: number };
        data: {
          publicationStatus: string;
          publicationVersion: { increment: number };
          publishedAt?: Date;
          unpublishedAt?: Date;
          publicationUpdatedAt: Date;
          publicationUpdatedBy: bigint | null;
        };
      }) {
        if (args.where.publicationVersion !== wiki.publicationVersion) return { count: 0 };
        wiki.publicationStatus = args.data.publicationStatus;
        wiki.publicationVersion += args.data.publicationVersion.increment;
        if (args.data.publishedAt) wiki.publishedAt = args.data.publishedAt;
        if (args.data.unpublishedAt) wiki.unpublishedAt = args.data.unpublishedAt;
        wiki.publicationUpdatedAt = args.data.publicationUpdatedAt;
        wiki.publicationUpdatedBy = args.data.publicationUpdatedBy;
        return { count: 1 };
      },
    },
    wikiSpace: {
      async findUnique() {
        return {
          id: 77n,
          spaceType: 'server_wiki',
          status: 'active',
          rootPageId: 100n,
          slug: 'test-server',
        };
      },
    },
    account: {
      async findUnique(args: { where: { id: string } }) {
        if (![ownerAccountId, managerAccountId, editorAccountId].includes(args.where.id)) return null;
        return { id: args.where.id, canonicalAccountId: null, lifecycleStatus: 'active' };
      },
    },
    wikiProfile: {
      async findUnique(args: { where: { accountId: string } }) {
        return profiles.get(args.where.accountId) ?? null;
      },
    },
    subwikiRole: {
      async findMany(args: { where: { userId: bigint } }) {
        const profile = profiles.get(actorAccountId);
        if (!profile || profile.id !== args.where.userId || !options.actorRole) return [];
        return [{ role: options.actorRole }];
      },
    },
    wikiPage: {
      async findUnique() {
        if (options.missingRoot) return null;
        return { id: 100n, spaceId: 77n, status: 'normal', currentRevisionId: 200n };
      },
      async findMany() {
        return options.missingRoot ? [] : [{ id: 100n, currentRevisionId: 200n }];
      },
    },
    wikiPageRevision: {
      async findUnique() {
        return options.missingRoot
          ? null
          : { pageId: 100n, visibility: options.rootVisibility ?? 'public' };
      },
      async findMany() {
        return options.missingRoot || options.rootVisibility === 'hidden'
          ? []
          : [{ id: 200n, pageId: 100n }];
      },
    },
    auditEvent: {
      async create(args: { data: Record<string, unknown> }) {
        audits.push(args.data);
        return args.data;
      },
    },
  };
  const prisma = {
    ...tx,
    async $transaction<T>(operation: (store: typeof tx) => Promise<T>, config: { isolationLevel: string }) {
      isolationLevels.push(config.isolationLevel);
      return operation(tx);
    },
  };
  return {
    service: new ServerWikiPublicationService(prisma as never),
    actor,
    wiki,
    audits,
    isolationLevels,
    lockQueries,
    now,
  };
}

test('owner publishes a ready draft atomically with version, timestamps, and an audit reason', async () => {
  const fixture = createFixture();
  const result = await fixture.service.update(serverId, {
    status: 'published',
    expectedVersion: 0,
    reason: 'owner approved launch',
  }, fixture.actor);

  assert.equal(result.status, 'published');
  assert.equal(result.version, 1);
  assert.equal(result.readiness.ready, true);
  assert.equal(result.access.authority, 'owner');
  assert.ok(result.publishedAt);
  assert.equal(fixture.wiki.publicationStatus, 'published');
  assert.deepEqual(fixture.isolationLevels, [Prisma.TransactionIsolationLevel.Serializable]);
  assert.ok(fixture.lockQueries.some((query) => query.includes('server_wikis')));
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.action, 'server.wiki.publication.publish');
  assert.equal(fixture.audits[0]?.actorAccountId, ownerAccountId);
  assert.match(JSON.stringify(fixture.audits[0]?.metadata), /owner approved launch/u);
});

test('manager and server.admin can transition publication while editor cannot', async () => {
  const manager = createFixture({ actorAccountId: managerAccountId, actorRole: 'manager' });
  assert.equal((await manager.service.update(serverId, {
    status: 'published', expectedVersion: 0, reason: 'manager approved launch',
  }, manager.actor)).access.authority, 'manager');

  const admin = createFixture({ actorAccountId: editorAccountId, actorRole: 'editor', actorPermissions: ['server.admin'] });
  assert.equal((await admin.service.update(serverId, {
    status: 'published', expectedVersion: 0, reason: 'global admin approved launch',
  }, admin.actor)).access.authority, 'server_admin');

  const editor = createFixture({ actorAccountId: editorAccountId, actorRole: 'editor' });
  await assert.rejects(
    () => editor.service.update(serverId, {
      status: 'published', expectedVersion: 0, reason: 'editor attempted launch',
    }, editor.actor),
    ForbiddenException,
  );
  assert.equal(editor.audits.length, 0);
});

test('publish fails closed when readiness is incomplete but unpublish preserves content readiness', async () => {
  const missingRoot = createFixture({ missingRoot: true });
  await assert.rejects(
    () => missingRoot.service.update(serverId, {
      status: 'published', expectedVersion: 0, reason: 'launch without root page',
    }, missingRoot.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('missing_root_page'),
  );

  const published = createFixture({ publicationStatus: 'published', missingRoot: true });
  const result = await published.service.update(serverId, {
    status: 'unpublished', expectedVersion: 0, reason: 'incident response shutdown',
  }, published.actor);
  assert.equal(result.status, 'unpublished');
  assert.equal(result.readiness.ready, false);
  assert.deepEqual(result.readiness.blockers, ['missing_root_page']);
});

test('stale versions, same-state mutations, and inconsistent links fail without audit', async () => {
  const stale = createFixture({ publicationVersion: 4 });
  await assert.rejects(
    () => stale.service.update(serverId, {
      status: 'published', expectedVersion: 3, reason: 'stale launch request',
    }, stale.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('currentVersion'),
  );

  const same = createFixture({ publicationStatus: 'published' });
  await assert.rejects(
    () => same.service.update(serverId, {
      status: 'published', expectedVersion: 0, reason: 'duplicate launch request',
    }, same.actor),
    BadRequestException,
  );

  const draftUnpublish = createFixture();
  await assert.rejects(
    () => draftUnpublish.service.update(serverId, {
      status: 'unpublished', expectedVersion: 0, reason: 'invalid draft shutdown',
    }, draftUnpublish.actor),
    BadRequestException,
  );

  const inconsistent = createFixture({ invalidLink: true });
  await assert.rejects(
    () => inconsistent.service.get(serverId, inconsistent.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('SERVER_WIKI_PUBLICATION_INVALID_LINK'),
  );
  assert.equal(
    stale.audits.length + same.audits.length + draftUnpublish.audits.length + inconsistent.audits.length,
    0,
  );
});

test('GET reports publication timestamps, readiness blockers, and manager authority without mutation', async () => {
  const fixture = createFixture({
    publicationStatus: 'unpublished',
    publicationVersion: 7,
    actorAccountId: managerAccountId,
    actorRole: 'manager',
    siteSlug: null,
    rootVisibility: 'hidden',
  });
  const result = await fixture.service.get(serverId, fixture.actor);
  assert.equal(result.status, 'unpublished');
  assert.equal(result.version, 7);
  assert.equal(result.access.authority, 'manager');
  assert.deepEqual(result.readiness.blockers, [
    'invalid_site_slug',
    'missing_public_root_revision',
    'missing_public_document',
  ]);
  assert.equal(fixture.audits.length, 0);
  assert.deepEqual(fixture.isolationLevels, []);
});
