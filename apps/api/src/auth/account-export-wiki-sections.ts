import type { PrismaService } from '../common/prisma.service';
import type { AccountExportSection } from './account-export-stream';
import {
  EXPORT_PAGE_SIZE,
  afterBigInt,
  filterByPageId,
  filteredPagedSection,
  pagedSection,
  staticSection,
  type FilterReadablePageIds,
  type FilterReadableThreadIds,
} from './account-export-section-utils';

export function buildWikiExportSections(
  prisma: PrismaService,
  sourceAccountIds: readonly string[],
  sourceProfileIds: readonly bigint[],
  filterReadablePageIds?: FilterReadablePageIds,
  filterReadableThreadIds?: FilterReadableThreadIds,
): AccountExportSection[] {
  const accountIds = [...sourceAccountIds];
  const profileIds = [...sourceProfileIds];
  return [
    staticSection('wikiProfiles', async () => prisma.wikiProfile.findMany({
      where: { id: { in: profileIds } }, orderBy: { id: 'asc' },
      select: {
        id: true, accountId: true, username: true, displayName: true, email: true,
        emailVerifiedAt: true, status: true, mergedIntoProfileId: true,
        mergedAt: true, usernameChangedAt: true, createdAt: true, updatedAt: true,
      },
    })),
    staticSection('wikiUsernameAliases', async () => (await prisma.wikiUsernameAlias.findMany({
      where: { profileId: { in: profileIds } },
      orderBy: [{ profileId: 'asc' }, { createdAt: 'asc' }],
      select: { oldUsername: true, profileId: true, createdAt: true },
    })).map((alias) => ({ id: alias.oldUsername, ...alias }))),
    filteredPagedSection('wikiRevisions', (after) => prisma.wikiPageRevision.findMany({
      where: {
        OR: [{ createdBy: { in: profileIds } }, { actorUserId: { in: profileIds } }],
        visibility: 'public',
        id: { gt: afterBigInt(after) },
      },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, pageId: true, revisionNo: true, parentRevisionId: true,
        contentRaw: true, contentHash: true, contentSize: true, syntaxVersion: true,
        editSummary: true, editSummaryHidden: true, isMinor: true, editTags: true,
        createdBy: true, actorType: true, actorUserId: true, createdAt: true, visibility: true,
      },
    }), async (rows) => {
      const visible = await filterByPageId(rows, filterReadablePageIds);
      return visible.map((row) => row.editSummaryHidden ? { ...row, editSummary: null } : row);
    }),
    filteredPagedSection('wikiDiscussionThreads', (after) => prisma.wikiDiscussionThread.findMany({
      where: { createdBy: { in: profileIds }, status: { not: 'deleted' }, id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, pageId: true, title: true, status: true, createdBy: true, createdAt: true, updatedAt: true },
    }), async (rows) => {
      if (!filterReadableThreadIds) return filterByPageId(rows, filterReadablePageIds);
      const readable = await filterReadableThreadIds(rows.map((row) => row.id));
      return rows.filter((row) => readable.has(row.id));
    }),
    filteredPagedSection('wikiDiscussionComments', (after) => prisma.wikiDiscussionComment.findMany({
      where: { createdBy: { in: profileIds }, entryType: 'comment', status: 'normal', id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, threadId: true, content: true, status: true, createdBy: true, createdAt: true, updatedAt: true },
    }), async (rows) => {
      if (!filterReadablePageIds || rows.length === 0) return rows;
      if (filterReadableThreadIds) {
        const readable = await filterReadableThreadIds(rows.map((row) => row.threadId));
        return rows.filter((row) => readable.has(row.threadId));
      }
      const threads = await prisma.wikiDiscussionThread.findMany({ where: { id: { in: rows.map((row) => row.threadId) } }, select: { id: true, pageId: true } });
      const readable = await filterReadablePageIds(threads.map((thread) => thread.pageId));
      const readableThreads = new Set(threads.filter((thread) => readable.has(thread.pageId)).map((thread) => thread.id));
      return rows.filter((row) => readableThreads.has(row.threadId));
    }),
    filteredPagedSection('wikiPollVotes', (after) => prisma.wikiDiscussionPollVote.findMany({
      where: { profileId: { in: profileIds }, id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, pollId: true, optionId: true, profileId: true, createdAt: true, updatedAt: true },
    }), async (rows) => {
      if (!filterReadableThreadIds || rows.length === 0) return rows;
      const polls = await prisma.wikiDiscussionPoll.findMany({
        where: { id: { in: rows.map((row) => row.pollId) } },
        select: { id: true, commentId: true },
      });
      const comments = await prisma.wikiDiscussionComment.findMany({
        where: { id: { in: polls.map((poll) => poll.commentId) } },
        select: { id: true, threadId: true },
      });
      const threadByComment = new Map(comments.map((comment) => [comment.id, comment.threadId]));
      const threadByPoll = new Map(polls.flatMap((poll) => {
        const threadId = threadByComment.get(poll.commentId);
        return threadId === undefined ? [] : [[poll.id, threadId] as const];
      }));
      const readable = await filterReadableThreadIds([...threadByPoll.values()]);
      return rows.filter((row) => {
        const threadId = threadByPoll.get(row.pollId);
        return threadId !== undefined && readable.has(threadId);
      });
    }),
    filteredPagedSection('wikiReportSubmissions', (after) => prisma.wikiReportSubmission.findMany({
      where: { reporterProfileId: { in: profileIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, caseId: true, reporterProfileId: true, reason: true, createdAt: true, reportCase: { select: { targetType: true, targetId: true, pageId: true, status: true, statusUpdatedAt: true } } },
    }), async (rows) => {
      if (!filterReadablePageIds || rows.length === 0) return rows;
      const readablePages = await filterReadablePageIds(rows.map((row) => row.reportCase.pageId));
      const pageVisible = rows.filter((row) => readablePages.has(row.reportCase.pageId));
      if (!filterReadableThreadIds) return pageVisible;
      const commentTargets = pageVisible.filter((row) => row.reportCase.targetType === 'comment');
      const comments = await prisma.wikiDiscussionComment.findMany({
        where: { id: { in: commentTargets.map((row) => row.reportCase.targetId) } },
        select: { id: true, threadId: true },
      });
      const threadByComment = new Map(comments.map((comment) => [comment.id, comment.threadId]));
      const threadByCase = new Map(pageVisible.flatMap((row) => {
        if (row.reportCase.targetType === 'discussion') return [[row.caseId, row.reportCase.targetId] as const];
        if (row.reportCase.targetType === 'comment') {
          const threadId = threadByComment.get(row.reportCase.targetId);
          return threadId === undefined ? [] : [[row.caseId, threadId] as const];
        }
        return [];
      }));
      const readableThreads = await filterReadableThreadIds([...threadByCase.values()]);
      return pageVisible.filter((row) => {
        const threadId = threadByCase.get(row.caseId);
        return threadId === undefined || readableThreads.has(threadId);
      });
    }),
    filteredPagedSection('wikiPageWatches', (after) => prisma.wikiPageWatch.findMany({
      where: { profileId: { in: profileIds }, id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, profileId: true, pageId: true, lastSeenRevisionId: true, createdAt: true, updatedAt: true },
    }), (rows) => filterByPageId(rows, filterReadablePageIds)),
    filteredPagedSection('wikiNotifications', (after) => prisma.wikiNotification.findMany({
      where: { profileId: { in: profileIds }, id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, profileId: true, type: true, pageId: true, actorProfileId: true,
        sourceType: true, sourceId: true, title: true, message: true, href: true,
        readAt: true, createdAt: true,
      },
    }), async (rows) => {
      if (!filterReadablePageIds || rows.length === 0) return rows;
      const pageIds = rows.flatMap((row) => row.pageId === null ? [] : [row.pageId]);
      const readable = await filterReadablePageIds(pageIds);
      return rows.filter((row) => row.pageId === null || readable.has(row.pageId));
    }),
    filteredPagedSection('wikiDiscussionSubscriptions', (after) => prisma.wikiDiscussionSubscription.findMany({
      where: { profileId: { in: profileIds }, id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, threadId: true, profileId: true, muted: true, createdAt: true, updatedAt: true },
    }), async (rows) => {
      if (rows.length === 0) return rows;
      if (filterReadableThreadIds) {
        const readable = await filterReadableThreadIds(rows.map((row) => row.threadId));
        return rows.filter((row) => readable.has(row.threadId));
      }
      if (!filterReadablePageIds) return rows;
      const threads = await prisma.wikiDiscussionThread.findMany({
        where: { id: { in: rows.map((row) => row.threadId) } },
        select: { id: true, pageId: true },
      });
      const pageByThread = new Map(threads.map((thread) => [thread.id, thread.pageId]));
      const readable = await filterReadablePageIds(threads.map((thread) => thread.pageId));
      return rows.filter((row) => {
        const pageId = pageByThread.get(row.threadId);
        return pageId !== undefined && readable.has(pageId);
      });
    }),
    filteredPagedSection('wikiEditRequests', (after) => prisma.wikiEditRequest.findMany({
      where: { createdBy: { in: profileIds }, id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, requestKind: true, pageId: true, baseRevisionId: true,
        targetNamespaceCode: true, targetSpaceId: true, targetTitle: true,
        targetSlug: true, targetDisplayTitle: true, proposedContent: true,
        editSummary: true, isMinor: true, status: true, createdBy: true,
        reviewNote: true, acceptedRevisionId: true, createdAt: true,
        updatedAt: true, reviewedAt: true, contributionPolicyVersion: true,
      },
    }), async (rows) => {
      if (!filterReadablePageIds || rows.length === 0) return rows;
      const pageIds = rows.flatMap((row) => row.pageId === null ? [] : [row.pageId]);
      const readable = await filterReadablePageIds(pageIds);
      return rows.filter((row) => row.pageId === null || readable.has(row.pageId));
    }),
    pagedSection('wikiApiTokens', (after) => prisma.wikiApiToken.findMany({
      where: { accountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, accountId: true, name: true, scopes: true, spaceId: true,
        status: true, expiresAt: true, lastUsedAt: true, revokedAt: true, createdAt: true,
      },
    })),
    pagedSection('subwikiRoles', (after) => prisma.subwikiRole.findMany({
      where: { userId: { in: profileIds }, id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: { id: true, spaceId: true, userId: true, role: true, status: true, grantedAt: true, revokedAt: true },
    })),
    pagedSection('aclMemberships', (after) => prisma.aclGroupMember.findMany({
      where: { userId: { in: profileIds }, id: { gt: afterBigInt(after) } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, groupId: true, memberType: true, userId: true,
        expiresAt: true, addedAt: true, removedAt: true,
      },
    })),
  ];
}
