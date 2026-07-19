import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { createHmac } from 'node:crypto';
import { ConfigService } from '@minewiki/config';
import { normalizeIpOrCidr } from '@minewiki/security';
import { renderDiscussionMarkup, wikiUrl } from '@minewiki/wiki-core';
import { PUBLIC_WIKI_PAGE_STATUSES } from '@minewiki/wiki-core/page-status';
import { Prisma, type ServerWikiReleaseItem, type WikiDiscussionThread, type WikiPage } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiNotificationService } from './wiki-notification.service';
import { buildServerWikiPagePath } from './wiki-read.service';
import { buildCanonicalServerWikiPath, buildCanonicalServerWikiToolPath } from './wiki-route-path.resolver';
import { WikiDiscussionLiveService } from './wiki-discussion-live.service';
import { extractDiscussionMentions, uniqueDiscussionMentionUsernames } from './wiki-discussion-mention';
import { wikiLinkResolutionContext } from './wiki-link-context';
import { createWikiAnonymousContributorToken, WIKI_ANONYMOUS_CONTRIBUTOR_TTL_SECONDS, wikiAnonymousContributorDigest } from './wiki-anonymous-contributor';
import {
  decodeWikiRecentDiscussionCursor,
  encodeWikiRecentDiscussionCursor,
  type WikiRecentDiscussionCursorScope,
  type WikiRecentDiscussionSort,
} from './wiki-discussion-recent-cursor';

export interface WikiThreadSummary {
  readonly id: string;
  readonly pageId: string;
  readonly title: string;
  readonly status: string;
  readonly createdBy: string | null;
  readonly createdByName: string;
  readonly anonymous: boolean;
  readonly viewerOwns: boolean;
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
  readonly createdBy: string | null;
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

export interface WikiRecentThreadListOptions {
  readonly cursor?: string;
  readonly limit?: number;
  readonly status?: WikiDiscussionStatusFilter;
  readonly sort?: WikiRecentDiscussionSort;
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
    readonly contentHtml: string | null;
    readonly status: string;
    readonly createdBy: string | null;
    readonly createdByName: string;
    readonly createdByUsername: string | null;
    readonly mentions: ReadonlyArray<{
      readonly username: string;
      readonly profileId: string;
      readonly start: number;
      readonly end: number;
    }>;
    readonly createdAt: string | null;
    readonly canDelete: boolean;
    readonly viewerOwns: boolean;
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
  readonly createdBy: bigint | null;
  readonly anonymousOwnerId: bigint | null;
  readonly createdAt: Date;
  readonly firstRank: bigint | number;
  readonly recentRank: bigint | number;
  readonly commentCount: bigint | number;
}

const THREAD_PAGE_CANDIDATE_BATCH_SIZE = 50;
const MAX_THREAD_PAGE_CANDIDATE_SCAN = 250;
const MAX_STATUS_COUNT_SCAN = 1_000;
const GLOBAL_RECENT_CANDIDATE_BATCH_SIZE = 50;
const MAX_GLOBAL_RECENT_CANDIDATE_SCAN = 250;

@Injectable()
export class WikiDiscussionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    private readonly wikiPermissions: WikiPermissionService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly notifications?: WikiNotificationService,
    @Optional() private readonly live?: WikiDiscussionLiveService,
    @Optional() private readonly config?: ConfigService,
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
    const actor = await this.viewerActor(viewer);
    const page = await this.readablePage(pageId, accountId, undefined, actor);
    const candidates = await this.prisma.wikiDiscussionThread.findMany({
      where: { pageId: page.id, status: { not: 'deleted' } },
      orderBy: [{ updatedAt: 'desc' }],
      take: 100
    });
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
          where: { threadId: { in: threads.map((thread) => thread.id) }, entryType: 'comment', status: 'normal' },
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
    const actor = await this.viewerActor(viewer);
    const page = await this.readablePage(pageId, accountId, undefined, actor);
    const limit = Math.min(Math.max(requestedLimit, 1), 50);
    const cursorScope: WikiRecentDiscussionCursorScope = {
      kind: 'page', pageId: page.id.toString(), status: statusFilter, sort: 'newest',
    };
    const decoded = cursor ? this.decodeRecentCursor(cursor, cursorScope) : null;
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
    const previewData = includePreview
      ? await this.loadThreadPreviews(pageThreads.map((thread) => thread.id))
      : null;
    const countRows = !previewData && pageThreads.length > 0
      ? await this.prisma.wikiDiscussionComment.groupBy({
          by: ['threadId'],
          where: { threadId: { in: pageThreads.map((thread) => thread.id) }, entryType: 'comment', status: 'normal' },
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
          profileById
        ) : undefined
      )),
      nextCursor: hasMore && last ? this.encodeRecentCursor(snapshotAt, last.updatedAt, last.id, cursorScope) : null,
      statusCounts: {
        total,
        open: statusCount.get('open') ?? 0,
        paused: statusCount.get('paused') ?? 0,
        closed: statusCount.get('closed') ?? 0
      },
      statusCountsComplete: statusCandidates.length <= MAX_STATUS_COUNT_SCAN
    };
  }

  async getPageDiscussionPermissions(
    pageId: string,
    session?: SessionPayload | null,
    requestIp?: string | null,
  ): Promise<{ readonly canCreateThread: boolean }> {
    const actor = await this.viewerActor(session);
    const page = await this.readablePage(pageId, session?.userId ?? null, requestIp, actor);
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
    } else if (this.anonymousDiscussionsEnabled() && requestIp) {
      try {
        await this.wikiPermissions.assertCanCreateThread({ actor: null, page, requestIp });
        canCreateThread = true;
      } catch {
        canCreateThread = false;
      }
    }
    return { canCreateThread };
  }

  async listRecent(
    viewer: WikiDiscussionViewer,
    options: WikiRecentThreadListOptions = {},
  ): Promise<WikiRecentThreadListResponse> {
    const accountId = this.viewerAccountId(viewer);
    const limit = Math.min(Math.max(options.limit ?? 30, 1), 50);
    const statusFilter = options.status ?? 'all';
    const sort = options.sort ?? 'newest';
    const cursorScope: WikiRecentDiscussionCursorScope = { kind: 'global', status: statusFilter, sort };
    const decoded = options.cursor ? this.decodeRecentCursor(options.cursor, cursorScope) : null;
    const snapshotAt = decoded?.snapshotAt ?? new Date();
    const status = statusFilter === 'all'
      ? { not: 'deleted' as const }
      : statusFilter === 'active'
        ? { in: ['open', 'paused'] }
        : statusFilter;
    const candidateWhere = (position: { readonly updatedAt: Date; readonly id: bigint } | null): Prisma.WikiDiscussionThreadWhereInput => ({
      status,
      updatedAt: { lte: snapshotAt },
      ...(position ? {
        OR: [
          { updatedAt: { [sort === 'newest' ? 'lt' : 'gt']: position.updatedAt } },
          { updatedAt: position.updatedAt, id: { [sort === 'newest' ? 'lt' : 'gt']: position.id } }
        ]
      } : {})
    });
    const order = sort === 'newest' ? 'desc' as const : 'asc' as const;
    const actor = await this.viewerActor(viewer);
    const visibleRows: Array<{
      thread: WikiDiscussionThread;
      page: WikiPage;
      namespace: string;
      serverWiki: { readonly slug: string; readonly siteSlug: string } | null;
    }> = [];
    let scanPosition = decoded ? { updatedAt: decoded.updatedAt, id: decoded.id } : null;
    let lastScanned: WikiDiscussionThread | undefined;
    let scannedCandidateCount = 0;
    let candidatesExhausted = false;
    while (visibleRows.length <= limit && scannedCandidateCount < MAX_GLOBAL_RECENT_CANDIDATE_SCAN) {
      const take = Math.min(GLOBAL_RECENT_CANDIDATE_BATCH_SIZE, MAX_GLOBAL_RECENT_CANDIDATE_SCAN - scannedCandidateCount);
      const candidates = await this.prisma.wikiDiscussionThread.findMany({
        where: candidateWhere(scanPosition), orderBy: [{ updatedAt: order }, { id: order }], take,
      });
      if (candidates.length === 0) { candidatesExhausted = true; break; }
      scannedCandidateCount += candidates.length;
      lastScanned = candidates.at(-1);
      scanPosition = lastScanned ? { updatedAt: lastScanned.updatedAt, id: lastScanned.id } : scanPosition;
      const batchPages = await this.prisma.wikiPage.findMany({
        where: { id: { in: [...new Set(candidates.map((thread) => thread.pageId))] } },
      });
      const projectedPages = await this.projectRecentDiscussionPages(batchPages, accountId, actor);
      const readable = await this.wikiPermissions.filterReadableThreads({
        accountId,
        actor,
        items: candidates.flatMap((thread) => {
          const projection = projectedPages.get(thread.pageId);
          return projection ? [{ thread, page: projection.page }] : [];
        }),
      });
      visibleRows.push(...readable.flatMap(({ thread }) => {
        const projection = projectedPages.get(thread.pageId);
        return projection ? [{ thread, ...projection }] : [];
      }));
      if (candidates.length < take) { candidatesExhausted = true; break; }
    }
    const hasUnscannedCandidates = visibleRows.length <= limit && !candidatesExhausted && lastScanned
      ? (await this.prisma.wikiDiscussionThread.findMany({
          where: candidateWhere({ updatedAt: lastScanned.updatedAt, id: lastScanned.id }),
          orderBy: [{ updatedAt: order }, { id: order }], take: 1,
        })).length > 0
      : false;
    const pageRows = visibleRows.slice(0, limit);
    if (pageRows.length === 0 && !hasUnscannedCandidates) return { items: [], nextCursor: null };
    const profileById = await this.profileNames(pageRows.map(({ thread }) => thread.createdBy));
    const countRows = pageRows.length > 0
      ? await this.prisma.wikiDiscussionComment.groupBy({
          by: ['threadId'],
          where: { threadId: { in: pageRows.map(({ thread }) => thread.id) }, entryType: 'comment', status: 'normal' },
          _count: { _all: true }
        })
      : [];
    const countByThreadId = new Map(countRows.map((row) => [row.threadId, row._count._all]));
    const items = pageRows.map(({ thread, page, namespace, serverWiki }) => {
      const routePath = namespace === 'server' && serverWiki
        ? buildCanonicalServerWikiPath(serverWiki.siteSlug, page.localPath, serverWiki.slug, '/serverWiki')
        : wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title);
      return {
        ...this.toThreadSummary(thread, profileById, countByThreadId.get(thread.id) ?? 0),
        pageTitle: page.displayTitle,
        namespace,
        routePath,
        discussionHref: namespace === 'server' && serverWiki
          ? `${buildCanonicalServerWikiToolPath(serverWiki.siteSlug, page.localPath, 'discuss', serverWiki.slug, '/serverWiki')}?thread=${thread.id.toString()}`
          : `/wiki/discuss/${page.id.toString()}?returnTo=${encodeURIComponent(routePath)}&thread=${thread.id.toString()}`
      };
    });
    const cursorRow = visibleRows.length > limit ? pageRows.at(-1)?.thread : hasUnscannedCandidates ? lastScanned : undefined;
    const hasMore = visibleRows.length > limit || hasUnscannedCandidates;
    return {
      items,
      nextCursor: hasMore && cursorRow
        ? this.encodeRecentCursor(snapshotAt, cursorRow.updatedAt, cursorRow.id, cursorScope)
        : null,
    };
  }

  private async projectRecentDiscussionPages(
    pages: readonly WikiPage[],
    accountId: string | null,
    actor: Awaited<ReturnType<WikiDiscussionService['viewerActor']>>,
  ): Promise<Map<bigint, {
    readonly page: WikiPage;
    readonly namespace: string;
    readonly serverWiki: { readonly slug: string; readonly siteSlug: string } | null;
  }>> {
    if (pages.length === 0) return new Map();
    const namespaces = await this.prisma.wikiNamespace.findMany({
      where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } },
      select: { id: true, code: true },
    });
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const currentRevisionIds = pages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []);
    const publicRevisions = currentRevisionIds.length > 0
      ? await this.prisma.wikiPageRevision.findMany({
          where: { id: { in: currentRevisionIds }, visibility: 'public' },
          select: { id: true },
        })
      : [];
    const publicRevisionIds = new Set(publicRevisions.map((revision) => revision.id));
    const serverSpaceIds = [...new Set(pages
      .filter((page) => namespaceById.get(page.namespaceId) === 'server')
      .map((page) => page.spaceId))];
    const serverWikis = serverSpaceIds.length > 0
      ? await this.prisma.serverWiki.findMany({
          where: { spaceId: { in: serverSpaceIds }, status: 'active' },
          select: { id: true, spaceId: true, slug: true, siteSlug: true, publicationStatus: true, publishedReleaseId: true },
        })
      : [];
    const serverWikiBySpace = new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki]));
    const previewSpaceIds = new Set<bigint>();
    for (const wiki of serverWikis) {
      if (await this.wikiPermissions.canPreviewServerWikiSpace({ accountId, actor, spaceId: wiki.spaceId })) {
        previewSpaceIds.add(wiki.spaceId);
      }
    }
    const publicWikis = serverWikis.filter((wiki) =>
      !previewSpaceIds.has(wiki.spaceId)
      && wiki.publicationStatus === 'published'
      && wiki.publishedReleaseId !== null);
    const releaseItems = publicWikis.length > 0
      ? await this.prisma.serverWikiReleaseItem.findMany({
          where: {
            pageId: { in: pages.map((page) => page.id) },
            OR: publicWikis.map((wiki) => ({
              releaseId: wiki.publishedReleaseId!,
              serverWikiId: wiki.id,
              spaceId: wiki.spaceId,
            })),
          },
        })
      : [];
    if (releaseItems.length > 0) {
      const publicReleaseRevisions = await this.prisma.wikiPageRevision.findMany({
        where: { id: { in: [...new Set(releaseItems.map((item) => item.revisionId))] }, visibility: 'public' },
        select: { id: true },
      });
      for (const revision of publicReleaseRevisions) publicRevisionIds.add(revision.id);
    }
    const releaseItemByPageId = new Map(releaseItems.map((item) => [item.pageId, item]));
    const projected = new Map<bigint, {
      readonly page: WikiPage;
      readonly namespace: string;
      readonly serverWiki: { readonly slug: string; readonly siteSlug: string } | null;
    }>();
    for (const page of pages) {
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const serverWiki = namespace === 'server' ? serverWikiBySpace.get(page.spaceId) : undefined;
      if (namespace !== 'server' || (serverWiki && previewSpaceIds.has(page.spaceId))) {
        if (
          !page.currentRevisionId
          || !publicRevisionIds.has(page.currentRevisionId)
          || !PUBLIC_WIKI_PAGE_STATUSES.includes(page.status as (typeof PUBLIC_WIKI_PAGE_STATUSES)[number])
          || page.pageType === 'redirect'
        ) continue;
        projected.set(page.id, {
          page,
          namespace,
          serverWiki: serverWiki ? { slug: serverWiki.slug, siteSlug: serverWiki.siteSlug ?? serverWiki.slug } : null,
        });
        continue;
      }
      if (!serverWiki || serverWiki.publishedReleaseId === null) continue;
      const item = releaseItemByPageId.get(page.id);
      if (
        !item
        || item.releaseId !== serverWiki.publishedReleaseId
        || item.serverWikiId !== serverWiki.id
        || item.spaceId !== serverWiki.spaceId
        || !publicRevisionIds.has(item.revisionId)
        || !PUBLIC_WIKI_PAGE_STATUSES.includes(item.pageStatus as (typeof PUBLIC_WIKI_PAGE_STATUSES)[number])
        || item.pageType === 'redirect'
      ) continue;
      projected.set(page.id, {
        page: {
          ...page,
          namespaceId: item.namespaceId,
          spaceId: item.spaceId,
          localPath: item.localPath,
          slug: item.slug,
          title: item.title,
          displayTitle: item.displayTitle,
          currentRevisionId: item.revisionId,
          pageType: item.pageType,
          protectionLevel: item.protectionLevel,
          status: item.pageStatus,
          createdBy: item.createdBy,
          ownerProfileId: item.ownerProfileId,
          updatedAt: item.pageUpdatedAt,
        },
        namespace,
        serverWiki: { slug: serverWiki.slug, siteSlug: serverWiki.siteSlug ?? serverWiki.slug },
      });
    }
    return projected;
  }

  async getThread(
    threadId: string,
    session?: SessionPayload | null,
    commentCursor?: string,
    requestedLimit = 100,
    focusCommentId?: string,
    commentDirection: 'older' | 'newer' = 'older',
    anonymousToken?: string | null,
    requestIp?: string | null,
  ): Promise<WikiThreadDetail> {
    const id = this.parseId(threadId, 'threadId');
    const thread = await this.prisma.wikiDiscussionThread.findUnique({ where: { id } });
    if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
    const viewerActor = await this.viewerActor(session);
    const page = await this.readablePage(thread.pageId.toString(), session?.userId ?? null, requestIp, viewerActor);
    const markupContext = await this.discussionMarkupContext(page);
    await this.wikiPermissions.assertCanReadThread({
      accountId: session?.userId ?? null,
      actor: viewerActor,
      thread,
      page,
      requestIp,
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
    const commentCount = await this.prisma.wikiDiscussionComment.count({
      where: { threadId: thread.id, entryType: 'comment', status: 'normal' }
    });
    const authorIds = [...new Set([thread.createdBy, ...displayComments.map((comment) => comment.createdBy)]
      .filter((profileId): profileId is bigint => profileId !== null))];
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
    const anonymousOwnerId = await this.resolveAnonymousOwnerId(anonymousToken);
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
    } else if (!session && this.anonymousDiscussionsEnabled() && requestIp && thread.status === 'open') {
      try {
        await this.wikiPermissions.assertCanWriteThreadComment({ actor: null, page, threadId: thread.id, requestIp });
        canReply = true;
      } catch {
        canReply = false;
      }
    }
    const threadViewerOwns = anonymousOwnerId !== null && thread.createdBy === null && thread.anonymousOwnerId === anonymousOwnerId;
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
      ...this.toThreadSummary(thread, profileById, commentCount, undefined, threadViewerOwns),
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
      }).map((comment) => {
        const concealed = comment.entryType !== 'system'
          && (comment.status === 'deleted' || (comment.status === 'hidden' && !canManage));
        const mentions = concealed || comment.entryType === 'system'
          ? []
          : (mentionOccurrencesByComment.get(comment.id) ?? []).flatMap((mention) => {
              const target = mentionProfileByUsername.get(mention.username.toLocaleLowerCase('en-US'));
              return target ? [{ username: target.username, profileId: target.id.toString(), start: mention.start, end: mention.end }] : [];
            });
        return {
        id: comment.id.toString(),
        entryType: comment.entryType === 'system' ? 'system' as const : 'comment' as const,
        systemEvent: comment.entryType === 'system' ? systemEvents.get(comment.id) ?? null : null,
        content: concealed || comment.entryType === 'system' ? null : comment.content,
        contentHtml: concealed || comment.entryType === 'system'
          ? null
          : renderDiscussionMarkup(comment.content, {
              ...markupContext,
              mentions: mentions.map((mention) => ({
                username: mention.username,
                href: `/user/${encodeURIComponent(mention.username)}`,
              })),
            }),
        status: concealed ? 'hidden' : comment.status,
        createdBy: concealed ? null : comment.createdBy?.toString() ?? null,
        createdByName: concealed ? '비공개 사용자' : comment.createdBy === null ? '익명 기여자' : profileById.get(comment.createdBy) ?? '알 수 없는 사용자',
        createdByUsername: concealed || comment.createdBy === null ? null : usernameByProfileId.get(comment.createdBy) ?? null,
        mentions,
        createdAt: concealed ? null : comment.createdAt.toISOString(),
        canDelete: Boolean(comment.entryType !== 'system' && comment.status !== 'deleted' && viewer && (comment.createdBy === viewer.id || canManage)),
        viewerOwns: Boolean(!concealed && anonymousOwnerId !== null && comment.createdBy === null && comment.anonymousOwnerId === anonymousOwnerId),
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
      }})
    };
  }

  async createThread(
    session: SessionPayload,
    pageId: string,
    input: { readonly title?: string; readonly content?: string; readonly poll?: WikiDiscussionPollInput }
  ): Promise<WikiThreadDetail> {
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    const page = await this.readablePage(pageId, session.userId, undefined, actor);
    await this.wikiPermissions.assertCanCreateThread({
      actor,
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
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    const page = await this.readablePage(thread.pageId.toString(), session.userId, undefined, actor);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    await this.wikiPermissions.assertCanWriteThreadComment({ actor, page, threadId: thread.id });
    const content = this.requiredText(input.content, 'content', 10_000);
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      if (!currentThread || currentThread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
      if (currentThread.status !== 'open') throw new BadRequestException(this.threadWriteBlockedMessage(currentThread.status));
      const currentLivePage = await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } });
      const currentPage = currentLivePage
        ? (await this.pageAtPublicationBoundary(currentLivePage, actor, tx)).page
        : null;
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

  assertAnonymousDiscussionsEnabled(): void {
    if (!this.anonymousDiscussionsEnabled()) {
      throw new ForbiddenException('Anonymous wiki discussions are disabled.');
    }
  }

  async createAnonymousThread(
    pageId: string,
    input: { readonly title?: string; readonly content?: string; readonly poll?: WikiDiscussionPollInput },
    requestIp: string,
    existingOwnerToken?: string | null,
  ): Promise<{ readonly thread: WikiThreadDetail; readonly ownerToken: string; readonly ownerTokenIssued: boolean }> {
    this.assertAnonymousDiscussionsEnabled();
    if (input.poll) throw new ForbiddenException('Anonymous contributors cannot create polls.');
    const parsedPageId = this.parseId(pageId, 'pageId');
    const title = this.requiredText(input.title, 'title', 255);
    const content = this.requiredText(input.content, 'content', 10_000);
    const ipHash = this.anonymousIpHash(requestIp);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      const livePage = await tx.wikiPage.findUnique({ where: { id: parsedPageId } });
      if (!livePage) throw new NotFoundException('Wiki page not found.');
      const page = (await this.pageAtPublicationBoundary(livePage, null, tx)).page;
      await this.wikiPermissions.assertCanCreateThread({ actor: null, page, requestIp, store: tx });
      const openCount = await tx.wikiDiscussionThread.count({
        where: { pageId: page.id, createdBy: null, status: { in: ['open', 'paused'] } },
      });
      if (openCount >= 20) throw new ConflictException('This page has too many open anonymous discussions.');
      const owner = await this.getOrCreateAnonymousOwner(tx, now, existingOwnerToken);
      const created = await tx.wikiDiscussionThread.create({
        data: {
          pageId: page.id,
          title,
          status: 'open',
          createdBy: null,
          anonymousOwnerId: owner.id,
          actorIpHash: ipHash,
          createdAt: now,
          updatedAt: now,
        },
      });
      await tx.wikiDiscussionComment.create({
        data: {
          threadId: created.id,
          content,
          status: 'normal',
          createdBy: null,
          anonymousOwnerId: owner.id,
          actorIpHash: ipHash,
          createdAt: now,
        },
      });
      return { page, created, ...owner };
    });
    this.live?.publish(result.created.id);
    await this.events?.audit('wiki.discussion.create_anonymous', {
      category: 'wiki',
      subjectType: 'wiki_discussion_thread',
      subjectId: result.created.id.toString(),
      ipAddress: requestIp,
      metadata: { pageId: result.page.id.toString(), anonymousOwnerId: result.id.toString() },
    });
    return {
      thread: await this.getThread(result.created.id.toString(), null, undefined, 100, undefined, 'older', result.token, requestIp),
      ownerToken: result.token,
      ownerTokenIssued: result.issued,
    };
  }

  async addAnonymousComment(
    threadId: string,
    input: { readonly content?: string; readonly poll?: WikiDiscussionPollInput },
    requestIp: string,
    existingOwnerToken?: string | null,
  ): Promise<{ readonly thread: WikiThreadDetail; readonly ownerToken: string; readonly ownerTokenIssued: boolean }> {
    this.assertAnonymousDiscussionsEnabled();
    if (input.poll) throw new ForbiddenException('Anonymous contributors cannot create polls.');
    const id = this.parseId(threadId, 'threadId');
    const content = this.requiredText(input.content, 'content', 10_000);
    const ipHash = this.anonymousIpHash(requestIp);
    const now = new Date();
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, id);
      const thread = await tx.wikiDiscussionThread.findUnique({ where: { id } });
      if (!thread || thread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
      if (thread.status !== 'open') throw new BadRequestException(this.threadWriteBlockedMessage(thread.status));
      const livePage = await tx.wikiPage.findUnique({ where: { id: thread.pageId } });
      if (!livePage) throw new NotFoundException('Wiki page not found.');
      const page = (await this.pageAtPublicationBoundary(livePage, null, tx)).page;
      await this.wikiPermissions.assertCanReadThread({ accountId: null, actor: null, thread, page, requestIp, store: tx });
      await this.wikiPermissions.assertCanWriteThreadComment({ actor: null, page, threadId: thread.id, requestIp, store: tx });
      const owner = await this.getOrCreateAnonymousOwner(tx, now, existingOwnerToken);
      await tx.wikiDiscussionComment.create({
        data: {
          threadId: thread.id,
          content,
          status: 'normal',
          createdBy: null,
          anonymousOwnerId: owner.id,
          actorIpHash: ipHash,
          createdAt: now,
        },
      });
      await tx.wikiDiscussionThread.update({ where: { id: thread.id }, data: { updatedAt: now } });
      return { page, thread, ...owner };
    });
    this.live?.publish(result.thread.id);
    await this.events?.audit('wiki.discussion.comment_anonymous', {
      category: 'wiki',
      subjectType: 'wiki_discussion_thread',
      subjectId: result.thread.id.toString(),
      ipAddress: requestIp,
      metadata: { pageId: result.page.id.toString(), anonymousOwnerId: result.id.toString() },
    });
    return {
      thread: await this.getThread(result.thread.id.toString(), null, undefined, 100, undefined, 'older', result.token, requestIp),
      ownerToken: result.token,
      ownerTokenIssued: result.issued,
    };
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
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    const page = await this.readablePage(thread.pageId.toString(), session.userId, undefined, actor);
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
      const currentLivePage = await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } });
      const currentPage = currentLivePage
        ? (await this.pageAtPublicationBoundary(currentLivePage, actor, tx)).page
        : null;
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
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    const page = await this.readablePage(thread.pageId.toString(), session.userId, undefined, actor);
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
      const currentLivePage = await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } });
      const currentPage = currentLivePage
        ? (await this.pageAtPublicationBoundary(currentLivePage, actor, tx)).page
        : null;
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
    const profile = await this.wikiProfiles.ensureWikiProfile(session.userId);
    const actor = this.wikiPermissions.actorFromSession(session, profile);
    const page = await this.readablePage(thread.pageId.toString(), session.userId, undefined, actor);
    await this.wikiPermissions.assertCanReadThread({ accountId: session.userId, actor, thread, page });
    const now = new Date();
    await this.prisma.$transaction(async (tx) => {
      await this.lockDiscussionRows(tx, thread.id);
      const currentThread = await tx.wikiDiscussionThread.findUnique({ where: { id: thread.id } });
      if (!currentThread || currentThread.status === 'deleted') throw new NotFoundException('Wiki discussion thread not found.');
      const currentLivePage = await tx.wikiPage.findUnique({ where: { id: currentThread.pageId } });
      const currentPage = currentLivePage
        ? (await this.pageAtPublicationBoundary(currentLivePage, actor, tx)).page
        : null;
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
    const actor = await this.viewerActor(session);
    const page = await this.readablePage(thread.pageId.toString(), session?.userId ?? null, undefined, actor);
    await this.wikiPermissions.assertCanReadThread({
      accountId: session?.userId ?? null,
      actor,
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

  private async readablePage(
    pageId: string,
    accountId: string | null,
    requestIp?: string | null,
    actor?: Awaited<ReturnType<WikiDiscussionService['viewerActor']>>,
  ): Promise<WikiPage> {
    const page = await this.prisma.wikiPage.findUnique({ where: { id: this.parseId(pageId, 'pageId') } });
    if (!page) throw new NotFoundException('Wiki page not found.');
    const publication = await this.pageAtPublicationBoundary(page, actor);
    await this.wikiPermissions.assertCanReadPage({
      accountId,
      actor,
      page: publication.page,
      requestIp,
      publicationProof: publication.proof,
    });
    return publication.page;
  }

  private async pageAtPublicationBoundary(
    page: WikiPage,
    actor: Awaited<ReturnType<WikiDiscussionService['viewerActor']>>,
    store: PrismaService | Prisma.TransactionClient = this.prisma,
  ): Promise<{
    readonly page: WikiPage;
    readonly proof?: {
      readonly boundary: Awaited<ReturnType<WikiPermissionService['resolvePublishedPageBoundary']>> & {};
      readonly item: ServerWikiReleaseItem;
    };
  }> {
    const permissionSurface = this.wikiPermissions as unknown as {
      resolvePublishedPageBoundary?: WikiPermissionService['resolvePublishedPageBoundary'];
    };
    const boundary = permissionSurface.resolvePublishedPageBoundary
      ? await permissionSurface.resolvePublishedPageBoundary.call(this.wikiPermissions, { actor, page, store: store as never })
      : null;
    return boundary
      ? { page: this.pageFromReleaseItem(page, boundary.currentItem), proof: { boundary, item: boundary.currentItem } }
      : { page };
  }

  private pageFromReleaseItem(page: WikiPage, item: ServerWikiReleaseItem): WikiPage {
    return {
      ...page,
      namespaceId: item.namespaceId,
      spaceId: item.spaceId,
      localPath: item.localPath,
      slug: item.slug,
      title: item.title,
      displayTitle: item.displayTitle,
      currentRevisionId: item.revisionId,
      pageType: item.pageType,
      protectionLevel: item.protectionLevel,
      status: item.pageStatus,
      createdBy: item.createdBy,
      ownerProfileId: item.ownerProfileId,
      updatedAt: item.pageUpdatedAt,
    };
  }

  private async discussionMarkupContext(page: { namespaceId: number; spaceId: bigint; localPath: string }) {
    const stores = this.prisma as unknown as {
      wikiNamespace?: { findUnique?: (args: unknown) => Promise<{ code: string } | null> };
      serverWiki?: { findUnique?: (args: unknown) => Promise<{ slug: string; status: string } | null> };
    };
    const namespace = stores.wikiNamespace?.findUnique
      ? await stores.wikiNamespace.findUnique({ where: { id: page.namespaceId }, select: { code: true } })
      : null;
    const namespaceCode = namespace?.code ?? 'main';
    const linkResolution = wikiLinkResolutionContext(namespaceCode, page.localPath);
    if (namespaceCode !== 'server' || !stores.serverWiki?.findUnique) return { linkResolution };
    const serverWiki = await stores.serverWiki.findUnique({
      where: { spaceId: page.spaceId },
      select: { slug: true, status: true },
    });
    if (!serverWiki || serverWiki.status === 'disabled') return { linkResolution };
    return {
      linkResolution,
      internalLinkBasePath: buildServerWikiPagePath(serverWiki.slug, serverWiki.slug),
    };
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
    thread: { id: bigint; pageId: bigint; title: string; status: string; createdBy: bigint | null; createdAt: Date; updatedAt: Date },
    profileById: ReadonlyMap<bigint, string>,
    commentCount: number,
    preview?: WikiThreadPreview,
    viewerOwns = false,
  ): WikiThreadSummary {
    return {
      id: thread.id.toString(), pageId: thread.pageId.toString(), title: thread.title, status: thread.status,
      createdBy: thread.createdBy?.toString() ?? null,
      createdByName: thread.createdBy === null ? '익명 기여자' : profileById.get(thread.createdBy) ?? '알 수 없는 사용자',
      anonymous: thread.createdBy === null,
      viewerOwns,
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
          anonymous_owner_id,
          created_at,
          ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY id ASC) AS first_rank,
          ROW_NUMBER() OVER (PARTITION BY thread_id ORDER BY id DESC) AS recent_rank,
          COUNT(*) OVER (PARTITION BY thread_id) AS comment_count
        FROM wiki_discussion_comments
        WHERE entry_type = 'comment'
          AND status = 'normal'
          AND thread_id IN (${Prisma.join(threadIds)})
      )
      SELECT
        id,
        thread_id AS threadId,
        content_preview AS contentPreview,
        content_length AS contentLength,
        status,
        created_by AS createdBy,
        anonymous_owner_id AS anonymousOwnerId,
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
      if (row.status !== 'normal') continue;
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
    profileById: ReadonlyMap<bigint, string>
  ): WikiThreadPreview {
    const firstRow = rows.find((row) => Number(row.firstRank) === 1) ?? null;
    const recentRows = rows.filter((row) => Number(row.recentRank) <= 3 && row.id !== firstRow?.id);
    const firstComment = firstRow ? this.toThreadCommentPreview(firstRow, profileById) : null;
    const recentComments = recentRows.map((row) => this.toThreadCommentPreview(row, profileById));
    return {
      firstComment,
      recentComments,
      omittedCommentCount: Math.max(0, commentCount - recentComments.length - (firstComment ? 1 : 0))
    };
  }

  private toThreadCommentPreview(
    row: ThreadPreviewRow,
    profileById: ReadonlyMap<bigint, string>
  ): WikiThreadCommentPreview {
    const normalized = row.contentPreview.replace(/\s+/gu, ' ').trim();
    const characters = [...normalized];
    return {
      id: row.id.toString(),
      status: row.status,
      contentPreview: characters.slice(0, 280).join(''),
      truncated: Number(row.contentLength) > 600 || characters.length > 280,
      createdBy: row.createdBy?.toString() ?? null,
      createdByName: row.createdBy === null ? '익명 기여자' : profileById.get(row.createdBy) ?? '알 수 없는 사용자',
      createdAt: row.createdAt.toISOString()
    };
  }

  private anonymousDiscussionsEnabled(): boolean {
    return this.config?.getOptional('WIKI_ANONYMOUS_DISCUSSIONS_ENABLED') === 'true';
  }

  private anonymousIpHash(requestIp: string): string {
    const key = this.config?.getOptional('WIKI_ANONYMOUS_IP_HASH_SECRET');
    if (!key) throw new ForbiddenException('Anonymous discussion attribution is unavailable.');
    let normalized: string;
    try {
      normalized = normalizeIpOrCidr(requestIp).address;
    } catch {
      throw new ForbiddenException('Anonymous discussion attribution is unavailable.');
    }
    return createHmac('sha256', key).update(`wiki-discussion-ip:v1:${normalized}`).digest('hex');
  }

  private async resolveAnonymousOwnerId(token?: string | null): Promise<bigint | null> {
    const digest = token ? wikiAnonymousContributorDigest(token) : null;
    if (!digest) return null;
    const owner = await this.prisma.wikiAnonymousContributorSession.findFirst({
      where: { tokenDigest: digest, revokedAt: null, expiresAt: { gt: new Date() } },
      select: { id: true },
    });
    return owner?.id ?? null;
  }

  private async getOrCreateAnonymousOwner(
    tx: Prisma.TransactionClient,
    now: Date,
    existingToken?: string | null,
  ): Promise<{ readonly id: bigint; readonly token: string; readonly issued: boolean }> {
    const digest = existingToken ? wikiAnonymousContributorDigest(existingToken) : null;
    const existing = digest ? await tx.wikiAnonymousContributorSession.findFirst({
      where: { tokenDigest: digest, revokedAt: null, expiresAt: { gt: now } },
      select: { id: true },
    }) : null;
    if (existing && existingToken) {
      await tx.wikiAnonymousContributorSession.update({ where: { id: existing.id }, data: { lastUsedAt: now } });
      return { id: existing.id, token: existingToken, issued: false };
    }
    const token = createWikiAnonymousContributorToken();
    const owner = await tx.wikiAnonymousContributorSession.create({
      data: {
        tokenDigest: wikiAnonymousContributorDigest(token)!,
        createdAt: now,
        lastUsedAt: now,
        expiresAt: new Date(now.getTime() + WIKI_ANONYMOUS_CONTRIBUTOR_TTL_SECONDS * 1000),
      },
      select: { id: true },
    });
    return { id: owner.id, token, issued: true };
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

  private encodeRecentCursor(snapshotAt: Date, updatedAt: Date, id: bigint, scope: WikiRecentDiscussionCursorScope): string {
    return encodeWikiRecentDiscussionCursor(this.recentCursorSecret(), scope, { snapshotAt, updatedAt, id });
  }

  private decodeRecentCursor(value: string, scope: WikiRecentDiscussionCursorScope): { snapshotAt: Date; updatedAt: Date; id: bigint } {
    try {
      return decodeWikiRecentDiscussionCursor(this.recentCursorSecret(), scope, value);
    } catch {
      throw new BadRequestException('Invalid recent discussion cursor.');
    }
  }

  private recentCursorSecret(): string {
    const configured = this.config?.get('APP_ENCRYPTION_KEY') ?? process.env.APP_ENCRYPTION_KEY;
    if (configured) return configured;
    if (process.env.NODE_ENV === 'test') return 'minewiki-test-recent-discussion-cursor-secret';
    throw new Error('APP_ENCRYPTION_KEY is required for recent discussion cursors.');
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
