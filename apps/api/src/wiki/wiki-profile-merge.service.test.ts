import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiProfileMergeService } from './wiki-profile-merge.service';
import { WikiReadService } from './wiki-read.service';
import type { WikiPermissionService } from './wiki-permission.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const profiles = new WikiProfileService(prisma);
  const service = new WikiProfileMergeService(prisma, profiles);
  const read = new WikiReadService(prisma, {
    assertCanReadPage: async () => undefined
  } as unknown as WikiPermissionService);
  let createdMainNamespaceId: number | null = null;

  before(async () => {
    await prisma.$connect();
    const namespace = await prisma.wikiNamespace.findUnique({ where: { code: 'main' } });
    if (!namespace) {
      const created = await prisma.wikiNamespace.create({ data: { code: 'main', displayName: '일반', pathPrefix: '', isContent: true } });
      createdMainNamespaceId = created.id;
    }
  });

  after(async () => {
    if (createdMainNamespaceId) await prisma.wikiNamespace.delete({ where: { id: createdMainNamespaceId } });
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
    let testSpaceId: bigint | null = null;
    let testPageId: bigint | null = null;
    let aclGroupId: bigint | null = null;
    let wikiGroupId: number | null = null;

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
          usernameChangedAt: new Date(now.getTime() - 60_000),
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
      const preservedUsername = `merge_old_${suffix}`;
      await prisma.wikiUsernameAlias.create({
        data: { oldUsername: preservedUsername, profileId: source.id, createdAt: now }
      });

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
      const mainNamespace = await prisma.wikiNamespace.findUniqueOrThrow({ where: { code: 'main' } });
      const testSpace = await prisma.wikiSpace.create({
        data: {
          code: `merge-test-${suffix}`,
          name: 'Merge integration space',
          rootNamespaceCode: 'main',
          rootPath: `/merge-test-${suffix}`,
          status: 'active',
          createdBy: source.id,
          ownerUserId: source.id,
          createdAt: now,
          updatedAt: now
        }
      });
      testSpaceId = testSpace.id;
      const testPage = await prisma.wikiPage.create({
        data: {
          namespaceId: mainNamespace.id,
          spaceId: testSpace.id,
          localPath: `merge-test-${suffix}`,
          slug: `merge-test-${suffix}`,
          title: `Merge test ${suffix}`,
          displayTitle: `Merge test ${suffix}`,
          status: 'normal',
          createdBy: source.id,
          ownerProfileId: source.id,
          createdAt: now,
          updatedAt: now
        }
      });
      testPageId = testPage.id;
      await prisma.wikiPageWatch.createMany({
        data: [
          { profileId: source.id, pageId: testPage.id, lastSeenRevisionId: null, createdAt: now, updatedAt: now },
          { profileId: target.id, pageId: testPage.id, lastSeenRevisionId: null, createdAt: now, updatedAt: now }
        ]
      });
      await prisma.wikiEditRequest.create({
        data: {
          requestKind: 'create',
          targetNamespaceId: mainNamespace.id,
          targetNamespaceCode: 'main',
          targetSpaceId: testSpace.id,
          targetTitle: `Pending merge document ${suffix}`,
          targetSlug: `pending-merge-${suffix}`,
          targetDisplayTitle: `Pending merge document ${suffix}`,
          targetPageType: 'article',
          targetOwnerProfileId: source.id,
          proposedContent: 'pending user document',
          editSummary: 'profile merge integration test',
          status: 'pending',
          createdBy: source.id,
          createdAt: now,
          updatedAt: now
        }
      });
      await prisma.subwikiRole.createMany({
        data: [
          { spaceId: testSpace.id, userId: source.id, role: 'maintainer', status: 'active', grantedAt: now },
          {
            spaceId: testSpace.id,
            userId: target.id,
            role: 'maintainer',
            status: 'revoked',
            grantedAt: new Date(now.getTime() - 4_000),
            revokedAt: new Date(now.getTime() - 3_000),
            revokedBy: target.id
          },
          {
            spaceId: testSpace.id,
            userId: source.id,
            role: 'editor',
            status: 'active',
            grantedBy: source.id,
            grantedAt: new Date(now.getTime() - 2_000)
          },
          {
            spaceId: testSpace.id,
            userId: target.id,
            role: 'editor',
            status: 'active',
            grantedBy: target.id,
            grantedAt: new Date(now.getTime() - 5_000)
          },
          {
            spaceId: testSpace.id,
            userId: source.id,
            role: 'reviewer',
            status: 'active',
            grantedBy: source.id,
            grantedAt: new Date(now.getTime() - 1_000)
          },
          {
            spaceId: testSpace.id,
            userId: source.id,
            role: 'trusted',
            status: 'revoked',
            grantedAt: new Date(now.getTime() - 6_000),
            revokedAt: new Date(now.getTime() - 5_000),
            revokedBy: source.id
          }
        ]
      });
      const aclGroup = await prisma.aclGroup.create({
        data: {
          groupKey: `merge_test_${suffix}`,
          title: 'Merge integration ACL group',
          status: 'active',
          createdAt: now,
          updatedAt: now
        }
      });
      aclGroupId = aclGroup.id;
      await prisma.aclGroupMember.createMany({
        data: [
          { groupId: aclGroup.id, memberType: 'user', userId: source.id, reason: 'profile merge integration test', addedAt: now },
          { groupId: aclGroup.id, memberType: 'user', userId: target.id, reason: 'profile merge integration test', addedAt: now }
        ]
      });
      const wikiGroup = await prisma.wikiGroup.create({
        data: { code: `merge_${suffix}`, displayName: 'Merge integration group' }
      });
      wikiGroupId = wikiGroup.id;
      await prisma.wikiUserGroup.createMany({
        data: [
          { userId: source.id, groupId: wikiGroup.id },
          { userId: target.id, groupId: wikiGroup.id }
        ]
      });

      const preview = await service.preview(canonicalAccountId);
      assert.equal(preview.target.id, target.id.toString());
      assert.equal(preview.candidates.length, 1);
      assert.equal(preview.candidates[0]?.profile.id, source.id.toString());
      assert.equal(preview.candidates[0]?.requiresBlockedStatus, true);
      assert.equal(preview.candidates[0]?.counts.historical.recentChanges, 1);
      assert.equal(preview.candidates[0]?.counts.current.notifications, 1);
      assert.equal(preview.candidates[0]?.counts.current.directAclRules, 1);
      assert.equal(preview.candidates[0]?.counts.current.ownedPages, 1);
      assert.equal(preview.candidates[0]?.counts.current.ownedSpaces, 1);
      assert.equal(preview.candidates[0]?.counts.current.pendingUserDocuments, 1);
      assert.equal(preview.candidates[0]?.counts.current.watches, 1);
      assert.equal(preview.candidates[0]?.counts.current.subwikiRoles, 3);
      assert.equal(preview.candidates[0]?.counts.current.aclMemberships, 1);
      assert.equal(preview.candidates[0]?.counts.current.wikiGroups, 1);

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
      const pendingPreview = await service.preview(canonicalAccountId);
      assert.equal(pendingPreview.candidates.length, 0);
      assert.equal(pendingPreview.pendingRequests.length, 1);
      assert.equal(pendingPreview.pendingRequests[0]?.request.id, requested.id);
      assert.equal(pendingPreview.pendingRequests[0]?.source.id, source.id.toString());

      await assert.rejects(
        service.approve(
          requested.id,
          { accountId: canonicalAccountId, profileId: target.id },
          { sourceUsername: 'wrong-name', targetUsername: target.username, reason: 'verified merge approval' }
        ),
        /확인 사용자명이 병합 요청과 일치하지 않습니다/u
      );
      assert.equal((await prisma.wikiProfileMergeRequest.findUnique({ where: { id: requested.id } }))?.status, 'pending');
      assert.equal(await prisma.wikiProfileAlias.count({ where: { sourceProfileId: source.id } }), 0);

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
      assert.equal(completed.transferred.ownedPages, 1);
      assert.equal(completed.transferred.ownedSpaces, 1);
      assert.equal(completed.transferred.pendingUserDocuments, 1);
      assert.equal(completed.transferred.usernameAliases, 1);
      assert.equal(completed.transferred.watches, 1);
      assert.equal(completed.transferred.subwikiRoles, 3);
      assert.equal(completed.transferred.aclMemberships, 1);
      assert.equal(completed.transferred.wikiGroups, 1);

      const [mergedSource, blockedTarget, alias, usernameAlias, historicalChange, movedNotification, movedAcl] = await Promise.all([
        prisma.wikiProfile.findUnique({ where: { id: source.id } }),
        prisma.wikiProfile.findUnique({ where: { id: target.id } }),
        prisma.wikiProfileAlias.findUnique({ where: { sourceProfileId: source.id } }),
        prisma.wikiUsernameAlias.findUnique({ where: { oldUsername: preservedUsername } }),
        prisma.wikiRecentChange.findFirst({ where: { title: `Merge history ${suffix}` } }),
        prisma.wikiNotification.findUnique({ where: { id: notification.id } }),
        prisma.aclRule.findUnique({ where: { id: directAcl.id } })
      ]);
      assert.equal(mergedSource?.status, 'merged');
      assert.equal(mergedSource?.mergedIntoProfileId, target.id);
      assert.equal(blockedTarget?.status, 'blocked');
      assert.equal(alias?.targetProfileId, target.id);
      assert.equal(usernameAlias?.profileId, target.id);
      assert.equal(blockedTarget?.usernameChangedAt?.toISOString(), source.usernameChangedAt?.toISOString());
      assert.equal(historicalChange?.actorId, source.id);
      assert.equal(movedNotification?.profileId, target.id);
      assert.equal(movedAcl?.subjectValue, target.id.toString());
      const inheritedBlock = await prisma.wikiUserBlockEvent.findFirst({
        where: { targetProfileId: target.id, actorProfileId: target.id, action: 'block' },
        orderBy: { id: 'desc' }
      });
      assert.equal(inheritedBlock?.previousStatus, 'active');
      assert.equal(inheritedBlock?.newStatus, 'blocked');
      assert.equal((await prisma.wikiPage.findUnique({ where: { id: testPage.id } }))?.ownerProfileId, target.id);
      assert.equal((await prisma.wikiSpace.findUnique({ where: { id: testSpace.id } }))?.ownerUserId, target.id);
      const pendingDocument = await prisma.wikiEditRequest.findFirst({ where: { targetSpaceId: testSpace.id, editSummary: 'profile merge integration test' } });
      assert.equal(pendingDocument?.targetOwnerProfileId, target.id);
      assert.equal(pendingDocument?.createdBy, source.id);
      assert.equal(await prisma.wikiPageWatch.count({ where: { profileId: target.id, pageId: testPage.id } }), 1);
      assert.equal(await prisma.wikiPageWatch.count({ where: { profileId: source.id, pageId: testPage.id } }), 0);
      const [revokedTargetRole, activeTargetRole, inheritedTargetRole, absentRevokedTargetRole, revokedSourceRole] = await Promise.all([
        prisma.subwikiRole.findUnique({ where: { spaceId_userId_role: { spaceId: testSpace.id, userId: target.id, role: 'maintainer' } } }),
        prisma.subwikiRole.findUnique({ where: { spaceId_userId_role: { spaceId: testSpace.id, userId: target.id, role: 'editor' } } }),
        prisma.subwikiRole.findUnique({ where: { spaceId_userId_role: { spaceId: testSpace.id, userId: target.id, role: 'reviewer' } } }),
        prisma.subwikiRole.findUnique({ where: { spaceId_userId_role: { spaceId: testSpace.id, userId: target.id, role: 'trusted' } } }),
        prisma.subwikiRole.findUnique({ where: { spaceId_userId_role: { spaceId: testSpace.id, userId: source.id, role: 'maintainer' } } })
      ]);
      assert.equal(revokedTargetRole?.status, 'revoked');
      assert.equal(revokedTargetRole?.revokedAt?.getTime(), now.getTime() - 3_000);
      assert.equal(revokedTargetRole?.revokedBy, target.id);
      assert.equal(activeTargetRole?.status, 'active');
      assert.equal(activeTargetRole?.grantedBy, target.id);
      assert.equal(activeTargetRole?.grantedAt.getTime(), now.getTime() - 5_000);
      assert.equal(inheritedTargetRole?.status, 'active');
      assert.equal(inheritedTargetRole?.grantedBy, source.id);
      assert.equal(inheritedTargetRole?.grantedAt.getTime(), now.getTime() - 1_000);
      assert.equal(absentRevokedTargetRole, null);
      assert.equal(revokedSourceRole?.status, 'revoked');
      assert.equal(revokedSourceRole?.revokedBy, target.id);
      assert.equal(await prisma.aclGroupMember.count({ where: { groupId: aclGroup.id, userId: target.id, removedAt: null } }), 1);
      assert.equal(await prisma.aclGroupMember.count({ where: { groupId: aclGroup.id, userId: source.id, removedAt: null } }), 0);
      assert.equal(await prisma.wikiUserGroup.count({ where: { userId: target.id, groupId: wikiGroup.id } }), 1);
      assert.equal(await prisma.wikiUserGroup.count({ where: { userId: source.id, groupId: wikiGroup.id } }), 0);

      const [publicAlias, ensuredAlias, contributions] = await Promise.all([
        profiles.getPublicProfile(source.username, canonicalAccountId),
        profiles.ensureWikiProfile(aliasAccountId),
        read.getContributions({ profileId: source.id.toString(), activity: 'edits' })
      ]);
      assert.equal(publicAlias.id, target.id.toString());
      assert.equal(publicAlias.isAlias, true);
      assert.equal(publicAlias.requestedUsername, source.username);
      assert.equal(publicAlias.canonicalUsername, target.username);
      assert.equal(ensuredAlias.id, target.id);
      assert.equal(contributions.profile.id, target.id.toString());
      assert.equal(contributions.requestedProfileId, source.id.toString());
      assert.deepEqual(new Set(contributions.mergedProfileIds), new Set([source.id.toString(), target.id.toString()]));

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
        await prisma.wikiUserBlockEvent.deleteMany({ where: { targetProfileId: { in: ids } } });
        await prisma.wikiPageWatch.deleteMany({ where: { profileId: { in: ids } } });
        await prisma.wikiEditRequest.deleteMany({ where: { editSummary: 'profile merge integration test' } });
        await prisma.subwikiRole.deleteMany({ where: { userId: { in: ids } } });
        await prisma.aclGroupMember.deleteMany({ where: { userId: { in: ids } } });
        await prisma.wikiUserGroup.deleteMany({ where: { userId: { in: ids } } });
        if (sourceProfileId) {
          await prisma.wikiProfile.update({
            where: { id: sourceProfileId },
            data: { mergedIntoProfileId: null, mergedAt: null }
          }).catch(() => undefined);
        }
      }
      if (testPageId) await prisma.wikiPage.deleteMany({ where: { id: testPageId } });
      if (testSpaceId) await prisma.wikiSpace.deleteMany({ where: { id: testSpaceId } });
      if (aclGroupId) await prisma.aclGroup.deleteMany({ where: { id: aclGroupId } });
      if (wikiGroupId) await prisma.wikiGroup.deleteMany({ where: { id: wikiGroupId } });
      const profileIds = [sourceProfileId, targetProfileId, foreignProfileId].filter((id): id is bigint => id !== null);
      if (profileIds.length > 0) {
        await prisma.wikiProfile.deleteMany({ where: { id: { in: profileIds } } });
      }
      await prisma.account.deleteMany({ where: { id: { in: [canonicalAccountId, aliasAccountId, foreignAccountId] } } });
    }
  });
}
