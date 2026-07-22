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
const reviewerAccountId = '55555555-5555-4555-8555-555555555555';

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
  readonly thinRequiredDocument?: boolean;
  readonly reviewerConfigured?: boolean;
  readonly ownershipSuspended?: boolean;
  readonly notifications?: {
    notifyServerWikiReleaseSubmitted(tx: unknown, input: unknown): Promise<void>;
    notifyServerWikiReleaseReviewChanged(tx: unknown, input: unknown): Promise<void>;
  };
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
    ownershipChallengeSuspendedAt: options.ownershipSuspended ? now : null,
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
        ? `= 공식 서버 규칙 =

== 플레이 기준 ==
* 허용되지 않은 클라이언트와 자동화 도구를 사용하지 않습니다.
* 다른 플레이어의 건축물과 아이템을 동의 없이 훼손하거나 가져가지 않습니다.

== 커뮤니티 기준 ==
* 채팅에서는 욕설, 혐오 표현, 도배와 개인정보 공개를 금지합니다.
* 제재에 이의가 있으면 공식 홈페이지 문의 양식으로 증거와 함께 접수합니다.

규칙 변경은 공식 공지 채널에 시행 시각과 함께 안내합니다.`
        : page.contentRaw,
    })),
  ].filter((page) => !(options.missingRequiredDocument && page.path.endsWith('/FAQ')));
  if (options.thinRequiredDocument) {
    const faq = sourceDocuments.find((page) => page.path.endsWith('/FAQ'));
    if (faq) faq.contentRaw = 'x';
  }
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
  const releaseNavigation: Array<Record<string, unknown>> = [];
  const releaseLinks: Array<Record<string, unknown>> = [];
  const approvals: Array<{
    id: bigint;
    serverWikiId: bigint;
    spaceId: bigint;
    candidateToken: string;
    candidateId: bigint | null;
    reviewerProfileId: bigint;
    approvedAt: Date;
    revokedAt: Date | null;
  }> = [];
  const candidates: Array<{
    id: bigint;
    serverWikiId: bigint;
    spaceId: bigint;
    baselineReleaseId: bigint | null;
    sourcePublicationVersion: number;
    status: string;
    token: string;
    siteSlug: string;
    contentSlug: string;
    requiredApprovals: number;
    submissionReason: string;
    manifestSnapshot: Prisma.JsonValue;
    releaseSnapshot: Prisma.JsonValue;
    createdBy: bigint | null;
    submittedAt: Date;
    changeRequest: { note: string; reviewerProfileId: bigint; decidedAt: Date } | null;
  }> = [];
  const changeRequests: Array<{ candidateId: bigint; note: string; reviewerProfileId: bigint; decidedAt: Date }> = [];
  const isolationLevels: string[] = [];
  const lockQueries: string[] = [];
  const profiles = new Map([
    [ownerAccountId, { id: 1n, status: 'active', mergedIntoProfileId: null }],
    [managerAccountId, { id: 2n, status: 'active', mergedIntoProfileId: null }],
    [editorAccountId, { id: 3n, status: 'active', mergedIntoProfileId: null }],
    [reviewerAccountId, { id: 4n, status: 'active', mergedIntoProfileId: null }],
  ]);
  const actorAccountId = options.actorAccountId ?? ownerAccountId;
  let reviewerEnabled = options.reviewerConfigured ?? false;
  let reviewerEverConfigured = reviewerEnabled;
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
        if (![ownerAccountId, managerAccountId, editorAccountId, reviewerAccountId].includes(args.where.id)) return null;
        return { id: args.where.id, canonicalAccountId: null, lifecycleStatus: 'active' };
      },
    },
    wikiProfile: {
      async findUnique(args: { where: { accountId: string } }) {
        return profiles.get(args.where.accountId) ?? null;
      },
      async findMany(args: { where: { id: { in: bigint[] } } }) {
        return [...profiles.values()].filter((profile) => args.where.id.in.includes(profile.id));
      },
      async count(args: { where: { id: { in: bigint[] } } }) {
        return [...profiles.values()].filter((profile) => args.where.id.in.includes(profile.id)).length;
      },
    },
    subwikiRole: {
      async findMany(args: { where: { userId?: bigint; role?: string; status?: string } }) {
        if (args.where.role === 'reviewer') {
          if (args.where.status === 'active') return reviewerEnabled ? [{ id: 40n, userId: 4n, role: 'reviewer', status: 'active' }] : [];
          return reviewerEverConfigured
            ? [{ id: 40n, userId: 4n, role: 'reviewer', status: reviewerEnabled ? 'active' : 'revoked' }]
            : [];
        }
        const profile = profiles.get(actorAccountId);
        if (args.where.userId === 4n && reviewerEnabled) return [{ role: 'reviewer' }];
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
          targetNamespaceCode: index === 0 ? 'category' : 'server',
          targetSlug: index === 0 ? '시작하기' : documentRows[index]!.slug,
          linkType: index === 0 ? 'category' : 'link',
          categoryLabel: index === 0 ? '처음 읽을 문서' : null,
          categoryBlurred: index === 0,
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
    serverWikiReleaseCandidate: {
      async findUnique(args: { where: { serverWikiId_token: { serverWikiId: bigint; token: string } } }) {
        const key = args.where.serverWikiId_token;
        return candidates.find((candidate) => candidate.serverWikiId === key.serverWikiId && candidate.token === key.token) ?? null;
      },
      async findFirst(args: { where: { id?: bigint; serverWikiId: bigint; spaceId: bigint; token?: string; status?: string | { in: string[] } } }) {
        return [...candidates].reverse().find((candidate) => candidate.serverWikiId === args.where.serverWikiId
          && candidate.spaceId === args.where.spaceId
          && (args.where.id === undefined || candidate.id === args.where.id)
          && (args.where.token === undefined || candidate.token === args.where.token)
          && (args.where.status === undefined || (typeof args.where.status === 'string'
            ? candidate.status === args.where.status
            : args.where.status.in.includes(candidate.status)))) ?? null;
      },
      async upsert(args: { create: Omit<(typeof candidates)[number], 'id'>; update: Partial<(typeof candidates)[number]>; where: { serverWikiId_token: { serverWikiId: bigint; token: string } } }) {
        const key = args.where.serverWikiId_token;
        const existing = candidates.find((candidate) => candidate.serverWikiId === key.serverWikiId && candidate.token === key.token);
        if (existing) { Object.assign(existing, args.update); return existing; }
        const created = { id: BigInt(700 + candidates.length), changeRequest: null, ...args.create };
        candidates.push(created);
        return created;
      },
      async updateMany(args: { where: { id?: bigint; serverWikiId?: bigint; spaceId?: bigint; status?: string; token?: string | { not: string } }; data: { status: string } }) {
        let count = 0;
        for (const candidate of candidates) {
          if ((args.where.id === undefined || candidate.id === args.where.id)
            && (args.where.serverWikiId === undefined || candidate.serverWikiId === args.where.serverWikiId)
            && (args.where.spaceId === undefined || candidate.spaceId === args.where.spaceId)
            && (args.where.status === undefined || candidate.status === args.where.status)
            && (args.where.token === undefined || (typeof args.where.token === 'string'
              ? candidate.token === args.where.token
              : candidate.token !== args.where.token.not))) {
            candidate.status = args.data.status; count += 1;
          }
        }
        return { count };
      },
    },
    serverWikiReleaseChangeRequest: {
      async create(args: { data: { candidateId: bigint; note: string; reviewerProfileId: bigint; decidedAt: Date } }) {
        const row = { candidateId: args.data.candidateId, note: args.data.note, reviewerProfileId: args.data.reviewerProfileId, decidedAt: args.data.decidedAt };
        changeRequests.push(row);
        const candidate = candidates.find((item) => item.id === row.candidateId);
        if (candidate) candidate.changeRequest = { note: row.note, reviewerProfileId: row.reviewerProfileId, decidedAt: row.decidedAt };
        return row;
      },
    },
    serverWikiReleaseItem: {
      async findMany() { return releaseItems; },
      async createMany(args: { data: Array<Record<string, unknown>> }) {
        releaseItems.push(...args.data);
        return { count: args.data.length };
      },
    },
    serverWikiReleaseNavigationNode: {
      async createMany(args: { data: Array<Record<string, unknown>> }) {
        releaseNavigation.push(...args.data);
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
    serverWikiReleaseApproval: {
      async findMany(args: { where: { candidateId: bigint; revokedAt: null } }) {
        return approvals.filter((approval) => approval.candidateId === args.where.candidateId && approval.revokedAt === null);
      },
      async upsert(args: {
        where: { candidateId_reviewerProfileId: { candidateId: bigint; reviewerProfileId: bigint } };
        create: Omit<(typeof approvals)[number], 'id'> & { createdAt: Date; updatedAt: Date };
        update: { approvedAt: Date; revokedAt: null };
      }) {
        const key = args.where.candidateId_reviewerProfileId;
        const existing = approvals.find((approval) => approval.candidateId === key.candidateId && approval.reviewerProfileId === key.reviewerProfileId);
        if (existing) { existing.approvedAt = args.update.approvedAt; existing.revokedAt = null; return existing; }
        const created = { id: BigInt(approvals.length + 1), ...args.create };
        approvals.push(created);
        return created;
      },
      async updateMany(args: { where: { candidateId: bigint; reviewerProfileId?: bigint }; data: { revokedAt: Date } }) {
        let count = 0;
        for (const approval of approvals) {
          if (approval.candidateId === args.where.candidateId
            && (args.where.reviewerProfileId === undefined || approval.reviewerProfileId === args.where.reviewerProfileId)
            && approval.revokedAt === null) {
            approval.revokedAt = args.data.revokedAt; count += 1;
          }
        }
        return { count };
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
  const service = new ServerWikiPublicationService(prisma as never, options.notifications as never);
  return {
    service,
    async candidateToken() { return (await service.get(serverId, actor)).candidate.token; },
    async submitCandidate(reason = 'submit immutable release candidate') {
      const candidate = (await service.get(serverId, actor)).candidate;
      const result = await service.submitCandidate(serverId, {
        expectedVersion: wiki.publicationVersion,
        expectedCandidateToken: candidate.token,
        reason,
      }, actor);
      return result.submission!;
    },
    actor,
    wiki,
    audits,
    releaseItems,
    releaseNavigation,
    releaseLinks,
    isolationLevels,
    lockQueries,
    now,
    documentRows,
    revisionRows,
    approvals,
    candidates,
    changeRequests,
    setReviewerEnabled(value: boolean) { reviewerEnabled = value; if (value) reviewerEverConfigured = true; },
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
  assert.equal(first.candidate.totalPageCount, 4);
  assert.equal('pages' in first.candidate, false);
});

test('ownership challenge locks owner and collaborator publication authority but preserves admin recovery', async () => {
  const owner = createFixture({ ownershipSuspended: true });
  await assert.rejects(() => owner.service.get(serverId, owner.actor), /소유권 재검증/u);

  const manager = createFixture({
    ownershipSuspended: true,
    actorAccountId: managerAccountId,
    actorRole: 'manager',
  });
  await assert.rejects(() => manager.service.get(serverId, manager.actor), /소유권 재검증/u);

  const admin = createFixture({ ownershipSuspended: true, actorPermissions: ['server.admin'] });
  await assert.doesNotReject(() => admin.service.get(serverId, admin.actor));
});

test('candidate token binds the public site slug and release metadata-only changes remain publishable', async () => {
  const slugFixture = createFixture();
  const firstToken = await slugFixture.candidateToken();
  slugFixture.wiki.siteSlug = 'renamed-test-server';
  assert.notEqual(await slugFixture.candidateToken(), firstToken);

  const fixture = createFixture();
  const initial = await fixture.submitCandidate();
  await fixture.service.update(serverId, {
    status: 'published', expectedVersion: 0, candidateId: initial.id,
    expectedCandidateToken: initial.token, reason: 'publish metadata baseline',
  }, fixture.actor);
  fixture.documentRows[0]!.protectionLevel = 'manager';
  fixture.documentRows[0]!.updatedAt = new Date('2026-07-18T01:00:00.000Z');
  const candidate = (await fixture.service.get(serverId, fixture.actor)).candidate;
  assert.equal(candidate.hasChanges, true);
  assert.equal(candidate.counts.updated, 1);
  assert.equal(candidate.totalPageCount, 4);
});

test('publish copies the submitted immutable candidate after the working draft changes', async () => {
  const fixture = createFixture();
  const submission = await fixture.submitCandidate();
  const root = fixture.documentRows[0]!;
  const changedAfterReview = '= 검토 뒤 작업본 =\n\n검토가 끝난 뒤 작성 중인 작업본은 충분한 안내 내용을 담고 있지만, 이번 공개에는 제출 당시의 불변 후보만 포함되어야 합니다. 서버 접속 정보, 이용 규칙, 문의 경로와 변경 공지를 별도 검토 없이 앞당겨 공개해서는 안 됩니다.';
  root.currentRevisionId = 999n;
  root.searchDocument.revisionId = 999n;
  fixture.revisionRows.push({
    ...fixture.revisionRows[0]!,
    id: 999n,
    contentRaw: changedAfterReview,
    contentHash: hashContent(changedAfterReview),
  });

  const published = await fixture.service.update(serverId, {
    status: 'published', expectedVersion: 0, candidateId: submission.id,
    expectedCandidateToken: submission.token, reason: 'publish reviewed immutable candidate',
  }, fixture.actor);
  assert.equal(published.status, 'published');
  assert.equal(fixture.releaseItems[0]?.revisionId, 200n);
  assert.notEqual(fixture.releaseItems[0]?.revisionId, root.currentRevisionId);
});

test('owner publishes a ready draft atomically with version, timestamps, and an audit reason', async () => {
  const fixture = createFixture();
  const submission = await fixture.submitCandidate();
  const result = await fixture.service.update(serverId, {
    status: 'published',
    expectedVersion: 0,
    candidateId: submission.id,
    expectedCandidateToken: submission.token,
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
  assert.equal(fixture.releaseNavigation.length, 4);
  assert.deepEqual(fixture.releaseNavigation.map((node) => node.position), [0, 1, 2, 3]);
  assert.ok(fixture.releaseNavigation.every((node) => node.releaseId === BigInt(result.release!.id)));
  assert.ok(fixture.releaseNavigation.every((node) => !('searchVector' in node)));
  assert.ok(buildWikiSearchVector(['owner-provided']).split(' ')
    .every((term) => String(fixture.releaseItems[0]?.searchVector).split(' ').includes(term)));
  assert.equal(fixture.releaseLinks.length, 3);
  assert.ok(fixture.releaseLinks.every((link) => link.releaseId === BigInt(result.release!.id)));
  const releasedCategory = fixture.releaseLinks.find((link) => link.linkType === 'category');
  assert.equal(releasedCategory?.categoryLabel, '처음 읽을 문서');
  assert.equal(releasedCategory?.categoryBlurred, true);
  assert.deepEqual(fixture.isolationLevels, [
    Prisma.TransactionIsolationLevel.Serializable,
    Prisma.TransactionIsolationLevel.Serializable,
  ]);
  assert.ok(fixture.lockQueries.some((query) => query.includes('server_wikis')));
  assert.equal(fixture.audits.length, 2);
  const publishAudit = fixture.audits.find((audit) => audit.action === 'server.wiki.publication.publish');
  assert.equal(publishAudit?.actorAccountId, ownerAccountId);
  assert.match(JSON.stringify(publishAudit?.metadata), /owner approved launch/u);
});

test('publish snapshots redirects for permalinks but omits them from release navigation', async () => {
  const fixture = createFixture();
  fixture.documentRows.push({
    id: 500n,
    namespaceId: 7,
    spaceId: 77n,
    localPath: 'test-server/old-guide',
    slug: 'test-server/old-guide',
    title: 'test-server/old-guide',
    displayTitle: 'Old guide',
    status: 'normal',
    pageType: 'redirect',
    protectionLevel: 'open',
    createdBy: 1n,
    ownerProfileId: null,
    currentRevisionId: 600n,
    updatedAt: fixture.now,
    searchDocument: { revisionId: 600n },
  });
  const redirectSource = '#넘겨주기 [[server:test-server/guide]]';
  fixture.revisionRows.push({
    id: 600n,
    pageId: 500n,
    visibility: 'public',
    contentRaw: redirectSource,
    contentHash: hashContent(redirectSource),
  });

  const candidate = (await fixture.service.get(serverId, fixture.actor)).candidate;
  assert.equal(candidate.totalPageCount, 5);
  const submission = await fixture.submitCandidate('preserve moved document permalink');
  await fixture.service.update(serverId, {
    status: 'published',
    expectedVersion: 0,
    candidateId: submission.id,
    expectedCandidateToken: submission.token,
    reason: 'publish redirect permalink',
  }, fixture.actor);

  assert.equal(fixture.releaseItems.some((item) => item.pageId === 500n && item.pageType === 'redirect'), true);
  assert.equal(fixture.releaseNavigation.some((node) => node.pageId === 500n), false);
});

test('an unchanged published snapshot cannot be submitted as a meaningless second release', async () => {
  const fixture = createFixture();
  const submission = await fixture.submitCandidate();
  const published = await fixture.service.update(serverId, {
    status: 'published',
    expectedVersion: 0,
    candidateId: submission.id,
    expectedCandidateToken: submission.token,
    reason: 'publish reviewed initial candidate',
  }, fixture.actor);
  assert.equal(published.candidate.hasChanges, false);
  assert.deepEqual(published.candidate.counts, { added: 0, updated: 0, moved: 0, removed: 0, unchanged: 4 });

  await assert.rejects(
    () => fixture.service.submitCandidate(serverId, {
      expectedVersion: 1, expectedCandidateToken: published.candidate.token,
      reason: 'attempt duplicate no-op release',
    }, fixture.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('SERVER_WIKI_RELEASE_CANDIDATE_EMPTY'),
  );
  assert.equal(fixture.audits.length, 2);
});

test('manager and server.admin can transition publication while editor cannot', async () => {
  const manager = createFixture({ actorAccountId: managerAccountId, actorRole: 'manager' });
  const managerSubmission = await manager.submitCandidate();
  assert.equal((await manager.service.update(serverId, {
    status: 'published', expectedVersion: 0, candidateId: managerSubmission.id,
    expectedCandidateToken: managerSubmission.token, reason: 'manager approved launch',
  }, manager.actor)).access.authority, 'manager');

  const admin = createFixture({ actorAccountId: editorAccountId, actorRole: 'editor', actorPermissions: ['server.admin'] });
  const adminSubmission = await admin.submitCandidate();
  assert.equal((await admin.service.update(serverId, {
    status: 'published', expectedVersion: 0, candidateId: adminSubmission.id,
    expectedCandidateToken: adminSubmission.token, reason: 'global admin approved launch',
  }, admin.actor)).access.authority, 'server_admin');

  const editor = createFixture({ actorAccountId: editorAccountId, actorRole: 'editor' });
  await assert.rejects(
    () => editor.service.update(serverId, {
      status: 'published', expectedVersion: 0, candidateId: '1', expectedCandidateToken: '0'.repeat(64), reason: 'editor attempted launch',
    }, editor.actor),
    ForbiddenException,
  );
  assert.equal(editor.audits.length, 0);
});

test('an active reviewer approves the exact candidate before a manager can publish it', async () => {
  const fixture = createFixture({
    actorAccountId: managerAccountId,
    actorRole: 'manager',
    reviewerConfigured: true,
  });
  const submission = await fixture.submitCandidate();
  const managerState = await fixture.service.get(serverId, fixture.actor);
  assert.equal(managerState.review.required, true);
  assert.equal(managerState.review.approved, false);
  assert.equal(managerState.access.canPublish, true);

  await assert.rejects(
    () => fixture.service.update(serverId, {
      status: 'published', expectedVersion: 0,
      candidateId: submission.id,
      expectedCandidateToken: managerState.candidate.token,
      reason: 'manager attempted unreviewed release',
    }, fixture.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('SERVER_WIKI_RELEASE_REVIEW_REQUIRED'),
  );

  const reviewerActor = { accountId: reviewerAccountId, permissions: [] };
  const reviewerState = await fixture.service.get(serverId, reviewerActor);
  assert.equal(reviewerState.access.authority, 'reviewer');
  assert.equal(reviewerState.access.canPublish, false);
  assert.equal(reviewerState.review.canApprove, true);
  const approved = await fixture.service.approveCandidate(serverId, {
    candidateId: submission.id,
    candidateToken: submission.token,
  }, reviewerActor);
  assert.equal(approved.approved, true);
  assert.equal(approved.viewerApproved, true);
  assert.equal(approved.approvals[0]?.reviewerProfileId, '4');

  const published = await fixture.service.update(serverId, {
    status: 'published', expectedVersion: 0, candidateId: submission.id,
    expectedCandidateToken: submission.token,
    reason: 'manager published independently reviewed release',
  }, fixture.actor);
  assert.equal(published.status, 'published');
  assert.equal(fixture.audits.filter((audit) => audit.action === 'server.wiki.release.approve').length, 1);
  assert.equal(fixture.audits.filter((audit) => audit.action === 'server.wiki.publication.publish').length, 1);
});

test('editors cannot approve release candidates and reviewer approval can be revoked', async () => {
  const fixture = createFixture({ reviewerConfigured: true });
  const submission = await fixture.submitCandidate();
  await assert.rejects(
    () => fixture.service.approveCandidate(serverId, { candidateId: submission.id, candidateToken: submission.token }, {
      accountId: editorAccountId,
      permissions: [],
    }),
    ForbiddenException,
  );

  const reviewerActor = { accountId: reviewerAccountId, permissions: [] };
  await fixture.service.approveCandidate(serverId, { candidateId: submission.id, candidateToken: submission.token }, reviewerActor);
  const revoked = await fixture.service.revokeCandidateApproval(serverId, { candidateId: submission.id, candidateToken: submission.token }, reviewerActor);
  assert.equal(revoked.approved, false);
  assert.equal(revoked.viewerApproved, false);
  assert.equal(fixture.approvals[0]?.revokedAt instanceof Date, true);
});

test('release submission, approval, and revocation emit transactional review notifications', async () => {
  const submitted: Array<Record<string, unknown>> = [];
  const changed: Array<Record<string, unknown>> = [];
  const fixture = createFixture({
    reviewerConfigured: true,
    notifications: {
      async notifyServerWikiReleaseSubmitted(_tx, input) {
        submitted.push(input as Record<string, unknown>);
      },
      async notifyServerWikiReleaseReviewChanged(_tx, input) {
        changed.push(input as Record<string, unknown>);
      },
    },
  });
  const submission = await fixture.submitCandidate();
  const reviewerActor = { accountId: reviewerAccountId, permissions: [] };

  await fixture.service.approveCandidate(serverId, {
    candidateId: submission.id,
    candidateToken: submission.token,
  }, reviewerActor);
  await fixture.service.revokeCandidateApproval(serverId, {
    candidateId: submission.id,
    candidateToken: submission.token,
  }, reviewerActor);

  assert.equal(submitted.length, 1);
  assert.equal(submitted[0]?.candidateId, BigInt(submission.id));
  assert.equal(submitted[0]?.spaceId, 77n);
  assert.equal(submitted[0]?.actorProfileId, 1n);
  assert.deepEqual(changed.map((event) => event.state), ['approved', 'revoked']);
  assert.ok(changed.every((event) => event.candidateId === BigInt(submission.id)));
  assert.ok(changed.every((event) => event.submitterProfileId === 1n));
  assert.ok(changed.every((event) => event.reviewerProfileId === 4n));
});

test('reviewer requests changes atomically, revokes approval, and blocks same-manifest resubmission', async () => {
  const changed: Array<Record<string, unknown>> = [];
  const fixture = createFixture({
    reviewerConfigured: true,
    notifications: {
      async notifyServerWikiReleaseSubmitted() {},
      async notifyServerWikiReleaseReviewChanged(_tx, input) {
        changed.push(input as Record<string, unknown>);
      },
    },
  });
  const submission = await fixture.submitCandidate();
  const reviewerActor = { accountId: reviewerAccountId, permissions: [] };
  await fixture.service.approveCandidate(serverId, {
    candidateId: submission.id,
    candidateToken: submission.token,
  }, reviewerActor);

  const result = await fixture.service.requestCandidateChanges(serverId, {
    candidateId: submission.id,
    candidateToken: submission.token,
    note: '규칙 문서에 제재 단계와 이의 제기 절차를 구체적으로 작성해 주세요.',
  }, reviewerActor);

  assert.equal(result.status, 'changes_requested');
  assert.equal(fixture.candidates[0]?.status, 'changes_requested');
  assert.equal(fixture.approvals[0]?.revokedAt instanceof Date, true);
  assert.equal(fixture.changeRequests[0]?.candidateId, BigInt(submission.id));
  assert.equal(fixture.changeRequests[0]?.reviewerProfileId, 4n);
  assert.equal(changed.at(-1)?.state, 'changes_requested');
  assert.equal(fixture.audits.at(-1)?.action, 'server.wiki.release.changes_requested');
  await assert.rejects(
    () => fixture.submitCandidate('retry unchanged candidate after requested changes'),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('SERVER_WIKI_RELEASE_CHANGES_REQUESTED'),
  );
});

test('change requests require a bounded review note', async () => {
  const fixture = createFixture({ reviewerConfigured: true });
  const submission = await fixture.submitCandidate();
  await assert.rejects(
    () => fixture.service.requestCandidateChanges(serverId, {
      candidateId: submission.id,
      candidateToken: submission.token,
      note: '  ',
    }, { accountId: reviewerAccountId, permissions: [] }),
    BadRequestException,
  );
  assert.equal(fixture.changeRequests.length, 0);
});

test('removing every reviewer never lowers the approval requirement fixed at submission', async () => {
  const fixture = createFixture({ reviewerConfigured: true });
  const submission = await fixture.submitCandidate();
  fixture.setReviewerEnabled(false);
  const state = await fixture.service.get(serverId, fixture.actor);
  assert.equal(state.review.required, true);
  assert.equal(state.review.approved, false);
  await assert.rejects(
    () => fixture.service.update(serverId, {
      status: 'published', expectedVersion: 0, candidateId: submission.id,
      expectedCandidateToken: submission.token, reason: 'attempt reviewer removal bypass',
    }, fixture.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('SERVER_WIKI_RELEASE_REVIEW_REQUIRED'),
  );
});

test('same-token resubmission cannot lower sticky reviewer policy after role removal', async () => {
  const fixture = createFixture({ reviewerConfigured: true });
  const first = await fixture.submitCandidate('first independently reviewed submission');
  fixture.setReviewerEnabled(false);
  const second = await fixture.submitCandidate('retry after reviewer role removal');
  assert.equal(second.id, first.id);
  assert.equal(second.token, first.token);
  assert.equal(second.requiredApprovals, 1);
  const state = await fixture.service.get(serverId, fixture.actor);
  assert.equal(state.review.required, true);
  assert.equal(state.review.reviewerAvailable, false);
  await assert.rejects(
    () => fixture.service.update(serverId, {
      status: 'published', expectedVersion: 0, candidateId: second.id,
      expectedCandidateToken: second.token, reason: 'attempt same candidate policy downgrade',
    }, fixture.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('SERVER_WIKI_RELEASE_REVIEW_REQUIRED'),
  );
});

test('revoked reviewer history does not require approval for a newly submitted candidate', async () => {
  const fixture = createFixture({ reviewerConfigured: true });
  fixture.setReviewerEnabled(false);
  const submission = await fixture.submitCandidate();
  assert.equal(submission.requiredApprovals, 0);
  const state = await fixture.service.get(serverId, fixture.actor);
  assert.equal(state.review.required, false);
  assert.equal(state.review.reviewerAvailable, false);
  const published = await fixture.service.update(serverId, {
    status: 'published', expectedVersion: 0, candidateId: submission.id,
    expectedCandidateToken: submission.token, reason: 'publish after reviewer access was revoked',
  }, fixture.actor);
  assert.equal(published.status, 'published');
});

test('publish fails closed when readiness is incomplete but unpublish preserves content readiness', async () => {
  const missingRoot = createFixture({ missingRoot: true });
  await assert.rejects(
    () => missingRoot.service.update(serverId, {
      status: 'published', expectedVersion: 0, candidateId: '1', expectedCandidateToken: '0'.repeat(64), reason: 'launch without root page',
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
      status: 'published', expectedVersion: 0, candidateId: '1', expectedCandidateToken: '0'.repeat(64), reason: 'attempted thin content launch',
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
      status: 'published', expectedVersion: 0, candidateId: '1', expectedCandidateToken: '0'.repeat(64), reason: 'attempted incomplete document launch',
    }, missingDocument.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('missing_required_documents'),
  );
  assert.equal(missingDocument.audits.length, 0);

  const thinDocument = createFixture({ thinRequiredDocument: true });
  await assert.rejects(
    () => thinDocument.service.update(serverId, {
      status: 'published', expectedVersion: 0, candidateId: '1', expectedCandidateToken: '0'.repeat(64), reason: 'attempted one-character document launch',
    }, thinDocument.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('thin_required_document'),
  );
  assert.equal(thinDocument.audits.length, 0);
});

test('stale versions, repeated unpublish, and inconsistent links fail without audit', async () => {
  const stale = createFixture({ publicationVersion: 4 });
  await assert.rejects(
    () => stale.service.update(serverId, {
      status: 'published', expectedVersion: 3, candidateId: '1', expectedCandidateToken: '0'.repeat(64), reason: 'stale launch request',
    }, stale.actor),
    (error: unknown) => error instanceof ConflictException
      && JSON.stringify(error.getResponse()).includes('currentVersion'),
  );

  const republish = createFixture({ publicationStatus: 'published' });
  const republishSubmission = await republish.submitCandidate();
  const republished = await republish.service.update(serverId, {
    status: 'published', expectedVersion: 0, candidateId: republishSubmission.id,
    expectedCandidateToken: republishSubmission.token, reason: 'publish reviewed changes',
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
  assert.equal(republish.audits.length, 2);
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
