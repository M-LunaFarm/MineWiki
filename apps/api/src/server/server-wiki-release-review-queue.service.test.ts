import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { ServerWikiReleaseReviewQueueService } from './server-wiki-release-review-queue.service';

const accountId = '11111111-1111-4111-8111-111111111111';

function candidate(id: bigint, spaceId: bigint) {
  const token = id.toString(16).padStart(64, '0');
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
      counts: { added: 1, updated: 0, moved: 0, removed: 0, unchanged: 0 },
      pages: [],
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
  const rows = [candidate(3n, 77n), candidate(2n, 77n), candidate(1n, 88n)];
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
        return [{ spaceId: 77n }];
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
  return { service: new ServerWikiReleaseReviewQueueService(prisma as never) };
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

test('review detail returns the persisted manifest and hides another tenant candidate as not found', async () => {
  const { service } = fixture();
  const detail = await service.get(accountId, '3');
  assert.equal(detail.serverName, 'Server 3');
  assert.equal(detail.manifest.token, detail.candidateToken);
  assert.equal(detail.review.canApprove, true);
  await assert.rejects(() => service.get(accountId, '1'), NotFoundException);
});
