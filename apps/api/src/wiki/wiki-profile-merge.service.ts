import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { writeAuditRecord } from '../events/audit-event-writer';
import { WikiProfileService } from './wiki-profile.service';

const MERGEABLE_PROFILE_STATUSES = ['active', 'blocked'] as const;
const ACTIVE_REQUEST_STATUSES = ['pending', 'executing'] as const;

export interface WikiProfileMergeProfileSummary {
  readonly id: string;
  readonly username: string;
  readonly displayName: string;
  readonly status: string;
}

interface MergeCounts {
  readonly historical: {
    readonly revisions: number;
    readonly recentChanges: number;
    readonly discussionThreads: number;
    readonly discussionComments: number;
    readonly editRequests: number;
  };
  readonly current: {
    readonly ownedPages: number;
    readonly ownedSpaces: number;
    readonly pendingUserDocuments: number;
    readonly watches: number;
    readonly discussionSubscriptions: number;
    readonly pollVotes: number;
    readonly notifications: number;
    readonly pushSubscriptions: number;
    readonly subwikiRoles: number;
    readonly aclMemberships: number;
    readonly directAclRules: number;
    readonly wikiGroups: number;
  };
}

export interface WikiProfileMergeCandidate {
  readonly profile: WikiProfileMergeProfileSummary;
  readonly counts: MergeCounts;
  readonly requiresBlockedStatus: boolean;
}

export interface WikiProfileMergeRequestSummary {
  readonly id: string;
  readonly sourceProfileId: string;
  readonly targetProfileId: string;
  readonly status: string;
  readonly reason: string | null;
  readonly preview: Prisma.JsonValue;
  readonly errorCode: string | null;
  readonly requestedAt: string;
  readonly approvedAt: string | null;
  readonly completedAt: string | null;
  readonly rejectedAt: string | null;
  readonly version: number;
}

export interface WikiProfileMergePreview {
  readonly target: WikiProfileMergeProfileSummary;
  readonly candidates: WikiProfileMergeCandidate[];
  readonly pendingRequests: Array<{
    readonly request: WikiProfileMergeRequestSummary;
    readonly source: WikiProfileMergeProfileSummary;
  }>;
  readonly policy: {
    readonly historicalActorsPreserved: true;
    readonly currentStateTransferred: true;
    readonly userDocumentsOverwritten: false;
    readonly adminApprovalRequired: true;
  };
}

@Injectable()
export class WikiProfileMergeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService
  ) {}

  async preview(accountId: string): Promise<WikiProfileMergePreview> {
    const target = await this.profiles.ensureWikiProfile(accountId);
    return this.prisma.$transaction((tx) => this.buildPreview(tx, accountId, target.id));
  }

  async request(
    accountId: string,
    input: {
      readonly sourceProfileId?: string;
      readonly sourceUsername?: string;
      readonly targetUsername?: string;
      readonly reason?: string;
    }
  ) {
    const sourceProfileId = parseId(input.sourceProfileId, 'sourceProfileId');
    const sourceUsername = normalizeConfirmation(input.sourceUsername, 'sourceUsername');
    const targetUsername = normalizeConfirmation(input.targetUsername, 'targetUsername');
    const reason = normalizeReason(input.reason, false);
    const target = await this.profiles.ensureWikiProfile(accountId);

    return this.prisma.$transaction(async (tx) => {
      const group = await this.resolveAccountGroup(tx, accountId);
      const activeKey = `${sourceProfileId.toString()}:${target.id.toString()}`;
      const existing = await tx.wikiProfileMergeRequest.findFirst({
        where: { activeKey, status: { in: [...ACTIVE_REQUEST_STATUSES] } }
      });
      if (existing && existing.canonicalAccountId === group.canonicalAccountId) {
        const [sourceProfile, targetProfile] = await Promise.all([
          tx.wikiProfile.findUnique({ where: { id: sourceProfileId }, select: { username: true } }),
          tx.wikiProfile.findUnique({ where: { id: target.id }, select: { username: true } })
        ]);
        if (sourceProfile?.username !== sourceUsername || targetProfile?.username !== targetUsername) {
          throw new BadRequestException('원본 및 대상 사용자명 확인 값이 현재 프로필과 일치하지 않습니다.');
        }
        return this.serializeRequest(existing);
      }
      const preview = await this.buildPreview(tx, accountId, target.id);
      const candidate = preview.candidates.find((item) => item.profile.id === sourceProfileId.toString());
      if (!candidate) {
        throw new BadRequestException('선택한 위키 프로필은 현재 계정 그룹에서 병합할 수 없습니다.');
      }
      if (candidate.profile.username !== sourceUsername || preview.target.username !== targetUsername) {
        throw new BadRequestException('원본 및 대상 사용자명 확인 값이 현재 프로필과 일치하지 않습니다.');
      }

      const created = await tx.wikiProfileMergeRequest.create({
        data: {
          canonicalAccountId: group.canonicalAccountId,
          sourceProfileId,
          targetProfileId: target.id,
          status: 'pending',
          requestedByAccountId: group.canonicalAccountId,
          requestedByProfileId: target.id,
          reason,
          previewJson: candidate as unknown as Prisma.InputJsonValue,
          activeKey,
          updatedAt: new Date()
        }
      });
      await writeAuditRecord(tx, {
        data: {
          category: 'wiki_profile',
          action: 'wiki_profile.merge_requested',
          actorAccountId: group.canonicalAccountId,
          actorProfileId: target.id,
          subjectType: 'wiki_profile_merge_request',
          subjectId: created.id,
          metadata: {
            sourceProfileId: sourceProfileId.toString(),
            targetProfileId: target.id.toString(),
            requiresBlockedStatus: candidate.requiresBlockedStatus
          }
        }
      });
      return this.serializeRequest(created);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async listForAdmin(status?: string) {
    const normalizedStatus = status?.trim().toLowerCase();
    if (normalizedStatus && !['pending', 'executing', 'completed', 'rejected', 'failed'].includes(normalizedStatus)) {
      throw new BadRequestException('지원하지 않는 병합 요청 상태입니다.');
    }
    const rows = await this.prisma.wikiProfileMergeRequest.findMany({
      where: normalizedStatus ? { status: normalizedStatus } : undefined,
      orderBy: [{ requestedAt: 'desc' }, { id: 'desc' }],
      take: 100
    });
    const profileIds = [...new Set(rows.flatMap((row) => [row.sourceProfileId, row.targetProfileId]))];
    const profiles = await this.prisma.wikiProfile.findMany({
      where: { id: { in: profileIds } },
      select: { id: true, username: true, displayName: true, status: true }
    });
    const profilesById = new Map(profiles.map((profile) => [profile.id.toString(), this.profileSummary(profile)]));
    return rows.map((row) => ({
      ...this.serializeRequest(row),
      source: profilesById.get(row.sourceProfileId.toString()) ?? null,
      target: profilesById.get(row.targetProfileId.toString()) ?? null
    }));
  }

  async approve(
    requestId: string,
    actor: { readonly accountId: string; readonly profileId: bigint },
    input: { readonly sourceUsername?: string; readonly targetUsername?: string; readonly reason?: string }
  ) {
    const id = normalizeRequestId(requestId);
    const sourceUsername = normalizeConfirmation(input.sourceUsername, 'sourceUsername');
    const targetUsername = normalizeConfirmation(input.targetUsername, 'targetUsername');
    const approvalReason = normalizeReason(input.reason, true);

    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM wiki_profile_merge_requests WHERE id = ${id} FOR UPDATE`;
      const request = await tx.wikiProfileMergeRequest.findUnique({ where: { id } });
      if (!request) {
        throw new NotFoundException('위키 프로필 병합 요청을 찾을 수 없습니다.');
      }
      if (request.status === 'completed') {
        return this.serializeRequest(request);
      }
      if (request.status !== 'pending') {
        throw new ConflictException('대기 중인 병합 요청만 승인할 수 있습니다.');
      }

      const [source, target] = await Promise.all([
        tx.wikiProfile.findUnique({ where: { id: request.sourceProfileId } }),
        tx.wikiProfile.findUnique({ where: { id: request.targetProfileId } })
      ]);
      if (!source || !target) {
        throw new ConflictException('병합 대상 위키 프로필이 더 이상 존재하지 않습니다.');
      }
      if (source.username !== sourceUsername || target.username !== targetUsername) {
        throw new BadRequestException('관리자 확인 사용자명이 병합 요청과 일치하지 않습니다.');
      }
      if (!source.accountId || !target.accountId) {
        throw new ConflictException('계정에 연결되지 않은 위키 프로필은 병합할 수 없습니다.');
      }
      if (source.mergedIntoProfileId || source.status === 'merged') {
        throw new ConflictException('원본 위키 프로필은 이미 병합되었습니다.');
      }
      if (!MERGEABLE_PROFILE_STATUSES.includes(source.status as typeof MERGEABLE_PROFILE_STATUSES[number]) ||
          !MERGEABLE_PROFILE_STATUSES.includes(target.status as typeof MERGEABLE_PROFILE_STATUSES[number])) {
        throw new ConflictException('현재 상태에서는 위키 프로필을 병합할 수 없습니다.');
      }

      const group = await this.resolveAccountGroup(tx, target.accountId);
      if (
        group.canonicalAccountId !== request.canonicalAccountId ||
        !group.accountIds.includes(source.accountId) ||
        !group.accountIds.includes(target.accountId)
      ) {
        throw new ConflictException('계정 연결 상태가 요청 이후 변경되어 병합을 중단했습니다.');
      }

      await tx.wikiProfileMergeRequest.update({
        where: { id },
        data: {
          status: 'executing',
          approvedByProfileId: actor.profileId,
          approvedAt: new Date(),
          errorCode: null,
          version: { increment: 1 }
        }
      });

      const transferred = await this.transferCurrentState(tx, source.id, target.id, actor.profileId);
      const now = new Date();
      await tx.wikiProfileAlias.create({
        data: {
          sourceProfileId: source.id,
          targetProfileId: target.id,
          mergeRequestId: id,
          createdAt: now
        }
      });
      await tx.wikiProfile.update({
        where: { id: source.id },
        data: {
          status: 'merged',
          mergedIntoProfileId: target.id,
          mergedAt: now,
          updatedAt: now
        }
      });
      if (source.status === 'blocked' && target.status !== 'blocked') {
        await tx.wikiProfile.update({
          where: { id: target.id },
          data: { status: 'blocked', updatedAt: now }
        });
        await tx.wikiUserBlockEvent.create({
          data: {
            targetProfileId: target.id,
            actorProfileId: actor.profileId,
            action: 'block',
            previousStatus: target.status,
            newStatus: 'blocked',
            reason: `Blocked status inherited from merged profile ${source.id.toString()}: ${approvalReason}`,
            publicReason: '병합된 프로필의 차단 상태가 승계되었습니다.',
            createdAt: now
          }
        });
      }
      const completed = await tx.wikiProfileMergeRequest.update({
        where: { id },
        data: {
          status: 'completed',
          activeKey: null,
          completedAt: now,
          errorCode: null,
          version: { increment: 1 },
          reason: request.reason ?? approvalReason
        }
      });
      await writeAuditRecord(tx, {
        data: {
          category: 'wiki_profile',
          action: 'wiki_profile.merge_completed',
          severity: 'warning',
          actorAccountId: actor.accountId,
          actorProfileId: actor.profileId,
          subjectType: 'wiki_profile_merge_request',
          subjectId: id,
          metadata: {
            sourceProfileId: source.id.toString(),
            targetProfileId: target.id.toString(),
            sourceWasBlocked: source.status === 'blocked',
            approvalReason,
            transferred
          } as Prisma.InputJsonValue
        }
      });
      return { ...this.serializeRequest(completed), transferred };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  async reject(
    requestId: string,
    actor: { readonly accountId: string; readonly profileId: bigint },
    reasonInput?: string
  ) {
    const id = normalizeRequestId(requestId);
    const reason = normalizeReason(reasonInput, true);
    return this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM wiki_profile_merge_requests WHERE id = ${id} FOR UPDATE`;
      const request = await tx.wikiProfileMergeRequest.findUnique({ where: { id } });
      if (!request) throw new NotFoundException('위키 프로필 병합 요청을 찾을 수 없습니다.');
      if (request.status === 'rejected') return this.serializeRequest(request);
      if (request.status !== 'pending') {
        throw new ConflictException('대기 중인 병합 요청만 거절할 수 있습니다.');
      }
      const rejected = await tx.wikiProfileMergeRequest.update({
        where: { id },
        data: {
          status: 'rejected',
          activeKey: null,
          rejectedAt: new Date(),
          approvedByProfileId: actor.profileId,
          reason,
          version: { increment: 1 }
        }
      });
      await writeAuditRecord(tx, {
        data: {
          category: 'wiki_profile',
          action: 'wiki_profile.merge_rejected',
          actorAccountId: actor.accountId,
          actorProfileId: actor.profileId,
          subjectType: 'wiki_profile_merge_request',
          subjectId: id,
          metadata: { reason }
        }
      });
      return this.serializeRequest(rejected);
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
  }

  private async buildPreview(
    tx: Prisma.TransactionClient,
    accountId: string,
    targetProfileId: bigint
  ): Promise<WikiProfileMergePreview> {
    const group = await this.resolveAccountGroup(tx, accountId);
    const target = await tx.wikiProfile.findUnique({ where: { id: targetProfileId } });
    if (!target || !target.accountId || !group.accountIds.includes(target.accountId)) {
      throw new ConflictException('현재 계정의 기준 위키 프로필을 확인할 수 없습니다.');
    }
    const candidates = await tx.wikiProfile.findMany({
      where: {
        accountId: { in: group.accountIds },
        id: { not: target.id },
        status: { in: [...MERGEABLE_PROFILE_STATUSES] },
        mergedIntoProfileId: null
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
    });
    const pending = await tx.wikiProfileMergeRequest.findMany({
      where: {
        canonicalAccountId: group.canonicalAccountId,
        targetProfileId: target.id,
        sourceProfileId: { in: candidates.map((profile) => profile.id) },
        status: { in: [...ACTIVE_REQUEST_STATUSES] }
      }
    });
    const pendingIds = new Set(pending.map((item) => item.sourceProfileId.toString()));
    const available = candidates.filter((profile) => !pendingIds.has(profile.id.toString()));
    const candidatesById = new Map(candidates.map((profile) => [profile.id.toString(), profile]));
    const candidateViews = await Promise.all(available.map(async (profile) => ({
      profile: this.profileSummary(profile),
      counts: await this.countProfileState(tx, profile.id),
      requiresBlockedStatus: profile.status === 'blocked'
    })));
    return {
      target: this.profileSummary(target),
      candidates: candidateViews,
      pendingRequests: pending.flatMap((request) => {
        const source = candidatesById.get(request.sourceProfileId.toString());
        return source ? [{ request: this.serializeRequest(request), source: this.profileSummary(source) }] : [];
      }),
      policy: {
        historicalActorsPreserved: true,
        currentStateTransferred: true,
        userDocumentsOverwritten: false,
        adminApprovalRequired: true
      }
    };
  }

  private async countProfileState(tx: Prisma.TransactionClient, profileId: bigint): Promise<MergeCounts> {
    const [
      revisions,
      recentChanges,
      discussionThreads,
      discussionComments,
      editRequests,
      ownedPages,
      ownedSpaces,
      pendingUserDocuments,
      watches,
      discussionSubscriptions,
      pollVotes,
      notifications,
      pushSubscriptions,
      subwikiRoles,
      aclMemberships,
      directAclRules,
      wikiGroups
    ] = await Promise.all([
      tx.wikiPageRevision.count({ where: { OR: [{ createdBy: profileId }, { actorUserId: profileId }] } }),
      tx.wikiRecentChange.count({ where: { actorId: profileId } }),
      tx.wikiDiscussionThread.count({ where: { createdBy: profileId } }),
      tx.wikiDiscussionComment.count({ where: { createdBy: profileId } }),
      tx.wikiEditRequest.count({ where: { OR: [{ createdBy: profileId }, { reviewedBy: profileId }] } }),
      tx.wikiPage.count({ where: { ownerProfileId: profileId } }),
      tx.wikiSpace.count({ where: { ownerUserId: profileId } }),
      tx.wikiEditRequest.count({ where: { targetOwnerProfileId: profileId, status: 'pending' } }),
      tx.wikiPageWatch.count({ where: { profileId } }),
      tx.wikiDiscussionSubscription.count({ where: { profileId } }),
      tx.wikiDiscussionPollVote.count({ where: { profileId } }),
      tx.wikiNotification.count({ where: { profileId } }),
      tx.wikiPushSubscription.count({ where: { profileId } }),
      tx.subwikiRole.count({ where: { userId: profileId, status: 'active' } }),
      tx.aclGroupMember.count({
        where: {
          userId: profileId,
          memberType: 'user',
          removedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }]
        }
      }),
      tx.aclRule.count({ where: { subjectType: 'user', subjectValue: profileId.toString() } }),
      tx.wikiUserGroup.count({ where: { userId: profileId } })
    ]);
    return {
      historical: { revisions, recentChanges, discussionThreads, discussionComments, editRequests },
      current: {
        ownedPages,
        ownedSpaces,
        pendingUserDocuments,
        watches,
        discussionSubscriptions,
        pollVotes,
        notifications,
        pushSubscriptions,
        subwikiRoles,
        aclMemberships,
        directAclRules,
        wikiGroups
      }
    };
  }

  private async transferCurrentState(
    tx: Prisma.TransactionClient,
    sourceId: bigint,
    targetId: bigint,
    actorProfileId: bigint
  ) {
    const now = new Date();
    const ownedPages = await tx.wikiPage.updateMany({ where: { ownerProfileId: sourceId }, data: { ownerProfileId: targetId } });
    const ownedSpaces = await tx.wikiSpace.updateMany({ where: { ownerUserId: sourceId }, data: { ownerUserId: targetId, updatedAt: now } });
    const pendingUserDocuments = await tx.wikiEditRequest.updateMany({
      where: { targetOwnerProfileId: sourceId, status: 'pending' },
      data: { targetOwnerProfileId: targetId, updatedAt: now }
    });
    const usernameAliases = await tx.wikiUsernameAlias.updateMany({
      where: { profileId: sourceId },
      data: { profileId: targetId }
    });
    const [sourceProfile, targetProfile] = await Promise.all([
      tx.wikiProfile.findUnique({ where: { id: sourceId }, select: { usernameChangedAt: true } }),
      tx.wikiProfile.findUnique({ where: { id: targetId }, select: { usernameChangedAt: true } }),
    ]);
    if (sourceProfile?.usernameChangedAt &&
        (!targetProfile?.usernameChangedAt || sourceProfile.usernameChangedAt > targetProfile.usernameChangedAt)) {
      await tx.wikiProfile.update({
        where: { id: targetId },
        data: { usernameChangedAt: sourceProfile.usernameChangedAt, updatedAt: now }
      });
    }

    const sourceWatches = await tx.wikiPageWatch.findMany({ where: { profileId: sourceId } });
    let watches = 0;
    for (const source of sourceWatches) {
      const target = await tx.wikiPageWatch.findUnique({ where: { profileId_pageId: { profileId: targetId, pageId: source.pageId } } });
      if (target) {
        const lastSeenRevisionId = target.lastSeenRevisionId === null || source.lastSeenRevisionId === null
          ? null
          : target.lastSeenRevisionId < source.lastSeenRevisionId ? target.lastSeenRevisionId : source.lastSeenRevisionId;
        await tx.wikiPageWatch.update({ where: { id: target.id }, data: { lastSeenRevisionId, updatedAt: now } });
        await tx.wikiPageWatch.delete({ where: { id: source.id } });
      } else {
        await tx.wikiPageWatch.update({ where: { id: source.id }, data: { profileId: targetId, updatedAt: now } });
      }
      watches += 1;
    }

    const subscriptions = await this.transferUniqueCurrentRows(
      tx.wikiDiscussionSubscription,
      sourceId,
      targetId,
      'threadId'
    );
    const pollVotes = await this.transferUniqueCurrentRows(
      tx.wikiDiscussionPollVote,
      sourceId,
      targetId,
      'pollId'
    );
    const notifications = await tx.wikiNotification.updateMany({ where: { profileId: sourceId }, data: { profileId: targetId } });
    const pushSubscriptions = await tx.wikiPushSubscription.updateMany({ where: { profileId: sourceId }, data: { profileId: targetId } });

    const subwikiRoles = await this.transferSubwikiRoles(tx, sourceId, targetId, actorProfileId, now);

    const activeAclMemberships = await tx.aclGroupMember.findMany({
      where: {
        userId: sourceId,
        memberType: 'user',
        removedAt: null,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
      }
    });
    for (const source of activeAclMemberships) {
      const target = await tx.aclGroupMember.findFirst({
        where: {
          groupId: source.groupId,
          userId: targetId,
          memberType: 'user',
          removedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }]
        }
      });
      if (!target) {
        await tx.aclGroupMember.create({
          data: {
            groupId: source.groupId,
            memberType: 'user',
            userId: targetId,
            reason: source.reason,
            expiresAt: source.expiresAt,
            addedBy: source.addedBy,
            addedAt: source.addedAt
          }
        });
      }
      await tx.aclGroupMember.update({ where: { id: source.id }, data: { removedAt: now } });
    }

    const directAclRules = await tx.aclRule.updateMany({
      where: { subjectType: 'user', subjectValue: sourceId.toString() },
      data: { subjectValue: targetId.toString(), updatedAt: now }
    });

    const sourceGroups = await tx.wikiUserGroup.findMany({ where: { userId: sourceId } });
    for (const source of sourceGroups) {
      await tx.wikiUserGroup.upsert({
        where: { userId_groupId: { userId: targetId, groupId: source.groupId } },
        create: { userId: targetId, groupId: source.groupId },
        update: {}
      });
    }
    if (sourceGroups.length > 0) {
      await tx.wikiUserGroup.deleteMany({ where: { userId: sourceId } });
    }

    return {
      ownedPages: ownedPages.count,
      ownedSpaces: ownedSpaces.count,
      pendingUserDocuments: pendingUserDocuments.count,
      usernameAliases: usernameAliases.count,
      watches,
      discussionSubscriptions: subscriptions,
      pollVotes,
      notifications: notifications.count,
      pushSubscriptions: pushSubscriptions.count,
      subwikiRoles,
      aclMemberships: activeAclMemberships.length,
      directAclRules: directAclRules.count,
      wikiGroups: sourceGroups.length
    };
  }

  private async transferSubwikiRoles(
    tx: Prisma.TransactionClient,
    sourceId: bigint,
    targetId: bigint,
    actorProfileId: bigint,
    now: Date
  ): Promise<number> {
    await tx.$queryRaw<Array<{ id: bigint }>>`
      SELECT id
      FROM subwiki_roles
      WHERE user_id IN (${sourceId}, ${targetId})
      ORDER BY id
      FOR UPDATE
    `;
    const activeRoles = await tx.subwikiRole.findMany({ where: { userId: sourceId, status: 'active' } });
    for (const source of activeRoles) {
      const target = await tx.subwikiRole.findUnique({
        where: { spaceId_userId_role: { spaceId: source.spaceId, userId: targetId, role: source.role } }
      });
      if (!target) {
        await tx.subwikiRole.create({
          data: {
            spaceId: source.spaceId,
            userId: targetId,
            role: source.role,
            status: 'active',
            grantedBy: source.grantedBy,
            grantedAt: source.grantedAt
          }
        });
      }
      await tx.subwikiRole.update({
        where: { id: source.id },
        data: { status: 'revoked', revokedAt: now, revokedBy: actorProfileId }
      });
    }
    return activeRoles.length;
  }

  private async transferUniqueCurrentRows(
    delegate: {
      findMany(args: unknown): Promise<Array<{ id: bigint; profileId: bigint; [key: string]: unknown }>>;
      findFirst(args: unknown): Promise<{ id: bigint } | null>;
      update(args: unknown): Promise<unknown>;
      delete(args: unknown): Promise<unknown>;
    },
    sourceId: bigint,
    targetId: bigint,
    uniqueField: 'threadId' | 'pollId'
  ): Promise<number> {
    const rows = await delegate.findMany({ where: { profileId: sourceId } });
    for (const source of rows) {
      const target = await delegate.findFirst({ where: { profileId: targetId, [uniqueField]: source[uniqueField] } });
      if (target) {
        await delegate.delete({ where: { id: source.id } });
      } else {
        await delegate.update({ where: { id: source.id }, data: { profileId: targetId } });
      }
    }
    return rows.length;
  }

  private async resolveAccountGroup(tx: Prisma.TransactionClient, accountId: string) {
    const seed = await tx.account.findUnique({
      where: { id: accountId },
      select: { id: true, canonicalAccountId: true, lifecycleStatus: true }
    });
    if (!seed || seed.lifecycleStatus !== 'active') {
      throw new NotFoundException('활성 계정을 찾을 수 없습니다.');
    }
    const canonicalAccountId = seed.canonicalAccountId ?? seed.id;
    const rows = await tx.account.findMany({
      where: { OR: [{ id: canonicalAccountId }, { canonicalAccountId }] },
      select: { id: true, canonicalAccountId: true, lifecycleStatus: true }
    });
    const activeRows = rows.filter((row) => row.lifecycleStatus === 'active');
    if (!activeRows.some((row) => row.id === seed.id) || !activeRows.some((row) => row.id === canonicalAccountId)) {
      throw new ConflictException('연결된 계정 그룹 상태가 일관되지 않습니다.');
    }
    if (activeRows.some((row) => (row.canonicalAccountId ?? row.id) !== canonicalAccountId)) {
      throw new ConflictException('연결된 계정의 기준 계정 정보가 일치하지 않습니다.');
    }
    return { canonicalAccountId, accountIds: activeRows.map((row) => row.id) };
  }

  private profileSummary(profile: { id: bigint; username: string; displayName: string; status: string }): WikiProfileMergeProfileSummary {
    return {
      id: profile.id.toString(),
      username: profile.username,
      displayName: profile.displayName,
      status: profile.status
    };
  }

  private serializeRequest(request: {
    id: string;
    sourceProfileId: bigint;
    targetProfileId: bigint;
    status: string;
    reason: string | null;
    previewJson: Prisma.JsonValue;
    errorCode: string | null;
    requestedAt: Date;
    approvedAt: Date | null;
    completedAt: Date | null;
    rejectedAt: Date | null;
    version: number;
  }): WikiProfileMergeRequestSummary {
    return {
      id: request.id,
      sourceProfileId: request.sourceProfileId.toString(),
      targetProfileId: request.targetProfileId.toString(),
      status: request.status,
      reason: request.reason,
      preview: request.previewJson,
      errorCode: request.errorCode,
      requestedAt: request.requestedAt.toISOString(),
      approvedAt: request.approvedAt?.toISOString() ?? null,
      completedAt: request.completedAt?.toISOString() ?? null,
      rejectedAt: request.rejectedAt?.toISOString() ?? null,
      version: request.version
    };
  }
}

function parseId(value: string | undefined, field: string): bigint {
  if (!value || !/^[1-9]\d{0,19}$/u.test(value)) {
    throw new BadRequestException(`${field} 값이 올바르지 않습니다.`);
  }
  return BigInt(value);
}

function normalizeConfirmation(value: string | undefined, field: string): string {
  const normalized = value?.normalize('NFKC').trim();
  if (!normalized || normalized.length > 64 || normalized.includes('/')) {
    throw new BadRequestException(`${field} 확인 값이 올바르지 않습니다.`);
  }
  return normalized;
}

function normalizeReason(value: string | undefined, required: boolean): string | null {
  const normalized = value?.normalize('NFKC').trim() ?? '';
  if (required && normalized.length < 8) {
    throw new BadRequestException('사유를 8자 이상 입력해 주세요.');
  }
  if (normalized.length > 1000) {
    throw new BadRequestException('사유는 1000자 이하로 입력해 주세요.');
  }
  return normalized || null;
}

function normalizeRequestId(value: string): string {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu.test(value)) {
    throw new BadRequestException('병합 요청 ID가 올바르지 않습니다.');
  }
  return value.toLowerCase();
}
