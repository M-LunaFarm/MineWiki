import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { buildWikiSearchVector, hashContent } from '@minewiki/wiki-core';
import { ServerWikiPublicationService } from './server-wiki-publication.service';
import { buildServerWikiMainPage, buildServerWikiStarterPages } from './server-wiki-scaffold';

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
  readonly missingRequiredDocument?: boolean;
  readonly placeholderRules?: boolean;
  readonly shortIntroduction?: boolean;
  readonly missingOfficialChannel?: boolean;
  readonly staleSearchIndex?: boolean;
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
    publishedReleaseId: null as bigint | null,
    publishedRelease: null as {
      id: bigint;
      version: number;
      publishedAt: Date;
      presentationSnapshot: Prisma.JsonValue;
      _count: { items: number };
    } | null,
    layoutKey: 'docs',
    navigationOrder: null,
    contributionPolicySource: null,
    editHelpSource: null,
    topNoticeSource: null,
    bottomNoticeSource: null,
    requireContributionPolicyAck: false,
    contributionPolicyVersion: 0,
    contentSettingsVersion: 0,
    navigationVersion: 0,
  };
  const server = {
    id: serverId,
    ownerAccountId,
    wikiSpaceId: 77n,
    wikiPageId: 100n,
    wikiSlug: options.invalidLink ? 'other-server' : 'test-server',
    name: 'Test Server',
    joinHost: 'play.test-server.example',
    joinPort: 25565,
    edition: 'java',
    supportedVersions: ['1.21'],
    tags: ['survival'],
    shortDescription: 'Test server summary',
    longDescription: options.shortIntroduction
      ? 'Short introduction.'
      : 'This owner-provided server introduction is intentionally longer than eighty characters so publication readiness can verify factual body content.',
    websiteUrl: options.missingOfficialChannel ? null : 'https://test-server.example',
    discordUrl: null,
  };
  const starters = buildServerWikiStarterPages(server);
  const sourceDocuments = [
    { path: wiki.slug, contentRaw: buildServerWikiMainPage(server) },
    ...starters.map((page) => ({
      path: `${wiki.slug}/${page.path}`,
      contentRaw: page.path === '규칙' && !options.placeholderRules
        ? '= 공식 서버 규칙 =\n\n서버 운영자가 확인한 실제 플레이 및 커뮤니티 정책입니다.'
        : page.contentRaw,
    })),
  ].filter((page) => !(options.missingRequiredDocument && page.path.endsWith('/FAQ')));
  const documentRows = sourceDocuments.map((document, index) => ({
    id: BigInt(100 + index),
    namespaceId: 7,
    spaceId: 77n,
    localPath: document.path,
    slug: document.path,
    title: document.path,
    displayTitle: document.path,
    status: 'normal',
    pageType: 'article',
    protectionLevel: 'open',
    createdBy: 1n,
    ownerProfileId: null,
    currentRevisionId: BigInt(200 + index),
    updatedAt: now,
    searchDocument: {
      revisionId: options.staleSearchIndex && index === 1 ? BigInt(999) : BigInt(200 + index),
    },
  }));
  const revisionRows = sourceDocuments.map((document, index) => ({
    id: BigInt(200 + index),
    pageId: BigInt(100 + index),
    visibility: index === 0 ? options.rootVisibility ?? 'public' : 'public',
    contentRaw: document.contentRaw,
    contentHash: hashContent(document.contentRaw),
  }));
  const audits: Array<Record<string, unknown>> = [];
  const releaseItems: Array<Record<string, unknown>> = [];
  const releaseLinks: Array<Record<string, unknown>> = [];
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
        return server;
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
          publishedReleaseId?: bigint;
        };
      }) {
        if (args.where.publicationVersion !== wiki.publicationVersion) return { count: 0 };
        wiki.publicationStatus = args.data.publicationStatus;
        wiki.publicationVersion += args.data.publicationVersion.increment;
        if (args.data.publishedAt) wiki.publishedAt = args.data.publishedAt;
        if (args.data.unpublishedAt) wiki.unpublishedAt = args.data.unpublishedAt;
        wiki.publicationUpdatedAt = args.data.publicationUpdatedAt;
        wiki.publicationUpdatedBy = args.data.publicationUpdatedBy;
        if (args.data.publishedReleaseId) wiki.publishedReleaseId = args.data.publishedReleaseId;
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
        return options.missingRoot ? [] : documentRows;
      },
    },
    wikiPageLink: {
      async findMany() {
        return documentRows.slice(1).map((page, index) => ({
          sourcePageId: page.id,
          sourceRevisionId: page.currentRevisionId,
          targetNamespaceCode: 'server',
          targetSlug: documentRows[index]!.slug,
          linkType: 'link',
        }));
      },
    },
    serverWikiRelease: {
      async create(args: { data: { version: number; publishedAt: Date; presentationSnapshot: Prisma.JsonValue } }) {
        const release = {
          id: BigInt(900 + args.data.version),
          version: args.data.version,
          publishedAt: args.data.publishedAt,
          presentationSnapshot: args.data.presentationSnapshot,
        };
        wiki.publishedRelease = { ...release, _count: { items: documentRows.length } };
        return release;
      },
    },
    serverWikiReleaseItem: {
      async findMany() { return releaseItems; },
      async createMany(args: { data: Array<Record<string, unknown>> }) {
        releaseItems.push(...args.data);
        return { count: args.data.length };
      },
    },
    serverWikiReleaseLink: {
      async findMany() { return releaseLinks; },
      async createMany(args: { data: Array<Record<string, unknown>> }) {
        releaseLinks.push(...args.data);
        return { count: args.data.length };
      },
    },
    wikiPageRevision: {
      async findUnique() {
        return options.missingRoot
          ? null
          : revisionRows[0];
      },
      async findMany() {
        if (options.missingRoot) return [];
        return revisionRows.filter((revision) => revision.visibility === 'public');
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
  const service = new ServerWikiPublicationService(prisma as never);
  return {
    service,
    async candidateToken() { return (await service.get(serverId, actor)).candidate.token; },
    actor,
    wiki,
    audits,
    releaseItems,
    releaseLinks,
    isolationLevels,
    lockQueries,
    now,
    documentRows,
    revisionRows,
  };
}

test('release candidate manifest is deterministic and classifies the initial publish as added', async () => {
  const fixture = createFixture();
  const first = await fixture.service.get(serverId, fixture.actor);
  const second = await fixture.service.get(serverId, fixture.actor);

  assert.match(first.candidate.token, /^[0-9a-f]{64}$/u);
  assert.equal(first.candidate.token, second.candidate.token);
  assert.equal(first.candidate.baselineReleaseId, null);
  assert.deepEqual(first.candidate.counts, { added: 4, updated: 0, moved: 0, removed: 0, unchanged: 0 });
  assert.equal(first.candidate.hasChanges, true);
  assert.ok(first.candidate.pages.every((item) => item.kind === 'added' && item.before === null));
  assert.equal(first.candidate.pages[0]?.after?.routePath, '/serverWiki/test-server');
  assert.equal(first.candidate.pages[1]?.after?.routePath, '/serverWiki/test-server/%EC%8B%9C%EC%9E%91%ED%95%98%EA%B8%B0');
});

test('publish rejects a candidate token after the reviewed page revision changes', async () => {
  const fixture = createFixture();
  const reviewedToken = await fixture.candidateToken();
  const root = fixture.documentRows[0]!;
  root.currentRevisionId = 999n;
  root.searchDocument.revisionId = 999n;
  fixture.revisionRows.push({
    ...fixture.revisionRows[0]!,
    id: 999n,
    contentRaw: '= changed after review =',
    contentHash: hashContent('= changed after review ='),
  });

  await assert.rejects(
    () => fixture.service.update(serverId, {
      status: 'published',
      expectedVersion: 0,
      expectedCandidateToken: reviewedToken,
      reason: 'publish stale reviewed candidate',
    }, fixture.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('SERVER_WIKI_RELEASE_CANDIDATE_CHANGED'),
  );
  assert.equal(fixture.releaseItems.length, 0);
  assert.equal(fixture.audits.length, 0);
  assert.equal(fixture.wiki.publishedReleaseId, null);
});

test('owner publishes a ready draft atomically with version, timestamps, and an audit reason', async () => {
  const fixture = createFixture();
  const result = await fixture.service.update(serverId, {
    status: 'published',
    expectedVersion: 0,
    expectedCandidateToken: await fixture.candidateToken(),
    reason: 'owner approved launch',
  }, fixture.actor);

  assert.equal(result.status, 'published');
  assert.equal(result.version, 1);
  assert.equal(result.readiness.ready, true);
  assert.equal(result.access.authority, 'owner');
  assert.ok(result.publishedAt);
  assert.equal(fixture.wiki.publicationStatus, 'published');
  assert.equal(result.release?.pageCount, fixture.releaseItems.length);
  assert.ok(result.release?.id);
  assert.equal(fixture.releaseItems.length, 4);
  assert.ok(fixture.releaseItems.every((item) => item.releaseId === BigInt(result.release!.id)));
  assert.ok(fixture.releaseItems.every((item) => typeof item.searchVector === 'string' && item.searchVector.length > 0));
  assert.ok(buildWikiSearchVector(['owner-provided']).split(' ')
    .every((term) => String(fixture.releaseItems[0]?.searchVector).split(' ').includes(term)));
  assert.equal(fixture.releaseLinks.length, 3);
  assert.ok(fixture.releaseLinks.every((link) => link.releaseId === BigInt(result.release!.id)));
  assert.deepEqual(fixture.isolationLevels, [Prisma.TransactionIsolationLevel.Serializable]);
  assert.ok(fixture.lockQueries.some((query) => query.includes('server_wikis')));
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.action, 'server.wiki.publication.publish');
  assert.equal(fixture.audits[0]?.actorAccountId, ownerAccountId);
  assert.match(JSON.stringify(fixture.audits[0]?.metadata), /owner approved launch/u);
});

test('an unchanged published snapshot cannot create a meaningless second release', async () => {
  const fixture = createFixture();
  const published = await fixture.service.update(serverId, {
    status: 'published',
    expectedVersion: 0,
    expectedCandidateToken: await fixture.candidateToken(),
    reason: 'publish reviewed initial candidate',
  }, fixture.actor);
  assert.equal(published.candidate.hasChanges, false);
  assert.deepEqual(published.candidate.counts, { added: 0, updated: 0, moved: 0, removed: 0, unchanged: 4 });

  await assert.rejects(
    () => fixture.service.update(serverId, {
      status: 'published',
      expectedVersion: 1,
      expectedCandidateToken: published.candidate.token,
      reason: 'attempt duplicate no-op release',
    }, fixture.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('SERVER_WIKI_RELEASE_CANDIDATE_EMPTY'),
  );
  assert.equal(fixture.audits.length, 1);
});

test('manager and server.admin can transition publication while editor cannot', async () => {
  const manager = createFixture({ actorAccountId: managerAccountId, actorRole: 'manager' });
  assert.equal((await manager.service.update(serverId, {
    status: 'published', expectedVersion: 0, expectedCandidateToken: await manager.candidateToken(), reason: 'manager approved launch',
  }, manager.actor)).access.authority, 'manager');

  const admin = createFixture({ actorAccountId: editorAccountId, actorRole: 'editor', actorPermissions: ['server.admin'] });
  assert.equal((await admin.service.update(serverId, {
    status: 'published', expectedVersion: 0, expectedCandidateToken: await admin.candidateToken(), reason: 'global admin approved launch',
  }, admin.actor)).access.authority, 'server_admin');

  const editor = createFixture({ actorAccountId: editorAccountId, actorRole: 'editor' });
  await assert.rejects(
    () => editor.service.update(serverId, {
      status: 'published', expectedVersion: 0, expectedCandidateToken: '0'.repeat(64), reason: 'editor attempted launch',
    }, editor.actor),
    ForbiddenException,
  );
  assert.equal(editor.audits.length, 0);
});

test('publish fails closed when readiness is incomplete but unpublish preserves content readiness', async () => {
  const missingRoot = createFixture({ missingRoot: true });
  await assert.rejects(
    () => missingRoot.service.update(serverId, {
      status: 'published', expectedVersion: 0, expectedCandidateToken: '0'.repeat(64), reason: 'launch without root page',
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

test('publish blocks thin starter content, missing channels, and stale search indexes', async () => {
  const fixture = createFixture({
    placeholderRules: true,
    shortIntroduction: true,
    missingOfficialChannel: true,
    staleSearchIndex: true,
  });

  await assert.rejects(
    () => fixture.service.update(serverId, {
      status: 'published', expectedVersion: 0, expectedCandidateToken: '0'.repeat(64), reason: 'attempted thin content launch',
    }, fixture.actor),
    (error: unknown) => {
      if (!(error instanceof ConflictException)) return false;
      const response = JSON.stringify(error.getResponse());
      return response.includes('incomplete_introduction')
        && response.includes('placeholder_rules')
        && response.includes('missing_official_channel')
        && response.includes('search_index_not_ready');
    },
  );
  assert.equal(fixture.audits.length, 0);

  const missingDocument = createFixture({ missingRequiredDocument: true });
  await assert.rejects(
    () => missingDocument.service.update(serverId, {
      status: 'published', expectedVersion: 0, expectedCandidateToken: '0'.repeat(64), reason: 'attempted incomplete document launch',
    }, missingDocument.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('missing_required_documents'),
  );
  assert.equal(missingDocument.audits.length, 0);
});

test('stale versions, repeated unpublish, and inconsistent links fail without audit', async () => {
  const stale = createFixture({ publicationVersion: 4 });
  await assert.rejects(
    () => stale.service.update(serverId, {
      status: 'published', expectedVersion: 3, expectedCandidateToken: '0'.repeat(64), reason: 'stale launch request',
    }, stale.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('currentVersion'),
  );

  const republish = createFixture({ publicationStatus: 'published' });
  const republished = await republish.service.update(serverId, {
    status: 'published', expectedVersion: 0, expectedCandidateToken: await republish.candidateToken(), reason: 'publish reviewed changes',
  }, republish.actor);
  assert.equal(republished.status, 'published');
  assert.equal(republished.release?.version, 1);

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
    stale.audits.length + draftUnpublish.audits.length + inconsistent.audits.length,
    0,
  );
  assert.equal(republish.audits.length, 1);
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
    'missing_required_documents',
  ]);
  assert.equal(fixture.audits.length, 0);
  assert.deepEqual(fixture.isolationLevels, []);
});
