import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { wikiUrl } from '@minewiki/wiki-core';
import { Prisma, type WikiDiscussionThread } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiNotificationService } from './wiki-notification.service';
import { buildServerWikiPagePath, buildServerWikiToolPath } from './wiki-read.service';
import { WikiDiscussionLiveService } from './wiki-discussion-live.service';
import { extractDiscussionMentions, uniqueDiscussionMentionUsernames } from './wiki-discussion-mention';

export interface WikiThreadSummary {
  readonly id: string;
  readonly pageId: string;
  readonly title: string;
  readonly status: string;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly commentCount: number;
  readonly preview?: WikiThreadPreview;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface WikiThreadCommentPreview {
  readonly id: string;
  readonly status: string;
  readonly contentPreview: string | null;
  readonly truncated: boolean;
  readonly createdBy: string;
  readonly createdByName: string;
  readonly createdAt: string;
}

export interface WikiThreadPreview {
  readonly firstComment: WikiThreadCommentPreview | null;
  readonly recentComments: readonly WikiThreadCommentPreview[];
  readonly omittedCommentCount: number;
}

export interface WikiThreadListResponse {
  readonly items: WikiThreadSummary[];
  readonly nextCursor: string | null;
  readonly statusCounts: WikiDiscussionStatusCounts;
  readonly statusCountsComplete: boolean;
}

export type WikiDiscussionStatus = 'open' | 'paused' | 'closed';
export type WikiDiscussionStatusFilter = 'all' | 'active' | WikiDiscussionStatus;
export type WikiDiscussionSystemEventType = 'status_change' | 'topic_change' | 'page_move' | 'pin_change';

export interface WikiDiscussionStatusCounts {
  readonly total: number;
  readonly open: number;
  readonly paused: number;
  readonly closed: number;
}

export interface WikiRecentThreadSummary extends WikiThreadSummary {
  readonly pageTitle: string;
  readonly namespace: string;
  readonly routePath: string;
  readonly discussionHref: string;
}

export interface WikiRecentThreadListResponse {
  readonly items: WikiRecentThreadSummary[];
  readonly nextCursor: string | null;
}

export interface WikiThreadDetail extends WikiThreadSummary {
  readonly canModerate: boolean;
  readonly canManagePage: boolean;
  readonly canManageAcl: boolean;
  readonly canReply: boolean;
  readonly subscribed: boolean;
  readonly pinnedCommentId: string | null;
  readonly olderCommentCursor: string | null;
  readonly newerCommentCursor: string | null;
  readonly moderationHistoryTruncated: boolean;
  /** @deprecated Use olderCommentCursor. */
  readonly nextCommentCursor: string | null;
  readonly comments: ReadonlyArray<{
    readonly id: string;
    readonly entryType: 'comment' | 'system';
    readonly systemEvent: {
      readonly type: WikiDiscussionSystemEventType;
      readonly before: string | null;
      readonly after: string | null;
      readonly beforeRedacted: boolean;
      readonly afterRedacted: boolean;
    } | null;
    readonly content: string | null;
    readonly status: string;
    readonly createdBy: string;
    readonly createdByName: string;
    readonly createdByUsername: string | null;
    readonly mentions: ReadonlyArray<{
      readonly username: string;
      readonly profileId: string;
      readonly start: number;
      readonly end: number;
    }>;
    readonly createdAt: string;
    readonly canDelete: boolean;
    readonly canChangeVisibility: boolean;
    readonly pinned: boolean;
    readonly poll: WikiDiscussionPollDetail | null;
    readonly moderationHistory: ReadonlyArray<{
      readonly id: string;
      readonly action: 'hide' | 'restore';
      readonly reason: string;
      readonly actorProfileId: string;
      readonly actorProfileName: string;
      readonly createdAt: string;
    }>;
  }>;
}

export type WikiDiscussionPollResultsVisibility = 'always' | 'after_vote' | 'closed';

export interface WikiDiscussionPollInput {
  readonly question?: string;
  readonly options?: readonly string[];
  readonly resultsVisibility?: WikiDiscussionPollResultsVisibility;
  readonly closesAt?: string | null;
}

export interface WikiDiscussionPollDetail {
  readonly id: string;
  readonly question: string;
  readonly status: 'open' | 'closed';
  readonly resultsVisibility: WikiDiscussionPollResultsVisibility;
  readonly closesAt: string | null;
  readonly closedAt: string | null;
  readonly totalVoteCount: number | null;
  readonly selectedOptionId: string | null;
  readonly resultsVisible: boolean;
  readonly privilegedResults: boolean;
  readonly canVote: boolean;
  readonly canClose: boolean;
  readonly options: ReadonlyArray<{
    readonly id: string;
    readonly label: string;
    readonly position: number;
    readonly voteCount: number | null;
  }>;
}

type WikiDiscussionViewer = string | SessionPayload | null | undefined;

interface ThreadPreviewRow {
  readonly id: bigint;
  readonly threadId: bigint;
  readonly contentPreview: string;
  readonly contentLength: bigint | number;
  readonly status: string;
  readonly createdBy: bigint;
  readonly createdAt: Date;
  readonly firstRank: bigint | number;
  readonly recentRank: bigint | number;
  readonly commentCount: bigint | number;
}

const THREAD_PAGE_CANDIDATE_BATCH_SIZE = 50;
const MAX_THREAD_PAGE_CANDIDATE_SCAN = 250;
const MAX_STATUS_COUNT_SCAN = 1_000;

@Injectable()
export class WikiDiscussionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly notifications?: WikiNotificationService,
    @Optional() private readonly live?: WikiDiscussionLiveService
  ) {
    // Keep isolated service tests and rolling deployments compatible with the
    // pre-thread-ACL permission surface. The concrete WikiPermissionService
    // always provides these methods in this release.
    const permissionSurface = this.wikiPermissions as unknown as {
      assertCanReadThread?: WikiPermissionService['assertCanReadThread'];
      filterReadableThreads?: WikiPermissionService['filterReadableThreads'];
      canManageThreadAcl?: WikiPermissionService['canManageThreadAcl'];
      canModeratePage?: WikiPermissionService['canModeratePage'];
    };
    permissionSurface.assertCanReadThread ??= async ({ accountId, page }) => {
      if (typeof (this.wikiPermissions as Partial<WikiPermissionService>).assertCanReadPage === 'function') {
        await this.wikiPermissions.assertCanReadPage({ accountId, page });
      }
    };
    permissionSurface.filterReadableThreads ??= async ({ items }) => [...items];
    permissionSurface.canModeratePage ??= (input) => this.wikiPermissions.canManagePage(input);
    permissionSurface.canManageThreadAcl ??= async ({ actor, page }) => ({
      allowed: await this.wikiPermissions.canManagePage({ actor, page }), reason: 'legacy_page_manager'
    });
  }

  async listThreads(pageId: string, viewer?: WikiDiscussionViewer): Promise<WikiThreadSummary[]> {
    const accountId = this.viewerAccountId(viewer);
    const page = await this.readablePage(pageId, accountId);
    const candidates = await this.prisma.wikiDiscussionThread.findMany({
      where: { pageId: page.id, status: { not: 'deleted' } },
      orderBy: [{ updatedAt: 'desc' }],
      take: 100
    });
    const actor = await this.viewerActor(viewer);
    const visible = await this.wikiPermissions.filterReadableThreads({
      accountId,
      actor,
      items: candidates.map((thread) => ({ thread, page }))
    });
    const threads = visible.map((item) => item.thread);
    const profileById = await this.profileNames(threads.map((thread) => thread.createdBy));
    const countRows = threads.length > 0
      ? await this.prisma.wikiDiscussionComment.groupBy({
          by: ['threadId'],
          where: { threadId: { in: threads.map((thread) => thread.id) }, entryType: 'comment' },
          _count: { _all: true }
        })
      : [];
    const countByThreadId = new Map(countRows.map((row) => [row.threadId, row._count._all]));
    return threads.map((thread) => this.toThreadSummary(thread, profileById, countByThreadId.get(thread.id) ?? 0));
  }

  async listThreadsPage(
    pageId: string,
    viewer?: WikiDiscussionViewer,
    cursor?: string,
    requestedLimit = 30,
    statusFilter: WikiDiscussionStatusFilter = 'all',
    includePreview = false
  ): Promise<WikiThreadListResponse> {
    const accountId = this.viewerAccountId(viewer);
    const page = await this.readablePage(pageId, accountId);
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const decoded = cursor ? this.decodeRecentCursor(cursor) : null;
    const snapshotAt = decoded?.snapshotAt ?? new Date();
    const status = statusFilter === 'all'
      ? { not: 'deleted' as const }
      : statusFilter === 'active'
        ? { in: ['open', 'paused'] }
        : statusFilter;
    const candidateWhere = (position: { readonly updatedAt: Date; readonly id: bigint } | null): Prisma.WikiDiscussionThreadWhereInput => ({
      pageId: page.id,
      status,
      updatedAt: { lte: snapshotAt },
      ...(position ? {
        OR: [
          { updatedAt: { lt: position.updatedAt } },
          { updatedAt: position.updatedAt, id: { lt: position.id } }
        ]
      } : {})
    });
    const actor = await this.viewerActor(viewer);
    const visibleThreads: WikiDiscussionThread[] = [];
    let scanPosition = decoded ? { updatedAt: decoded.updatedAt, id: decoded.id } : null;
    let lastScanned: WikiDiscussionThread | undefined;
    let scannedCandidateCount = 0;
    let candidatesExhausted = false;
    while (visibleThreads.length <= limit && scannedCandidateCount < MAX_THREAD_PAGE_CANDIDATE_SCAN) {
      const take = Math.min(
        THREAD_PAGE_CANDIDATE_BATCH_SIZE,
        MAX_THREAD_PAGE_CANDIDATE_SCAN - scannedCandidateCount
      );
      const candidateRows = await this.prisma.wikiDiscussionThread.findMany({
        where: candidateWhere(scanPosition),
        orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
        take
      });
      const candidates = candidateRows.slice(0, take);
      if (candidates.length === 0) {
        candidatesExhausted = true;
        break;
      }
      scannedCandidateCount += candidates.length;
      lastScanned = candidates.at(-1);
      scanPosition = lastScanned
        ? { updatedAt: lastScanned.updatedAt, id: lastScanned.id }
        : scanPosition;
      const visibleRows = await this.wikiPermissions.filterReadableThreads({
        accountId,
        actor,
        items: candidates.map((thread) => ({ thread, page }))
      });
      visibleThreads.push(...visibleRows.map((item) => item.thread));
      if (candidates.length < take) {
        candidatesExhausted = true;
        break;
      }
    }
    const hasUnscannedCandidates = visibleThreads.length <= limit && !candidatesExhausted && lastScanned
      ? (await this.prisma.wikiDiscussionThread.findMany({
          where: candidateWhere({ updatedAt: lastScanned.updatedAt, id: lastScanned.id }),
          orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
          take: 1
        })).length > 0
      : false;
    const pageThreads = visibleThreads.slice(0, limit);
    const hasMore = visibleThreads.length > limit || hasUnscannedCandidates;
    const canViewHidden = includePreview && Boolean(actor && await this.wikiPermissions.canModeratePage({ actor, page }));
    const previewData = includePreview
      ? await this.loadThreadPreviews(pageThreads.map((thread) => thread.id))
      : null;
    const countRows = !previewData && pageThreads.length > 0
      ? await this.prisma.wikiDiscussionComment.groupBy({
          by: ['threadId'],
          where: { threadId: { in: pageThreads.map((thread) => thread.id) }, entryType: 'comment' },
          _count: { _all: true }
        })
      : [];
    const countByThreadId = previewData?.countByThreadId
      ?? new Map(countRows.map((row) => [row.threadId, row._count._all]));
    const previewProfileIds = previewData
      ? [...previewData.rowsByThreadId.values()].flat().map((row) => row.createdBy)
      : [];
    const profileById = await this.profileNames([
      ...pageThreads.map((thread) => thread.createdBy),
      ...previewProfileIds
    ]);
    const last = visibleThreads.length > limit
      ? pageThreads.at(-1)
      : hasUnscannedCandidates
        ? lastScanned
        : undefined;
    const statusCandidates = await this.prisma.wikiDiscussionThread.findMany({
      where: {
        pageId: page.id,
        status: { not: 'deleted' },
        updatedAt: { lte: snapshotAt }
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: MAX_STATUS_COUNT_SCAN + 1,
      select: { id: true, pageId: true, status: true }
    });
    const countWindow = statusCandidates.slice(0, MAX_STATUS_COUNT_SCAN);
    const visibleCountRows = await this.wikiPermissions.filterReadableThreads({
      accountId,
      actor,
      items: countWindow.map((thread) => ({ thread, page }))
    });
    const statusCount = new Map<string, number>();
    for (const { thread } of visibleCountRows) {
      statusCount.set(thread.status, (statusCount.get(thread.status) ?? 0) + 1);
    }
    const total = ['open', 'paused', 'closed'].reduce((sum, value) => sum + (statusCount.get(value) ?? 0), 0);
    return {
      items: pageThreads.map((thread) => this.toThreadSummary(
        thread,
        profileById,
        countByThreadId.get(thread.id) ?? 0,
        previewData ? this.toThreadPreview(
          previewData.rowsByThreadId.get(thread.id) ?? [],
          countByThreadId.get(thread.id) ?? 0,
          profileById,
          canViewHidden
        ) : undefined
      )),
      nextCursor: hasMore && last ? this.encodeRecentCursor(snapshotAt, last.updatedAt, last.id) : null,
      statusCounts: {
        total,
        open: statusCount.get('open') ?? 0,
        paused: statusCount.get('paused') ?? 0,
        closed: statusCount.get('closed') ?? 0
      },
      statusCountsComplete: statusCandidates.length <= MAX_STATUS_COUNT_SCAN
    };
  }

  async getPageDiscussionPermissions(pageId: string, session?: SessionPayload | null): Promise<{ readonly canCreateThread: boolean }> {
    const page = await this.readablePage(pageId, session?.userId ?? null);
    let canCreateThread = false;
    if (session) {
      const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
      try {
        await this.wikiPermissions.assertCanCreateThread({
          actor: this.wikiPermissions.actorFromSession(session, profile),
          page
        });
        canCreateThread = true;
      } catch {
        canCreateThread = false;
      }
    }
    return { canCreateThread };
  }

  async listRecent(
    viewer: WikiDiscussionViewer,
    cursor?: string,
    requestedLimit = 30
  ): Promise<WikiRecentThreadListResponse> {
    const accountId = this.viewerAccountId(viewer);
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const decoded = cursor ? this.decodeRecentCursor(cursor) : null;
    const snapshotAt = decoded?.snapshotAt ?? new Date();
    const position = decoded ? { updatedAt: decoded.updatedAt, id: decoded.id } : null;
    const where: Prisma.WikiDiscussionThreadWhereInput = {
      status: { not: 'deleted' },
      updatedAt: { lte: snapshotAt },
      ...(position ? {
        OR: [
          { updatedAt: { lt: position.updatedAt } },
          { updatedAt: position.updatedAt, id: { lt: position.id } }
        ]
      } : {})
    };
    const take = Math.min(limit * 5 + 1, 251);
    const threads = await this.prisma.wikiDiscussionThread.findMany({
      where,
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take
    });
    if (threads.length === 0) return { items: [], nextCursor: null };
    const pages = await this.prisma.wikiPage.findMany({ where: { id: { in: [...new Set(threads.map((thread) => thread.pageId))] } } });
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const namespaces = await this.prisma.wikiNamespace.findMany({
      where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } },
      select: { id: true, code: true }
    });
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const serverSpaces = [...new Set(pages.filter((page) => namespaceById.get(page.namespaceId) === 'server').map((page) => page.spaceId))];
    const serverWikis = serverSpaces.length > 0
      ? await this.prisma.serverWiki.findMany({ where: { spaceId: { in: serverSpaces } }, select: { spaceId: true, slug: true } })
      : [];
    const serverSlugBySpace = new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki.slug]));
    const actor = await this.viewerActor(viewer);
    const visibleThreads = await this.wikiPermissions.filterReadableThreads({
      accountId,
      actor,
      items: threads.flatMap((thread) => {
        const page = pageById.get(thread.pageId);
        return page && page.status !== 'deleted' ? [{ thread, page }] : [];
      })
    });
    const pageRows = visibleThreads.slice(0, limit);
    const profileById = await this.profileNames(pageRows.map(({ thread }) => thread.createdBy));
    const countRows = pageRows.length > 0
      ? await this.prisma.wikiDiscussionComment.groupBy({
          by: ['threadId'],
          where: { threadId: { in: pageRows.map(({ thread }) => thread.id) }, entryType: 'comment' },
          _count: { _all: true }
        })
      : [];
    const countByThreadId = new Map(countRows.map((row) => [row.threadId, row._count._all]));
    const items = pageRows.map(({ thread, page }) => {
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const serverSlug = serverSlugBySpace.get(page.spaceId);
      const routePath = namespace === 'server' && serverSlug
        ? buildServerWikiPagePath(serverSlug, page.localPath)
        : wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title);
      return {
        ...this.toThreadSummary(thread, profileById, countByThreadId.get(thread.id) ?? 0),
        pageTitle: page.displayTitle,
        namespace,
        routePath,
        discussionHref: namespace === 'server' && serverSlug
          ? `${buildServerWikiToolPath(serverSlug, page.localPath, 'discuss')}?thread=${thread.id.toString()}`
          : `/wiki/discuss/${page.id.toString()}?returnTo=${encodeURIComponent(routePath)}&thread=${thread.id.toString()}`
      };
    });
    const cursorRow = pageRows.at(-1)?.thread ?? threads.at(-1);
    const hasMore = visibleThreads.length > limit || threads.length === take;
    return {
      items,
      nextCursor: hasMore && cursorRow ? this.encodeRecentCursor(snapshotAt, cursorRow.updatedAt, cursorRow.id) : null
    };
  }

  async getThread(
    threadId: string,
    session?: SessionPayload | null,
    commentCursor?: string,
    requestedLimit = 100,
    focusCommentId?: string,
    commentDirection: 'older' | 'newer' = 'older'
  ): Promise<WikiThreadDetail> {
    const id = this.parseId(threadId, 'threadId');
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.readablePage(thread.pageId.toString(), session?.userId ?? null);
    const viewerActor = await this.viewerActor(session);
    await this.wikiPermissions.assertCanReadThread({
      accountId: session?.userId ?? null,
      actor: viewerActor,
      thread,
      page
    });
    const commentLimit = Math.min(Math.max(requestedLimit, 1), 200);
    const cursorId = commentCursor ? this.parseId(commentCursor, 'commentCursor') : null;
    const focusId = focusCommentId ? this.parseId(focusCommentId, 'focusCommentId') : null;
    if (commentDirection !== 'older' && commentDirection !== 'newer') {
      throw new BadRequestException('commentDirection must be older or newer.');
    }
    if (cursorId && focusId) throw new BadRequestException('commentCursor and focusCommentId cannot be combined.');
    if (focusId) {
      const focused = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: focusId }, select: { threadId: true } });
      if (!focused || focused.threadId !== thread.id) throw new NotFoundException('Wiki discussion comment not found.');
    }
    let pageComments: Awaited<ReturnType<typeof this.prisma.wikiDiscussionComment.findMany>>;
    let olderCommentCursor: string | null = null;
    let newerCommentCursor: string | null = null;
    if (focusId) {
      const olderWindowSize = Math.ceil(commentLimit / 2);
      const newerWindowSize = Math.floor(commentLimit / 2);
      const [olderRows, newerRows] = await Promise.all([
        this.prisma.wikiDiscussionComment.findMany({
          where: { threadId: thread.id, id: { lte: focusId } },
          orderBy: [{ id: 'desc' }],
          take: olderWindowSize + 1
        }),
        this.prisma.wikiDiscussionComment.findMany({
          where: { threadId: thread.id, id: { gt: focusId } },
          orderBy: [{ id: 'asc' }],
          take: newerWindowSize + 1
        })
      ]);
      const olderPage = olderRows.slice(0, olderWindowSize);
      const newerPage = newerRows.slice(0, newerWindowSize);
      pageComments = [...olderPage, ...newerPage];
      olderCommentCursor = olderRows.length > olderWindowSize
        ? olderPage.at(-1)?.id.toString() ?? null
        : null;
      newerCommentCursor = newerRows.length > newerWindowSize
        ? (newerPage.at(-1)?.id ?? focusId).toString()
        : null;
    } else {
      const loadNewer = Boolean(cursorId && commentDirection === 'newer');
      const comments = await this.prisma.wikiDiscussionComment.findMany({
        where: {
          threadId: thread.id,
          ...(cursorId ? { id: loadNewer ? { gt: cursorId } : { lt: cursorId } } : {})
        },
        orderBy: [{ id: loadNewer ? 'asc' : 'desc' }],
        take: commentLimit + 1
      });
      const hasMoreComments = comments.length > commentLimit;
      pageComments = comments.slice(0, commentLimit);
      if (hasMoreComments) {
        const continuation = pageComments.at(-1)?.id.toString() ?? null;
        if (loadNewer) newerCommentCursor = continuation;
        else olderCommentCursor = continuation;
      }
    }
    const pinnedComment = thread.pinnedCommentId && !pageComments.some((comment) => comment.id === thread.pinnedCommentId)
      ? await this.prisma.wikiDiscussionComment.findUnique({ where: { id: thread.pinnedCommentId } })
      : null;
    const displayComments = pinnedComment && pinnedComment.threadId === thread.id ? [...pageComments, pinnedComment] : pageComments;
    const commentCount = await this.prisma.wikiDiscussionComment.count({ where: { threadId: thread.id, entryType: 'comment' } });
    const authorIds = [...new Set([thread.createdBy, ...displayComments.map((comment) => comment.createdBy)])];
    const mentionOccurrencesByComment = new Map(displayComments.map((comment) => [
      comment.id,
      comment.entryType === 'system' || comment.status === 'deleted' ? [] : extractDiscussionMentions(comment.content)
    ]));
    const mentionUsernames = [...new Set([...mentionOccurrencesByComment.values()].flat().map((mention) => mention.username))];
    const identityRows = await this.prisma.wikiProfile.findMany({
      where: {
        OR: [
          { id: { in: authorIds } },
          ...(mentionUsernames.length > 0 ? [{ username: { in: mentionUsernames }, status: 'active' }] : [])
        ]
      },
      select: { id: true, username: true, displayName: true, status: true }
    });
    const profileById = new Map(identityRows.map((profile) => [profile.id, profile.displayName]));
    const usernameByProfileId = new Map(identityRows.map((profile) => [profile.id, profile.username]));
    const mentionProfileByUsername = new Map(identityRows
      .filter((profile) => profile.status === 'active')
      .map((profile) => [profile.username.toLocaleLowerCase('en-US'), profile]));
    const viewer = session ? await this.wikiProfiles.ensureWikiProfile(session.userId) : null;
    const subscription = viewer ? await this.prisma.wikiDiscussionSubscription.findUnique({
      where: { threadId_profileId: { threadId: thread.id, profileId: viewer.id } }, select: { muted: true }
    }) : null;
    const canManage = viewer && session
      ? await this.wikiPermissions.canManagePage({ actor: this.wikiPermissions.actorFromSession(session, viewer), page })
      : false;
    const canModeratePage = viewer && session
      ? await this.wikiPermissions.canModeratePage({ actor: this.wikiPermissions.actorFromSession(session, viewer), page })
      : false;
    const canManageAcl = viewer && session
      ? (await this.wikiPermissions.canManageThreadAcl({
          actor: this.wikiPermissions.actorFromSession(session, viewer), thread, page
        })).allowed
      : false;
    let canReply = false;
    if (viewer && session && thread.status === 'open') {
      try {
        await this.wikiPermissions.assertCanWriteThreadComment({
          actor: this.wikiPermissions.actorFromSession(session, viewer),
          page,
          threadId: thread.id
        });
        canReply = true;
      } catch {
        canReply = false;
      }
    }
    const canModerate = Boolean(viewer && (thread.createdBy === viewer.id || canModeratePage));
    const moderationRows = canModeratePage && displayComments.length > 0
      ? await this.prisma.wikiDiscussionModerationEvent.findMany({
          where: {
            commentId: { in: displayComments.map((comment) => comment.id) },
            action: { in: ['hide', 'restore'] }
          },
          orderBy: [{ id: 'desc' }],
          take: 501
        })
      : [];
    const moderationHistoryTruncated = moderationRows.length > 500;
    const visibleModerationRows = moderationRows.slice(0, 500);
    const moderationActorNames = await this.profileNames(visibleModerationRows.map((event) => event.actorProfileId));
    for (const [profileId, profileName] of moderationActorNames) profileById.set(profileId, profileName);
    const moderationByCommentId = new Map<bigint, typeof visibleModerationRows>();
    for (const event of visibleModerationRows) {
      const history = moderationByCommentId.get(event.commentId) ?? [];
      history.push(event);
      moderationByCommentId.set(event.commentId, history);
    }
    const pollByCommentId = await this.hydratePolls({
      comments: displayComments.filter((comment) => comment.entryType !== 'system'),
      viewerProfileId: viewer?.id ?? null,
      canManagePage: Boolean(canModeratePage),
      canReply,
      threadStatus: thread.status
    });
    const systemEvents = await this.hydrateSystemEvents(displayComments, session?.userId ?? null);
    return {
      ...this.toThreadSummary(thread, profileById, commentCount),
      canModerate,
      canManagePage: Boolean(canManage),
      canManageAcl: Boolean(canManageAcl),
      canReply,
      subscribed: Boolean(subscription && !subscription.muted),
      pinnedCommentId: thread.pinnedCommentId?.toString() ?? null,
      olderCommentCursor,
      newerCommentCursor,
      moderationHistoryTruncated,
      nextCommentCursor: olderCommentCursor,
      comments: displayComments.sort((left, right) => {
        if (left.id === thread.pinnedCommentId) return -1;
        if (right.id === thread.pinnedCommentId) return 1;
        return left.id < right.id ? -1 : 1;
      }).map((comment) => ({
        id: comment.id.toString(),
        entryType: comment.entryType === 'system' ? 'system' as const : 'comment' as const,
        systemEvent: comment.entryType === 'system' ? systemEvents.get(comment.id) ?? null : null,
        content: comment.entryType === 'system' || comment.status === 'deleted' || (comment.status === 'hidden' && !canManage) ? null : comment.content,
        status: comment.status,
        createdBy: comment.createdBy.toString(),
        createdByName: profileById.get(comment.createdBy) ?? '알 수 없는 사용자',
        createdByUsername: usernameByProfileId.get(comment.createdBy) ?? null,
        mentions: comment.entryType === 'system' || comment.status === 'deleted' || (comment.status === 'hidden' && !canManage)
          ? []
          : (mentionOccurrencesByComment.get(comment.id) ?? []).flatMap((mention) => {
              const target = mentionProfileByUsername.get(mention.username.toLocaleLowerCase('en-US'));
              return target ? [{ username: target.username, profileId: target.id.toString(), start: mention.start, end: mention.end }] : [];
            }),
        createdAt: comment.createdAt.toISOString(),
        canDelete: Boolean(comment.entryType !== 'system' && comment.status !== 'deleted' && viewer && (comment.createdBy === viewer.id || canManage)),
        canChangeVisibility: Boolean(comment.entryType !== 'system' && canManage && comment.status !== 'deleted'),
        pinned: comment.id === thread.pinnedCommentId,
        poll: comment.status === 'deleted' || (comment.status === 'hidden' && !canManage)
          ? null
          : pollByCommentId.get(comment.id) ?? null,
        moderationHistory: (moderationByCommentId.get(comment.id) ?? []).map((event) => ({
          id: event.id.toString(),
          action: event.action === 'restore' ? 'restore' as const : 'hide' as const,
          reason: event.reason,
          actorProfileId: event.actorProfileId.toString(),
          actorProfileName: profileById.get(event.actorProfileId) ?? '알 수 없는 사용자',
          createdAt: event.createdAt.toISOString()
        }))
      }))
    };
  }

  async createThread(
    session: SessionPayload,
    pageId: string,
    input: { readonly title?: string; readonly content?: string; readonly poll?: WikiDiscussionPollInput }
  ): Promise<WikiThreadDetail> {
    const parsedPageId = this.parseId(pageId, 'pageId');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: parsedPageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    await this.wikiPermissions.assertCanCreateThread({
      actor: this.wikiPermissions.actorFromSession(session, profile),
      page
    });
    const title = this.requiredText(input.title, 'title', 255);
    const content = this.requiredText(input.content, 'content', 10_000);
    const now = new Date();
    const thread = await this.prisma.$transaction(async (tx) => {
      const created = await tx.wikiDiscussionThread.create({
        data: { pageId: page.id, title, status: 'open', createdBy: profile.id, createdAt: now, updatedAt: now }
      });
      const comment = await tx.wikiDiscussionComment.create({
        data: { threadId: created.id, content, status: 'normal', createdBy: profile.id, createdAt: now }
      });
      if (input.poll) await this.createPoll(tx, comment.id, profile.id, input.poll, now);
      await tx.wikiDiscussionSubscription.create({
        data: { threadId: created.id, profileId: profile.id, muted: false, createdAt: now, updatedAt: now }
      });
      await this.notifications?.notifyDiscussionMentions(tx, {
        pageId: page.id,
        threadId: created.id,
        commentId: comment.id,
        actorProfileId: profile.id,
        title,
        usernames: uniqueDiscussionMentionUsernames(content)
      });
      return created;
    });
    this.live?.publish(thread.id);
    await this.audit('wiki.discussion.create', session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async addComment(
    session: SessionPayload,
    threadId: string,
    input: { readonly content?: string; readonly poll?: WikiDiscussionPollInput }
  ): Promise<WikiThreadDetail> {
    const id = this.parseId(threadId, 'threadId');
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id } });
    if (!thread) throw new NotFoundException('Wiki discussion thread not found.');
    if (thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    if (thread.status !== 'open') throw new BadRequestException(this.threadWriteBlockedMessage(thread.status));
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    await this.wikiPermissions.assertCanWriteThreadComment({ actor, page, threadId: thread.id });
    const content = this.requiredText(input.content, 'content', 10_000);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      if (!currentThread || currentThread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
      if (currentThread.status !== 'open') throw new BadRequestException(this.threadWriteBlockedMessage(currentThread.status));
      const currentPage = await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } });
      await this.wikiPermissions.assertCanWriteThreadComment({ actor, page: currentPage, threadId: currentThread.id, store: tx });
      const comment = await tx.wikiDiscussionComment.create({
        data: { threadId: thread.id, content, status: 'normal', createdBy: profile.id, createdAt: now }
      });
      if (input.poll) await this.createPoll(tx, comment.id, profile.id, input.poll, now);
      await tx.wikiDiscussionSubscription.upsert({
        where: { threadId_profileId: { threadId: thread.id, profileId: profile.id } },
        create: { threadId: thread.id, profileId: profile.id, muted: false, createdAt: now, updatedAt: now },
        update: {}
      });
      await tx.wikiDiscussionThread.update({ where: { id: thread.id }, data: { updatedAt: now } });
      const mentionedProfileIds = await this.notifications?.notifyDiscussionMentions(tx, {
        pageId: page.id,
        threadId: thread.id,
        commentId: comment.id,
        actorProfileId: profile.id,
        title: thread.title,
        usernames: uniqueDiscussionMentionUsernames(content)
      }) ?? [];
      await this.notifications?.notifyDiscussionReply(tx, {
        pageId: page.id,
        threadId: thread.id,
        commentId: comment.id,
        actorProfileId: profile.id,
        title: thread.title,
        excludeProfileIds: mentionedProfileIds
      });
    });
    this.live?.publish(thread.id);
    await this.audit('wiki.discussion.comment', session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async votePoll(
    session: SessionPayload,
    threadId: string,
    pollIdInput: string,
    optionIdInput?: string
  ): Promise<WikiThreadDetail> {
    const threadIdValue = this.parseId(threadId, 'threadId');
    const pollId = this.parseId(pollIdInput, 'pollId');
    const optionId = this.parseId(optionIdInput ?? '', 'optionId');
    const poll = await this.prisma.wikiDiscussionPoll.findUnique({ where: { id: pollId } });
    if (!poll) throw new NotFoundException('Wiki discussion poll not found.');
    const comment = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: poll.commentId } });
    if (!comment || comment.threadId !== threadIdValue || comment.status !== 'normal') {
      throw new NotFoundException('Wiki discussion poll not found.');
    }
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: threadIdValue } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id, comment.id, poll.id);
      const [currentThread, currentComment, currentPoll, option] = await Promise.all([
        tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } }),
        tx.wikiDiscussionComment.findUnique({ where: { id: comment.id } }),
        tx.wikiDiscussionPoll.findUnique({ where: { id: poll.id } }),
        tx.wikiDiscussionPollOption.findFirst({ where: { id: optionId, pollId: poll.id } })
      ]);
      if (!currentThread || currentThread.status !== 'open') {
        throw new ConflictException(this.threadWriteBlockedMessage(currentThread?.status ?? 'deleted'));
      }
      const currentPage = await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } });
      await this.wikiPermissions.assertCanWriteThreadComment({ actor, page: currentPage, threadId: currentThread.id, store: tx });
      if (!currentComment || currentComment.status !== 'normal') throw new ConflictException('Wiki discussion poll is not available.');
      if (!currentPoll || currentPoll.status !== 'open' || (currentPoll.closesAt && currentPoll.closesAt <= now)) {
        throw new ConflictException('Wiki discussion poll is closed.');
      }
      if (!option) throw new BadRequestException('Poll option does not belong to this poll.');
      await tx.wikiDiscussionPollVote.upsert({
        where: { pollId_profileId: { pollId: poll.id, profileId: profile.id } },
        create: { pollId: poll.id, optionId: option.id, profileId: profile.id, createdAt: now, updatedAt: now },
        update: { optionId: option.id, updatedAt: now }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit('wiki.discussion.poll_vote', session, profile.id, page.id, thread.id, { pollId: poll.id.toString() });
    return this.getThread(thread.id.toString(), session);
  }

  async closePoll(session: SessionPayload, threadId: string, pollIdInput: string): Promise<WikiThreadDetail> {
    const threadIdValue = this.parseId(threadId, 'threadId');
    const pollId = this.parseId(pollIdInput, 'pollId');
    const poll = await this.prisma.wikiDiscussionPoll.findUnique({ where: { id: pollId } });
    if (!poll) throw new NotFoundException('Wiki discussion poll not found.');
    const comment = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: poll.commentId } });
    if (!comment || comment.threadId !== threadIdValue) throw new NotFoundException('Wiki discussion poll not found.');
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: threadIdValue } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    await this.wikiPermissions.assertCanWriteThreadComment({ actor, page, threadId: thread.id });
    if (poll.createdBy !== profile.id && !(await this.wikiPermissions.canModeratePage({ actor, page }))) {
      throw new ForbiddenException('Wiki discussion poll moderation is not allowed.');
    }
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id, comment.id, poll.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      if (!currentThread || currentThread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
      const currentPage = await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } });
      await this.wikiPermissions.assertCanWriteThreadComment({ actor, page: currentPage, threadId: currentThread.id, store: tx });
      const changed = await tx.wikiDiscussionPoll.updateMany({
        where: { id: poll.id, status: 'open' },
        data: { status: 'closed', closedAt: now, updatedAt: now }
      });
      if (changed.count !== 1) throw new ConflictException('Wiki discussion poll is already closed.');
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit('wiki.discussion.poll_close', session, profile.id, page.id, thread.id, { pollId: poll.id.toString() });
    return this.getThread(thread.id.toString(), session);
  }

  async setSubscription(session: SessionPayload, threadId: string, subscribed: boolean): Promise<{ readonly subscribed: boolean }> {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: this.parseId(threadId, 'threadId') } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.readablePage(thread.pageId.toString(), session.userId);
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      if (!currentThread || currentThread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
      const currentPage = await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } });
      await this.wikiPermissions.assertCanReadThread({
        accountId: session.userId, actor, thread: currentThread, page: currentPage, store: tx
      });
      await tx.wikiDiscussionSubscription.upsert({
        where: { threadId_profileId: { threadId: thread.id, profileId: profile.id } },
        create: { threadId: thread.id, profileId: profile.id, muted: !subscribed, createdAt: now, updatedAt: now },
        update: { muted: !subscribed, updatedAt: now }
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    return { subscribed };
  }

  async setThreadStatus(
    session: SessionPayload,
    threadId: string,
    status: WikiDiscussionStatus
  ): Promise<WikiThreadDetail> {
    const id = this.parseId(threadId, 'threadId');
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    const canManagePage = await this.wikiPermissions.canManagePage({ actor, page });
    const canModeratePage = await this.wikiPermissions.canModeratePage({ actor, page });
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      if (!currentThread || currentThread.status === 'deleted') {
        throw new NotFoundException('Wiki discussion thread not found.');
      }
      if (currentThread.pageId !== thread.pageId) throw new ConflictException('Wiki discussion was moved concurrently.');
      const requiresPageManager = status === 'paused' || currentThread.status === 'paused';
      if ((requiresPageManager && !canManagePage) || (!requiresPageManager && currentThread.createdBy !== profile.id && !canModeratePage)) {
        throw new ForbiddenException('Wiki discussion moderation is not allowed.');
      }
      if (currentThread.status === status) throw new ConflictException(`Wiki discussion thread is already ${status}.`);
      const now = new Date();
      await tx.wikiDiscussionThread.update({ where: { id }, data: { status, updatedAt: now } });
      await this.createSystemEntry(tx, {
        threadId: id, actorProfileId: profile.id, type: 'status_change',
        before: currentThread.status, after: status, now
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit(`wiki.discussion.${status}`, session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async updateThreadTopic(session: SessionPayload, threadId: string, titleInput?: string): Promise<WikiThreadDetail> {
    const thread = await this.moderatableThread(session, threadId);
    const title = this.requiredText(titleInput, 'title', 255);
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id);
      const current = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      if (!current || current.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
      if (current.pageId !== thread.pageId) throw new ConflictException('Wiki discussion was moved concurrently.');
      if (current.title === title) throw new ConflictException('Wiki discussion topic already has that title.');
      const now = new Date();
      await tx.wikiDiscussionThread.update({ where: { id: thread.id }, data: { title, updatedAt: now } });
      await this.createSystemEntry(tx, {
        threadId: thread.id, actorProfileId: thread.profileId, type: 'topic_change',
        before: current.title, after: title, now
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit('wiki.discussion.topic', session, thread.profileId, thread.pageId, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async moveThread(
    session: SessionPayload,
    threadId: string,
    targetPageIdInput?: string,
    reasonInput?: string
  ): Promise<WikiThreadDetail> {
    const thread = await this.managedThread(session, threadId);
    const targetPageId = this.parseId(targetPageIdInput ?? '', 'pageId');
    if (targetPageId === thread.pageId) throw new BadRequestException('Discussion is already attached to that page.');
    const targetPage = await this.prisma.wikiPage.findUnique({ where: { id: targetPageId } });
    if (!targetPage || targetPage.status === 'deleted') throw new NotFoundException('Target wiki page not found.');
    const targetAllowed = await this.wikiPermissions.canManagePage({ actor: thread.actor, page: targetPage });
    if (!targetAllowed) throw new ForbiddenException('Target wiki page management is not allowed.');
    const reason = this.optionalReason(reasonInput);
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id);
      const current = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      if (!current || current.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
      if (current.pageId !== thread.pageId) throw new ConflictException('Wiki discussion was moved concurrently.');
      const now = new Date();
      await tx.wikiDiscussionThread.update({ where: { id: thread.id }, data: { pageId: targetPage.id, updatedAt: now } });
      await this.createSystemEntry(tx, {
        threadId: thread.id, actorProfileId: thread.profileId, type: 'page_move',
        before: current.pageId.toString(), after: targetPage.id.toString(), now
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit('wiki.discussion.move', session, thread.profileId, thread.pageId, thread.id, {
      targetPageId: targetPage.id.toString(), reason
    });
    return this.getThread(thread.id.toString(), session);
  }

  async deleteThread(
    session: SessionPayload,
    threadId: string,
    reasonInput?: string
  ): Promise<{ readonly deleted: true; readonly threadId: string }> {
    const thread = await this.managedThread(session, threadId);
    const reason = this.optionalReason(reasonInput);
    await this.prisma.wikiDiscussionThread.update({
      where: { id: thread.id },
      data: { status: 'deleted', pinnedCommentId: null, updatedAt: new Date() }
    });
    this.live?.publish(thread.id);
    await this.audit('wiki.discussion.delete', session, thread.profileId, thread.pageId, thread.id, { reason });
    return { deleted: true, threadId: thread.id.toString() };
  }

  async getCommentRaw(threadId: string, commentId: string, session?: SessionPayload | null): Promise<string> {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: this.parseId(threadId, 'threadId') } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.readablePage(thread.pageId.toString(), session?.userId ?? null);
    await this.wikiPermissions.assertCanReadThread({
      accountId: session?.userId ?? null,
      actor: await this.viewerActor(session),
      thread,
      page
    });
    const comment = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: this.parseId(commentId, 'commentId') } });
    if (!comment || comment.threadId !== thread.id || comment.entryType === 'system' || !['normal', 'hidden'].includes(comment.status)) {
      throw new NotFoundException('Wiki discussion comment not found.');
    }
    if (comment.status === 'hidden') {
      if (!session) throw new NotFoundException('Wiki discussion comment not found.');
      const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
      const actor = this.wikiPermissions.actorFromSession(session, profile);
      if (!(await this.wikiPermissions.canModeratePage({ actor, page }))) {
        throw new NotFoundException('Wiki discussion comment not found.');
      }
    }
    return comment.content;
  }

  async setPinnedComment(session: SessionPayload, threadId: string, commentId: string | null): Promise<WikiThreadDetail> {
    const thread = await this.moderatableThread(session, threadId);
    const parsedCommentId = commentId ? this.parseId(commentId, 'commentId') : null;
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id, parsedCommentId ?? undefined);
      const current = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      if (!current || current.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
      if (current.pageId !== thread.pageId) throw new ConflictException('Wiki discussion was moved concurrently.');
      if (parsedCommentId) {
        const comment = await tx.wikiDiscussionComment.findUnique({ where: { id: parsedCommentId } });
        if (!comment || comment.threadId !== thread.id || comment.entryType === 'system' || comment.status !== 'normal') {
          throw new NotFoundException('Wiki discussion comment not found.');
        }
      }
      if (current.pinnedCommentId === parsedCommentId) throw new ConflictException('Wiki discussion pin is already in that state.');
      const now = new Date();
      await tx.wikiDiscussionThread.update({ where: { id: thread.id }, data: { pinnedCommentId: parsedCommentId, updatedAt: now } });
      await this.createSystemEntry(tx, {
        threadId: thread.id, actorProfileId: thread.profileId, type: 'pin_change',
        before: current.pinnedCommentId?.toString() ?? null, after: parsedCommentId?.toString() ?? null, now
      });
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit(parsedCommentId ? 'wiki.discussion.pin' : 'wiki.discussion.unpin', session, thread.profileId, thread.pageId, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async deleteComment(session: SessionPayload, threadId: string, commentId: string): Promise<WikiThreadDetail> {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: this.parseId(threadId, 'threadId') } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const comment = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: this.parseId(commentId, 'commentId') } });
    if (!comment || comment.threadId !== thread.id || comment.entryType === 'system') throw new NotFoundException('Wiki discussion comment not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    const canModeratePage = await this.wikiPermissions.canModeratePage({ actor, page });
    if ((comment.status === 'hidden' || comment.createdBy !== profile.id) && !canModeratePage) {
      throw new ForbiddenException('Wiki discussion comment deletion is not allowed.');
    }
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id, comment.id);
      const [currentThread, currentComment] = await Promise.all([
        tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } }),
        tx.wikiDiscussionComment.findUnique({ where: { id: comment.id } })
      ]);
      if (!currentThread || currentThread.status === 'deleted' || !currentComment || currentComment.entryType === 'system' || currentComment.status === 'deleted') {
        throw new NotFoundException('Wiki discussion comment not found.');
      }
      if (currentThread.pageId !== thread.pageId) throw new ConflictException('Wiki discussion was moved concurrently.');
      if (currentComment.status === 'hidden' && !canModeratePage) {
        throw new ForbiddenException('Wiki discussion comment deletion is not allowed.');
      }
      const now = new Date();
      await tx.wikiDiscussionComment.update({ where: { id: comment.id }, data: { status: 'deleted', content: '', updatedAt: now } });
      if (currentThread.pinnedCommentId === comment.id) {
        await tx.wikiDiscussionThread.update({ where: { id: thread.id }, data: { pinnedCommentId: null, updatedAt: now } });
        await this.createSystemEntry(tx, {
          threadId: thread.id, actorProfileId: profile.id, type: 'pin_change',
          before: comment.id.toString(), after: null, now
        });
      }
    }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    this.live?.publish(thread.id);
    await this.audit('wiki.discussion.comment_delete', session, profile.id, page.id, thread.id);
    return this.getThread(thread.id.toString(), session);
  }

  async setCommentVisibility(
    session: SessionPayload,
    threadId: string,
    commentId: string,
    status: 'normal' | 'hidden',
    reasonInput?: string
  ): Promise<WikiThreadDetail> {
    const thread = await this.reviewableThread(session, threadId);
    const commentIdValue = this.parseId(commentId, 'commentId');
    const comment = await this.prisma.wikiDiscussionComment.findUnique({ where: { id: commentIdValue } });
    if (!comment || comment.threadId !== thread.id || comment.entryType === 'system' || comment.status === 'deleted') {
      throw new NotFoundException('Wiki discussion comment not found.');
    }
    if (comment.status === status) throw new ConflictException(`Wiki discussion comment is already ${status}.`);
    if (!['normal', 'hidden'].includes(comment.status)) throw new BadRequestException('Wiki discussion comment status cannot be changed.');
    const reason = this.requiredText(reasonInput, 'reason', 1000);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id, comment.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      const currentComment = await tx.wikiDiscussionComment.findUnique({ where: { id: comment.id } });
      if (!currentThread || currentThread.status === 'deleted' || !currentComment || currentComment.entryType === 'system' || currentComment.status === 'deleted') {
        throw new NotFoundException('Wiki discussion comment not found.');
      }
      if (currentThread.pageId !== thread.pageId) throw new ConflictException('Wiki discussion was moved concurrently.');
      if (currentComment.status === status) throw new ConflictException(`Wiki discussion comment is already ${status}.`);
      await tx.wikiDiscussionComment.update({
        where: { id: comment.id },
        data: { status, updatedAt: now }
      });
      if (status === 'hidden' && currentThread.pinnedCommentId === comment.id) {
        await tx.wikiDiscussionThread.update({
          where: { id: thread.id },
          data: { pinnedCommentId: null, updatedAt: now }
        });
        await this.createSystemEntry(tx, {
          threadId: thread.id, actorProfileId: thread.profileId, type: 'pin_change',
          before: comment.id.toString(), after: null, now
        });
      }
      await tx.wikiDiscussionModerationEvent.create({
        data: {
          threadId: thread.id,
          commentId: comment.id,
          actorProfileId: thread.profileId,
          action: status === 'hidden' ? 'hide' : 'restore',
          reason,
          createdAt: now
        }
      });
    });
    this.live?.publish(thread.id);
    await this.audit(`wiki.discussion.comment_${status === 'hidden' ? 'hide' : 'restore'}`, session, thread.profileId, thread.pageId, thread.id, {
      commentId: comment.id.toString(), reason
    });
    return this.getThread(thread.id.toString(), session);
  }

  private async readablePage(pageId: string, accountId: string | null) {
    const page = await this.prisma.wikiPage.findUnique({ where: { id: this.parseId(pageId, 'pageId') } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    await this.wikiPermissions.assertCanReadPage({ accountId, page });
    return page;
  }

  private async moderatableThread(session: SessionPayload, threadId: string) {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: this.parseId(threadId, 'threadId') } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    if (thread.createdBy !== profile.id && !(await this.wikiPermissions.canModeratePage({ actor, page }))) {
      throw new ForbiddenException('Wiki discussion moderation is not allowed.');
    }
    return { ...thread, profileId: profile.id };
  }

  private async managedThread(session: SessionPayload, threadId: string) {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: this.parseId(threadId, 'threadId') } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    if (!(await this.wikiPermissions.canManagePage({ actor, page }))) {
      throw new ForbiddenException('Wiki discussion administration is not allowed.');
    }
    return { ...thread, profileId: profile.id, actor };
  }

  private async reviewableThread(session: SessionPayload, threadId: string) {
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id: this.parseId(threadId, 'threadId') } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: thread.pageId } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    if (!(await this.wikiPermissions.canModeratePage({ actor, page }))) {
      throw new ForbiddenException('Wiki discussion moderation is not allowed.');
    }
    return { ...thread, profileId: profile.id };
  }

  private async createPoll(
    tx: Prisma.TransactionClient,
    commentId: bigint,
    profileId: bigint,
    input: WikiDiscussionPollInput,
    now: Date
  ): Promise<void> {
    const question = this.requiredText(input.question, 'poll.question', 255);
    if (!Array.isArray(input.options) || input.options.length < 2 || input.options.length > 10) {
      throw new BadRequestException('poll.options must contain between 2 and 10 choices.');
    }
    const options = input.options.map((option, index) => this.requiredText(option, `poll.options[${index}]`, 120));
    const normalized = options.map((option) => option.normalize('NFKC').replace(/\s+/gu, ' ').toLocaleLowerCase('ko-KR'));
    if (new Set(normalized).size !== options.length) throw new BadRequestException('poll.options must be unique.');
    const resultsVisibility = input.resultsVisibility ?? 'after_vote';
    if (!['always', 'after_vote', 'closed'].includes(resultsVisibility)) {
      throw new BadRequestException('poll.resultsVisibility is invalid.');
    }
    let closesAt: Date | null = null;
    if (input.closesAt) {
      if (typeof input.closesAt !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(input.closesAt)) {
        throw new BadRequestException('poll.closesAt must be an ISO timestamp.');
      }
      closesAt = new Date(input.closesAt);
      if (Number.isNaN(closesAt.getTime())) throw new BadRequestException('poll.closesAt must be an ISO timestamp.');
      const minimum = now.getTime() + 5 * 60 * 1000;
      const maximum = now.getTime() + 90 * 24 * 60 * 60 * 1000;
      if (closesAt.getTime() < minimum || closesAt.getTime() > maximum) {
        throw new BadRequestException('poll.closesAt must be between 5 minutes and 90 days from now.');
      }
    }
    const poll = await tx.wikiDiscussionPoll.create({
      data: {
        commentId,
        question,
        status: 'open',
        resultsVisibility,
        createdBy: profileId,
        closesAt,
        createdAt: now,
        updatedAt: now
      }
    });
    await tx.wikiDiscussionPollOption.createMany({
      data: options.map((label, position) => ({ pollId: poll.id, position, label }))
    });
  }

  private async hydratePolls(input: {
    readonly comments: ReadonlyArray<{ readonly id: bigint; readonly status: string }>;
    readonly viewerProfileId: bigint | null;
    readonly canManagePage: boolean;
    readonly canReply: boolean;
    readonly threadStatus: string;
  }): Promise<Map<bigint, WikiDiscussionPollDetail>> {
    const pollDelegate = (this.prisma as unknown as { wikiDiscussionPoll?: unknown }).wikiDiscussionPoll;
    if (!pollDelegate || input.comments.length === 0) return new Map();
    const commentIds = [...new Set(input.comments.map((comment) => comment.id))];
    const polls = await this.prisma.wikiDiscussionPoll.findMany({ where: { commentId: { in: commentIds } } });
    if (polls.length === 0) return new Map();
    const pollIds = polls.map((poll) => poll.id);
    const [options, countRows, viewerVotes] = await Promise.all([
      this.prisma.wikiDiscussionPollOption.findMany({
        where: { pollId: { in: pollIds } },
        orderBy: [{ pollId: 'asc' }, { position: 'asc' }, { id: 'asc' }]
      }),
      this.prisma.wikiDiscussionPollVote.groupBy({
        by: ['pollId', 'optionId'],
        where: { pollId: { in: pollIds } },
        _count: { _all: true }
      }),
      input.viewerProfileId
        ? this.prisma.wikiDiscussionPollVote.findMany({
            where: { pollId: { in: pollIds }, profileId: input.viewerProfileId },
            select: { pollId: true, optionId: true }
          })
        : Promise.resolve([])
    ]);
    const optionsByPoll = new Map<bigint, typeof options>();
    for (const option of options) {
      const bucket = optionsByPoll.get(option.pollId) ?? [];
      bucket.push(option);
      optionsByPoll.set(option.pollId, bucket);
    }
    const countByOption = new Map(countRows.map((row) => [row.optionId, row._count._all]));
    const viewerOptionByPoll = new Map(viewerVotes.map((vote) => [vote.pollId, vote.optionId]));
    const now = new Date();
    return new Map(polls.map((poll) => {
      const expired = Boolean(poll.closesAt && poll.closesAt <= now);
      const status: 'open' | 'closed' = poll.status === 'open' && !expired ? 'open' : 'closed';
      const visibility: WikiDiscussionPollResultsVisibility = ['always', 'after_vote', 'closed'].includes(poll.resultsVisibility)
        ? poll.resultsVisibility as WikiDiscussionPollResultsVisibility
        : 'after_vote';
      const selectedOptionId = viewerOptionByPoll.get(poll.id) ?? null;
      const normallyVisible = status === 'closed' || visibility === 'always'
        || (visibility === 'after_vote' && selectedOptionId !== null);
      const resultsVisible = input.canManagePage || normallyVisible;
      const pollOptions = optionsByPoll.get(poll.id) ?? [];
      const totalVoteCount = resultsVisible
        ? pollOptions.reduce((sum, option) => sum + (countByOption.get(option.id) ?? 0), 0)
        : null;
      return [poll.commentId, {
        id: poll.id.toString(),
        question: poll.question,
        status,
        resultsVisibility: visibility,
        closesAt: poll.closesAt?.toISOString() ?? null,
        closedAt: poll.closedAt?.toISOString() ?? (expired ? poll.closesAt?.toISOString() ?? null : null),
        totalVoteCount,
        selectedOptionId: selectedOptionId?.toString() ?? null,
        resultsVisible,
        privilegedResults: input.canManagePage && !normallyVisible,
        canVote: Boolean(input.viewerProfileId && input.canReply && input.threadStatus === 'open' && status === 'open'),
        canClose: Boolean(input.viewerProfileId && status === 'open' && (input.canManagePage || poll.createdBy === input.viewerProfileId)),
        options: pollOptions.map((option) => ({
          id: option.id.toString(),
          label: option.label,
          position: option.position,
          voteCount: resultsVisible ? countByOption.get(option.id) ?? 0 : null
        }))
      } satisfies WikiDiscussionPollDetail] as const;
    }));
  }

  private async createSystemEntry(
    tx: Prisma.TransactionClient,
    input: {
      readonly threadId: bigint;
      readonly actorProfileId: bigint;
      readonly type: WikiDiscussionSystemEventType;
      readonly before: string | null;
      readonly after: string | null;
      readonly now: Date;
    }
  ): Promise<void> {
    this.assertSystemEventShape(input.type, input.before, input.after);
    await tx.wikiDiscussionComment.create({
      data: {
        threadId: input.threadId,
        content: '',
        status: 'normal',
        entryType: 'system',
        eventType: input.type,
        eventBefore: input.before,
        eventAfter: input.after,
        createdBy: input.actorProfileId,
        createdAt: input.now
      }
    });
  }

  private assertSystemEventShape(type: WikiDiscussionSystemEventType, before: string | null, after: string | null): void {
    if (before === after) throw new Error(`Invalid ${type} system event: values must change.`);
    if (type === 'status_change') {
      if (!before || !after || !['open', 'paused', 'closed'].includes(before) || !['open', 'paused', 'closed'].includes(after)) {
        throw new Error('Invalid status_change system event.');
      }
      return;
    }
    if (type === 'topic_change') {
      if (!before || !after || before.length > 255 || after.length > 255) throw new Error('Invalid topic_change system event.');
      return;
    }
    if (type === 'page_move') {
      if (!before || !after || !/^\d+$/.test(before) || !/^\d+$/.test(after)) throw new Error('Invalid page_move system event.');
      return;
    }
    if ((!before && !after) || (before && !/^\d+$/.test(before)) || (after && !/^\d+$/.test(after))) {
      throw new Error('Invalid pin_change system event.');
    }
  }

  private async hydrateSystemEvents(
    comments: ReadonlyArray<{
      readonly id: bigint;
      readonly entryType: string;
      readonly eventType: string | null;
      readonly eventBefore: string | null;
      readonly eventAfter: string | null;
    }>,
    accountId: string | null
  ): Promise<Map<bigint, NonNullable<WikiThreadDetail['comments'][number]['systemEvent']>>> {
    const rows = comments.filter((comment) => comment.entryType === 'system');
    const pageIds = rows.flatMap((row) => row.eventType === 'page_move'
      ? [row.eventBefore, row.eventAfter].filter((value): value is string => Boolean(value) && /^\d+$/.test(value!)).map(BigInt)
      : []);
    const pinIds = rows.flatMap((row) => row.eventType === 'pin_change'
      ? [row.eventBefore, row.eventAfter].filter((value): value is string => Boolean(value) && /^\d+$/.test(value!)).map(BigInt)
      : []);
    const [pages, pinComments] = await Promise.all([
      pageIds.length > 0 ? this.prisma.wikiPage.findMany({ where: { id: { in: [...new Set(pageIds)] } } }) : [],
      pinIds.length > 0 ? this.prisma.wikiDiscussionComment.findMany({
        where: { id: { in: [...new Set(pinIds)] }, entryType: 'comment', status: 'normal' }, select: { id: true }
      }) : []
    ]);
    const readablePageNames = new Map<string, string>();
    for (const page of pages) {
      try {
        await this.wikiPermissions.assertCanReadPage({ accountId, page });
        readablePageNames.set(page.id.toString(), page.displayTitle);
      } catch {
        // Deliberately omit private page names and identifiers from the public timeline.
      }
    }
    const readablePins = new Set(pinComments.map((comment) => comment.id.toString()));
    const result = new Map<bigint, NonNullable<WikiThreadDetail['comments'][number]['systemEvent']>>();
    for (const row of rows) {
      if (!['status_change', 'topic_change', 'page_move', 'pin_change'].includes(row.eventType ?? '')) continue;
      const type = row.eventType as WikiDiscussionSystemEventType;
      const label = (value: string | null): { value: string | null; redacted: boolean } => {
        if (value === null) return { value: null, redacted: false };
        if (type === 'page_move') {
          const name = readablePageNames.get(value);
          return name ? { value: name, redacted: false } : { value: null, redacted: true };
        }
        if (type === 'pin_change') {
          return readablePins.has(value) ? { value: `#${value}`, redacted: false } : { value: null, redacted: true };
        }
        return { value, redacted: false };
      };
      const before = label(row.eventBefore);
      const after = label(row.eventAfter);
      result.set(row.id, {
        type, before: before.value, after: after.value,
        beforeRedacted: before.redacted, afterRedacted: after.redacted
      });
    }
    return result;
  }

  private async lockDiscussionRows(
    tx: Prisma.TransactionClient,
    threadId: bigint,
    commentId?: bigint,
    pollId?: bigint
  ): Promise<void> {
    const queryable = tx as unknown as { $queryRaw?: unknown };
    if (typeof queryable.$queryRaw !== 'function') return;
    await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM wiki_discussion_threads WHERE id = ${threadId} FOR UPDATE`;
    if (commentId) {
      await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM wiki_discussion_comments WHERE id = ${commentId} FOR UPDATE`;
    }
    if (pollId) {
      await tx.$queryRaw<Array<{ id: bigint }>>`SELECT id FROM wiki_discussion_polls WHERE id = ${pollId} FOR UPDATE`;
    }
  }

  private async profileNames(ids: readonly bigint[]) {
    const unique = [...new Set(ids)];
    const profiles = unique.length > 0
      ? await this.prisma.wikiProfile.findMany({ where: { id: { in: unique } }, select: { id: true, displayName: true } })
      : [];
    return new Map(profiles.map((profile) => [profile.id, profile.displayName]));
  }

  private viewerAccountId(viewer: WikiDiscussionViewer): string | null {
    if (!viewer) return null;
    return typeof viewer === 'string' ? viewer : viewer.userId;
  }

  private async viewerActor(viewer: WikiDiscussionViewer) {
    if (!viewer) return null;
    if (typeof viewer === 'string') return this.wikiPermissions.resolveActor(viewer);
    const profile = await this.wikiProfiles.ensureWikiProfile(viewer.userId);
    return this.wikiPermissions.actorFromSession(viewer, profile);
  }

  private threadStatusFilter(status: WikiDiscussionStatusFilter): Prisma.WikiDiscussionThreadWhereInput['status'] {
    if (status === 'all') return { not: 'deleted' };
    if (status === 'active') return { in: ['open', 'paused'] };
    return status;
  }

  private threadWriteBlockedMessage(status: string): string {
    if (status === 'paused') return 'Wiki discussion thread is paused.';
    if (status === 'closed') return 'Wiki discussion thread is closed.';
    return 'Wiki discussion thread is not open.';
  }

  private toThreadSummary(
    thread: { id: bigint; pageId: bigint; title: string; status: string; createdBy: bigint; createdAt: Date; updatedAt: Date },
    profileById: ReadonlyMap<bigint, string>,
    commentCount: number,
    preview?: WikiThreadPreview
  ): WikiThreadSummary {
    return {
      id: thread.id.toString(), pageId: thread.pageId.toString(), title: thread.title, status: thread.status,
      createdBy: thread.createdBy.toString(), createdByName: profileById.get(thread.createdBy) ?? '알 수 없는 사용자',
      commentCount, ...(preview ? { preview } : {}),
      createdAt: thread.createdAt.toISOString(), updatedAt: thread.updatedAt.toISOString()
    };
  }

  private async loadThreadPreviews(
    threadIds: readonly bigint[]
  ): Promise<{
    readonly rowsByThreadId: ReadonlyMap<bigint, readonly ThreadPreviewRow[]>;
    readonly countByThreadId: ReadonlyMap<bigint, number>;
  }> {
    if (threadIds.length === 0) {
      return { rowsByThreadId: new Map(), countByThreadId: new Map() };
    }
    const rows = await this.prisma.$queryRaw<ThreadPreviewRow[]>(Prisma.sql`
      WITH ranked AS (
        SELECT
          id,
          thread_id,
          LEFT(content, 600) AS content_preview,
          CHAR_LENGTH(content) AS content_length,
          status,
          created_by,
          created_at,
          ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY id ASC) AS first_rank,
          ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY id DESC) AS recent_rank,
          COUNT(*) OVER (PARTITION BY thread_id) AS comment_count
        FROM wiki_discussion_comments
        WHERE entry_type = 'comment'
          AND thread_id IN (${Prisma.join(threadIds)})
      )
      SELECT
        id,
        thread_id AS threadId,
        content_preview AS contentPreview,
        content_length AS contentLength,
        status,
        created_by AS createdBy,
        created_at AS createdAt,
        first_rank AS firstRank,
        recent_rank AS recentRank,
        comment_count AS commentCount
      FROM ranked
      WHERE first_rank = 1 OR recent_rank <= 3
      ORDER BY thread_id ASC, id ASC
    `);
    const rowsByThreadId = new Map<bigint, ThreadPreviewRow[]>();
    const countByThreadId = new Map<bigint, number>();
    for (const row of rows) {
      const group = rowsByThreadId.get(row.threadId) ?? [];
      group.push(row);
      rowsByThreadId.set(row.threadId, group);
      countByThreadId.set(row.threadId, Number(row.commentCount));
    }
    return { rowsByThreadId, countByThreadId };
  }

  private toThreadPreview(
    rows: readonly ThreadPreviewRow[],
    commentCount: number,
    profileById: ReadonlyMap<bigint, string>,
    canViewHidden: boolean
  ): WikiThreadPreview {
    const firstRow = rows.find((row) => Number(row.firstRank) === 1) ?? null;
    const recentRows = rows.filter((row) => Number(row.recentRank) <= 3 && row.id !== firstRow?.id);
    const firstComment = firstRow ? this.toThreadCommentPreview(firstRow, profileById, canViewHidden) : null;
    const recentComments = recentRows.map((row) => this.toThreadCommentPreview(row, profileById, canViewHidden));
    return {
      firstComment,
      recentComments,
      omittedCommentCount: Math.max(0, commentCount - recentComments.length - (firstComment ? 1 : 0))
    };
  }

  private toThreadCommentPreview(
    row: ThreadPreviewRow,
    profileById: ReadonlyMap<bigint, string>,
    canViewHidden: boolean
  ): WikiThreadCommentPreview {
    const readable = row.status === 'normal' || (row.status === 'hidden' && canViewHidden);
    const normalized = readable ? row.contentPreview.replace(/\s+/gu, ' ').trim() : '';
    const characters = [...normalized];
    return {
      id: row.id.toString(),
      status: row.status,
      contentPreview: readable ? characters.slice(0, 280).join('') : null,
      truncated: readable && (Number(row.contentLength) > 600 || characters.length > 280),
      createdBy: row.createdBy.toString(),
      createdByName: profileById.get(row.createdBy) ?? '알 수 없는 사용자',
      createdAt: row.createdAt.toISOString()
    };
  }

  private requiredText(value: unknown, label: string, maxLength: number): string {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) throw new BadRequestException(`${label} is required.`);
    if (text.length > maxLength) throw new BadRequestException(`${label} is too long.`);
    return text;
  }

  private optionalReason(value?: string): string | null {
    const reason = value?.trim() ?? '';
    if (reason.length > 1000) throw new BadRequestException('reason is too long.');
    return reason || null;
  }

  private parseId(value: string, label: string): bigint {
    if (!/^\d+$/.test(value)) throw new BadRequestException(`${label} must be an unsigned integer.`);
    return BigInt(value);
  }

  private encodeRecentCursor(snapshotAt: Date, updatedAt: Date, id: bigint): string {
    return Buffer.from(JSON.stringify({ snapshotAt: snapshotAt.toISOString(), updatedAt: updatedAt.toISOString(), id: id.toString() })).toString('base64url');
  }

  private decodeRecentCursor(value: string): { snapshotAt: Date; updatedAt: Date; id: bigint } {
    try {
      const decoded = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as { snapshotAt?: string; updatedAt?: string; id?: string };
      const snapshotAt = new Date(decoded.snapshotAt ?? '');
      const updatedAt = new Date(decoded.updatedAt ?? '');
      if (Number.isNaN(snapshotAt.getTime()) || Number.isNaN(updatedAt.getTime()) || !decoded.id || !/^\d+$/.test(decoded.id)) throw new Error('invalid');
      return { snapshotAt, updatedAt, id: BigInt(decoded.id) };
    } catch {
      throw new BadRequestException('Invalid recent discussion cursor.');
    }
  }

  private async audit(
    action: string,
    session: SessionPayload,
    profileId: bigint,
    pageId: bigint,
    threadId: bigint,
    metadata: Record<string, unknown> = {}
  ) {
    await this.events?.audit(action, {
      category: 'wiki', actorAccountId: session.userId, actorProfileId: profileId,
      subjectType: 'wiki_discussion', subjectId: threadId.toString(), metadata: { pageId: pageId.toString(), ...metadata }
    });
  }
}
