import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ServerWikiReleaseReviewQueueService } from './server-wiki-release-review-queue.service';
import { ServerWikiReleaseManifestCursorCodec } from './server-wiki-release-manifest-cursor';

const accountId = '11111111-1111-4111-8111-111111111111';

function candidate(id: bigint, spaceId: bigint, pageCount = 0) {
  const token = id.toString(16).padStart(64, '0');
  const kinds = ['added', 'updated', 'moved', 'removed'] as const;
  const pages = Array.from({ length: pageCount }, (_, index) => ({
    pageId: String(index + 1),
    kind: kinds[index % kinds.length]!,
    contentChanged: index % kinds.length === 1,
    identityChanged: index % kinds.length === 2,
    metadataChanged: false,
    before: null,
    after: null,
    updatedAt: '2026-07-18T00:00:00.000Z',
  }));
  return {
    id,
    serverWikiId: spaceId + 100n,
    spaceId,
    token,
    status: 'pending_review',
    submittedAt: new Date(`2026-07-18T00:00:${id.toString().padStart(2, '0')}.000Z`),
    createdBy: 9n,
    submissionReason: `candidate ${id} review`,
    requiredApprovals: 1,
    manifestSnapshot: {
      token,
      baselineReleaseId: null,
      generatedAt: '2026-07-18T00:00:00.000Z',
      counts: { added: Math.ceil(pageCount / 4), updated: Math.ceil(Math.max(0, pageCount - 1) / 4), moved: Math.ceil(Math.max(0, pageCount - 2) / 4), removed: Math.ceil(Math.max(0, pageCount - 3) / 4), unchanged: 0 },
      pages,
      presentation: { navigationChanged: false, contentSettingsChanged: false, layoutChanged: false, linkGraphChanged: false },
      hasChanges: true,
    },
    serverWiki: {
      voteServerId: `22222222-2222-4222-8222-${id.toString().padStart(12, '0')}`,
      serverName: `Server ${id}`,
      siteSlug: `server-${id}`,
    },
  };
}

function fixture() {
  const rows = [candidate(3n, 77n, 150), candidate(2n, 77n, 3), candidate(1n, 88n, 2)];
  let reviewerEnabled = true;
  const prisma = {
    account: {
      async findUnique() { return { id: accountId, canonicalAccountId: accountId }; },
      async findMany() { return [{ id: accountId, canonicalAccountId: accountId }]; },
      async count() { return 1; },
    },
    accountLink: { async findMany() { return []; } },
    wikiProfile: {
      async findMany(args: { where: { id?: { in: bigint[] } } }) {
        return args.where.id ? [{ id: 7n }] : [{ id: 7n }];
      },
    },
    subwikiRole: {
      async findMany(args: { where: { userId?: bigint; spaceId?: bigint } }) {
        if (args.where.spaceId !== undefined) return [{ userId: 7n }];
        return reviewerEnabled ? [{ spaceId: 77n }] : [];
      },
    },
    serverWikiReleaseCandidate: {
      async findMany(args: { where: { id?: { lt: bigint }; spaceId: { in: bigint[] } }; take: number }) {
        return rows.filter((row) => args.where.spaceId.in.includes(row.spaceId)
          && (!args.where.id || row.id < args.where.id.lt)).slice(0, args.take);
      },
      async findFirst(args: { where: { id: bigint; spaceId: { in: bigint[] } } }) {
        return rows.find((row) => row.id === args.where.id && args.where.spaceId.in.includes(row.spaceId)) ?? null;
      },
      async count() { return 2; },
    },
    serverWikiReleaseApproval: { async findMany() { return []; } },
  };
  const cursors = new ServerWikiReleaseManifestCursorCodec({
    get(name: string) { return name === 'APP_ENCRYPTION_KEY' ? 'release-review-queue-test-secret' : undefined; },
  } as never);
  return {
    service: new ServerWikiReleaseReviewQueueService(prisma as never, cursors),
    revokeReviewer() { reviewerEnabled = false; },
  };
}

test('reviewer discovers only pending candidates from assigned spaces without a server UUID', async () => {
  const { service } = fixture();
  const first = await service.list(accountId, undefined, '1');
  assert.equal(first.viewerProfileId, '7');
  assert.deepEqual(first.items.map((item) => item.candidateId), ['3']);
  assert.equal(first.nextCursor, '3');
  const second = await service.list(accountId, first.nextCursor!, '1');
  assert.deepEqual(second.items.map((item) => item.candidateId), ['2']);
  assert.equal(second.nextCursor, null);
  assert.equal((await service.summary(accountId)).count, 2);
});

test('review detail returns only a bounded persisted manifest summary and hides another tenant candidate', async () => {
  const { service } = fixture();
  const detail = await service.get(accountId, '3');
  assert.equal(detail.serverName, 'Server 3');
  assert.equal(detail.manifest.token, detail.candidateToken);
  assert.equal(detail.manifest.totalPageCount, 150);
  assert.equal('pages' in detail.manifest, false);
  assert.equal(detail.review.canApprove, true);
  await assert.rejects(() => service.get(accountId, '1'), NotFoundException);
});

test('release manifest pages traverse 150 persisted entries without duplicates or omissions', async () => {
  const { service } = fixture();
  const received: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await service.pages(accountId, '3', undefined, cursor, '50');
    received.push(...page.items.map((item) => item.pageId));
    cursor = page.nextCursor ?? undefined;
  } while (cursor);
  assert.equal(received.length, 150);
  assert.equal(new Set(received).size, 150);
  assert.deepEqual(received, Array.from({ length: 150 }, (_, index) => String(index + 1)));
});

test('manifest cursor cannot cross candidates or filters and role revocation stops pagination', async () => {
  const { service, revokeReviewer } = fixture();
  const first = await service.pages(accountId, '3', 'added,updated', undefined, '10');
  assert.ok(first.nextCursor);
  await assert.rejects(() => service.pages(accountId, '2', 'added,updated', first.nextCursor!, '10'), BadRequestException);
  await assert.rejects(() => service.pages(accountId, '3', 'moved', first.nextCursor!, '10'), BadRequestException);
  const tampered = `${first.nextCursor!.slice(0, -1)}x`;
  await assert.rejects(() => service.pages(accountId, '3', 'added,updated', tampered, '10'), BadRequestException);
  revokeReviewer();
  await assert.rejects(() => service.pages(accountId, '3', 'added,updated', first.nextCursor!, '10'), NotFoundException);
});
