import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiProfileMergeService } from './wiki-profile-merge.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const profiles = new WikiProfileService(prisma);
  const service = new WikiProfileMergeService(prisma, profiles);

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  test('merges only linked profiles after approval while preserving historical actors', async () => {
    const canonicalAccountId = randomUUID();
    const aliasAccountId = randomUUID();
    const foreignAccountId = randomUUID();
    const suffix = randomUUID().replace(/-/gu, '').slice(0, 12);
    const now = new Date();
    let targetProfileId: bigint | null = null;
    let sourceProfileId: bigint | null = null;
    let foreignProfileId: bigint | null = null;
    let requestId: string | null = null;

    try {
      await prisma.account.createMany({
        data: [
          {
            id: canonicalAccountId,
            canonicalAccountId,
            provider: 'email',
            providerUserId: `merge-target-${suffix}@example.com`,
            email: `merge-target-${suffix}@example.com`,
            emailVerified: true
          },
          {
            id: aliasAccountId,
            canonicalAccountId,
            provider: 'discord',
            providerUserId: `merge-source-${suffix}`,
            emailVerified: true
          },
          {
            id: foreignAccountId,
            canonicalAccountId: foreignAccountId,
            provider: 'naver',
            providerUserId: `merge-foreign-${suffix}`,
            emailVerified: true
          }
        ]
      });
      const target = await prisma.wikiProfile.create({
        data: {
          accountId: canonicalAccountId,
          username: `merge_target_${suffix}`,
          displayName: 'Merge target',
          status: 'active',
          createdAt: now,
          updatedAt: now
        }
      });
      const source = await prisma.wikiProfile.create({
        data: {
          accountId: aliasAccountId,
          username: `merge_source_${suffix}`,
          displayName: 'Merge source',
          status: 'blocked',
          createdAt: new Date(now.getTime() - 1_000),
          updatedAt: now
        }
      });
      const foreign = await prisma.wikiProfile.create({
        data: {
          accountId: foreignAccountId,
          username: `merge_foreign_${suffix}`,
          displayName: 'Merge foreign',
          status: 'active',
          createdAt: now,
          updatedAt: now
        }
      });
      targetProfileId = target.id;
      sourceProfileId = source.id;
      foreignProfileId = foreign.id;

      await prisma.wikiRecentChange.create({
        data: {
          actorId: source.id,
          changeType: 'edit',
          title: `Merge history ${suffix}`,
          namespaceCode: 'main',
          summary: 'historical actor must remain unchanged',
          createdAt: now
        }
      });
      const notification = await prisma.wikiNotification.create({
        data: {
          profileId: source.id,
          type: 'discussion',
          sourceType: 'merge_test',
          sourceId: suffix,
          title: 'Merge test notification',
          href: '/wiki/대문',
          dedupeKey: `merge-test:${suffix}`,
          createdAt: now
        }
      });
      const directAcl = await prisma.aclRule.create({
        data: {
          targetType: 'global',
          action: 'read',
          effect: 'allow',
          subjectType: 'user',
          subjectValue: source.id.toString(),
          sortOrder: 0,
          reason: 'profile merge integration test',
          createdAt: now,
          updatedAt: now
        }
      });

      const preview = await service.preview(canonicalAccountId);
      assert.equal(preview.target.id, target.id.toString());
      assert.equal(preview.candidates.length, 1);
      assert.equal(preview.candidates[0]?.profile.id, source.id.toString());
      assert.equal(preview.candidates[0]?.requiresBlockedStatus, true);
      assert.equal(preview.candidates[0]?.counts.historical.recentChanges, 1);
      assert.equal(preview.candidates[0]?.counts.current.notifications, 1);
      assert.equal(preview.candidates[0]?.counts.current.directAclRules, 1);

      await assert.rejects(
        service.request(canonicalAccountId, {
          sourceProfileId: foreign.id.toString(),
          sourceUsername: foreign.username,
          targetUsername: target.username
        }),
        /현재 계정 그룹에서 병합할 수 없습니다/u
      );

      const requested = await service.request(canonicalAccountId, {
        sourceProfileId: source.id.toString(),
        sourceUsername: source.username,
        targetUsername: target.username,
        reason: 'linked provider profiles'
      });
      requestId = requested.id;
      assert.equal(requested.status, 'pending');
      const repeated = await service.request(canonicalAccountId, {
        sourceProfileId: source.id.toString(),
        sourceUsername: source.username,
        targetUsername: target.username,
        reason: 'duplicate request should be idempotent'
      });
      assert.equal(repeated.id, requested.id);

      await assert.rejects(
        service.approve(
          requested.id,
          { accountId: canonicalAccountId, profileId: target.id },
          { sourceUsername: 'wrong-name', targetUsername: target.username, reason: 'verified merge approval' }
        ),
        /확인 사용자명이 병합 요청과 일치하지 않습니다/u
      );

      const completed = await service.approve(
        requested.id,
        { accountId: canonicalAccountId, profileId: target.id },
        {
          sourceUsername: source.username,
          targetUsername: target.username,
          reason: 'verified merge approval'
        }
      );
      assert.equal(completed.status, 'completed');
      assert.equal(completed.transferred.notifications, 1);
      assert.equal(completed.transferred.directAclRules, 1);

      const [mergedSource, blockedTarget, alias, historicalChange, movedNotification, movedAcl] = await Promise.all([
        prisma.wikiProfile.findUnique({ where: { id: source.id } }),
        prisma.wikiProfile.findUnique({ where: { id: target.id } }),
        prisma.wikiProfileAlias.findUnique({ where: { sourceProfileId: source.id } }),
        prisma.wikiRecentChange.findFirst({ where: { title: `Merge history ${suffix}` } }),
        prisma.wikiNotification.findUnique({ where: { id: notification.id } }),
        prisma.aclRule.findUnique({ where: { id: directAcl.id } })
      ]);
      assert.equal(mergedSource?.status, 'merged');
      assert.equal(mergedSource?.mergedIntoProfileId, target.id);
      assert.equal(blockedTarget?.status, 'blocked');
      assert.equal(alias?.targetProfileId, target.id);
      assert.equal(historicalChange?.actorId, source.id);
      assert.equal(movedNotification?.profileId, target.id);
      assert.equal(movedAcl?.subjectValue, target.id.toString());

      const repeatedApproval = await service.approve(
        requested.id,
        { accountId: canonicalAccountId, profileId: target.id },
        {
          sourceUsername: source.username,
          targetUsername: target.username,
          reason: 'verified merge approval'
        }
      );
      assert.equal(repeatedApproval.status, 'completed');
    } finally {
      if (requestId) {
        await prisma.auditEvent.deleteMany({ where: { subjectType: 'wiki_profile_merge_request', subjectId: requestId } });
        await prisma.wikiProfileAlias.deleteMany({ where: { mergeRequestId: requestId } });
        await prisma.wikiProfileMergeRequest.deleteMany({ where: { id: requestId } });
      }
      if (sourceProfileId || targetProfileId) {
        const ids = [sourceProfileId, targetProfileId].filter((id): id is bigint => id !== null);
        await prisma.wikiNotification.deleteMany({ where: { profileId: { in: ids } } });
        await prisma.wikiRecentChange.deleteMany({ where: { actorId: { in: ids }, title: `Merge history ${suffix}` } });
        await prisma.aclRule.deleteMany({ where: { reason: 'profile merge integration test' } });
        if (sourceProfileId) {
          await prisma.wikiProfile.update({
            where: { id: sourceProfileId },
            data: { mergedIntoProfileId: null, mergedAt: null }
          }).catch(() => undefined);
        }
      }
      const profileIds = [sourceProfileId, targetProfileId, foreignProfileId].filter((id): id is bigint => id !== null);
      if (profileIds.length > 0) {
        await prisma.wikiProfile.deleteMany({ where: { id: { in: profileIds } } });
      }
      await prisma.account.deleteMany({ where: { id: { in: [canonicalAccountId, aliasAccountId, foreignAccountId] } } });
    }
  });
}
