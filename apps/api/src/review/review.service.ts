import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createReviewSchema,
  reviewTagSchema,
  reviewVisibilitySchema,
  type ReviewGateStatus,
  type ServerReview,
  type ServerReviewAggregate,
  type ServerReviewFeedPage,
  type ServerReviewPage
} from '@minewiki/schemas';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { ServerService } from '../server/server.service';
import { BusinessEventService } from '../events/business-event.service';
import { VoteStore, type VoteRecord } from '../vote/vote.store';
import { MinecraftService } from '../minecraft/minecraft.service';
import { AccountSeparationService } from '../auth/account-separation.service';
import { withCanonicalAccountGroups } from '../auth/account-lifecycle-fence';
import type { SessionPayload } from '../session/session.service';
import {
  ReviewFeedCursorCodec,
  type ReviewFeedCursorBinding,
  type ReviewFeedScope,
  type ReviewVisibilityFilter,
} from './review-feed-cursor';

const REVIEW_COOLDOWN_MS = 1000 * 60 * 60 * 24; // 24시간
const RECENT_VOTE_WINDOW_MS = 1000 * 60 * 60 * 24; // 24시간 내 투표 필요
const OWNERSHIP_VERIFICATION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // 180일
const HELPFUL_COOLDOWN_MS = 1000 * 60 * 5; // 5분
const ADMIN_REPLY_AUTHOR_FALLBACK = '운영진';
// Keep matching the legacy mojibake value without reintroducing unreadable source text.
const CORRUPTED_ADMIN_REPLY_AUTHORS = new Set(['\u003f\ub301\uc07a\uf9de\u003f']);

export type ReviewSort = 'wilson' | 'newest';

export interface ReviewListOptions {
  readonly limit?: number;
  readonly rating?: number;
  readonly tag?: ServerReview['tags'][number];
  readonly sort?: ReviewSort;
}

export interface ReviewPageOptions extends ReviewListOptions {
  readonly cursor?: string;
}

export type ReviewPageResponse = ServerReviewPage;
export type ReviewFeedPageResponse = ServerReviewFeedPage;

export interface ReviewFeedPageOptions extends ReviewPageOptions {
  readonly visibility?: ReviewVisibilityFilter;
}

const REVIEW_TAG_SET = new Set(reviewTagSchema.options);
const REVIEW_VISIBILITY_SET = new Set(reviewVisibilitySchema.options);
const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(1).max(80),
  tags: z.array(reviewTagSchema).max(3)
});
const reviewReportReasonSchema = z.string().trim().min(3).max(500);
const adminReplyBodySchema = z.string().trim().max(300);
const legacyReviewCursorSchema = z.object({
  version: z.literal(1),
  sort: z.enum(['wilson', 'newest']),
  ratingFilter: z.number().int().min(1).max(5).nullable(),
  tagFilter: reviewTagSchema.nullable(),
  snapshotAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
  rating: z.number().int().min(1).max(5),
}).strict();
export function isReviewTag(
  value?: string | null
): value is ServerReview['tags'][number] {
  if (!value) {
    return false;
  }
  return REVIEW_TAG_SET.has(value as ServerReview['tags'][number]);
}

function toReviewAggregate(
  rows: Array<{ rating: number; _count: { _all: number } }>
): ServerReviewAggregate {
  const histogram: ServerReviewAggregate['histogram'] = {
    '1': 0,
    '2': 0,
    '3': 0,
    '4': 0,
    '5': 0
  };
  let total = 0;
  let ratingSum = 0;

  for (const row of rows) {
    const star = String(row.rating) as keyof typeof histogram;
    if (!(star in histogram)) {
      throw new InternalServerErrorException('유효하지 않은 공개 리뷰 평점이 있습니다.');
    }
    histogram[star] = row._count._all;
    total += row._count._all;
    ratingSum += row.rating * row._count._all;
  }

  return {
    total,
    average: total > 0 ? ratingSum / total : null,
    histogram
  };
}

@Injectable()
export class ReviewService {
  constructor(
    private readonly serverService: ServerService,
    private readonly events: BusinessEventService,
    private readonly voteStore: VoteStore,
    private readonly minecraft: MinecraftService,
    private readonly accounts: AccountSeparationService,
    private readonly prisma: PrismaService,
    @Optional() private readonly feedCursors: ReviewFeedCursorCodec = new ReviewFeedCursorCodec()
  ) {}

  async list(
    serverId: string,
    options: ReviewListOptions = {},
    viewerAccountId?: string
  ): Promise<ServerReview[]> {
    const page = await this.listPage(serverId, {
      ...options,
      limit: Math.min(Math.max(options.limit ?? 12, 1), 50),
    }, viewerAccountId);
    return page.items;
  }

  async listPage(
    serverId: string,
    options: ReviewPageOptions = {},
    viewerAccountId?: string
  ): Promise<ReviewPageResponse> {
    await this.serverService.ensureExists(serverId);
    const limit = Math.min(Math.max(options.limit ?? 12, 1), 50);
    const ratingFilter = options.rating && options.rating >= 1 && options.rating <= 5
      ? options.rating
      : null;
    const tagFilter = options.tag ?? null;
    const sort: ReviewSort = options.sort ?? 'wilson';
    const cursorBinding: ReviewFeedCursorBinding = {
      scope: 'public',
      serverId,
      subject: 'public',
      visibility: 'public',
      sort,
      ratingFilter,
      tagFilter,
    };
    const cursor = options.cursor
      ? this.decodePublicReviewCursor(options.cursor, cursorBinding)
      : null;
    const snapshotAt = cursor ? new Date(cursor.snapshotAt) : new Date();
    const position = cursor
      ? { id: cursor.id, rating: cursor.rating, createdAt: new Date(cursor.createdAt) }
      : null;

    const positionFilter: Prisma.ServerReviewWhereInput | undefined = position
      ? sort === 'newest'
        ? {
            OR: [
              { createdAt: { lt: position.createdAt } },
              { createdAt: position.createdAt, id: { lt: position.id } }
            ]
          }
        : {
            OR: [
              { rating: { lt: position.rating } },
              { rating: position.rating, createdAt: { lt: position.createdAt } },
              { rating: position.rating, createdAt: position.createdAt, id: { lt: position.id } }
            ]
          }
      : undefined;
    const publicSnapshotWhere = {
      serverId,
      visibility: 'public' as const,
      createdAt: { lte: snapshotAt },
      updatedAt: { lte: snapshotAt }
    };
    const [rows, aggregateRows] = await this.prisma.$transaction(async (transaction) => {
      const pageRows = await transaction.serverReview.findMany({
        where: {
          ...publicSnapshotWhere,
          rating: ratingFilter ?? undefined,
          tags: tagFilter ? { array_contains: [tagFilter] } : undefined,
          AND: positionFilter
        },
        orderBy: sort === 'newest'
          ? [{ createdAt: 'desc' }, { id: 'desc' }]
          : [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1
      });
      const ratingGroups = await transaction.serverReview.groupBy({
        by: ['rating'],
        where: publicSnapshotWhere,
        _count: { _all: true }
      });
      return [pageRows, ratingGroups] as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    const viewer = await this.resolveViewerReviewContext(
      viewerAccountId,
      pageRows.map((review) => review.id),
    );
    return {
      items: pageRows.map((review) =>
        toReviewResponse(
          review,
          viewer.accountIds,
          viewer.helpfulReviewIds.has(review.id),
          viewer.reportStatusByReviewId.get(review.id) ?? 'none',
        ),
      ),
      nextCursor: hasMore && last
        ? this.feedCursors.encode(cursorBinding, {
            snapshotAt: snapshotAt.toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
            rating: last.rating
          })
        : null,
      aggregate: toReviewAggregate(aggregateRows)
    };
  }

  async listStaffPage(
    serverId: string,
    viewerAccountId: string,
    options: ReviewFeedPageOptions = {}
  ): Promise<ReviewFeedPageResponse> {
    return this.listScopedFeedPage(serverId, viewerAccountId, 'staff', options);
  }

  async listMinePage(
    serverId: string,
    viewerAccountId: string,
    options: ReviewFeedPageOptions = {}
  ): Promise<ReviewFeedPageResponse> {
    return this.listScopedFeedPage(serverId, viewerAccountId, 'mine', options);
  }

  private async listScopedFeedPage(
    serverId: string,
    viewerAccountId: string,
    scope: Exclude<ReviewFeedScope, 'public'>,
    options: ReviewFeedPageOptions
  ): Promise<ReviewFeedPageResponse> {
    await this.serverService.ensureExists(serverId);
    const limit = Math.min(Math.max(options.limit ?? 12, 1), 50);
    const ratingFilter = options.rating && options.rating >= 1 && options.rating <= 5
      ? options.rating
      : null;
    const tagFilter = options.tag ?? null;
    const sort: ReviewSort = options.sort ?? 'newest';
    const visibility = options.visibility ?? 'all';
    const viewerGroup = await this.resolveAccountGroup(viewerAccountId);
    if (!viewerGroup) return { items: [], nextCursor: null };
    const cursorBinding: ReviewFeedCursorBinding = {
      scope,
      serverId,
      subject: viewerGroup.canonicalAccountId,
      visibility,
      sort,
      ratingFilter,
      tagFilter,
    };
    const cursor = options.cursor ? this.feedCursors.decode(options.cursor, cursorBinding) : null;
    const snapshotAt = cursor ? new Date(cursor.snapshotAt) : new Date();
    const positionFilter: Prisma.ServerReviewWhereInput | undefined = cursor
      ? sort === 'newest'
        ? {
          OR: [
            { createdAt: { lt: new Date(cursor.createdAt) } },
            { createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }
          ]
        }
        : {
            OR: [
              { rating: { lt: cursor.rating } },
              { rating: cursor.rating, createdAt: { lt: new Date(cursor.createdAt) } },
              { rating: cursor.rating, createdAt: new Date(cursor.createdAt), id: { lt: cursor.id } }
            ]
          }
      : undefined;
    const scopeWhere = {
        serverId,
        createdAt: { lte: snapshotAt },
        updatedAt: { lte: snapshotAt },
        visibility: visibility === 'all' ? undefined : visibility,
        authorAccountId: scope === 'mine' ? { in: [...viewerGroup.accountIds] } : undefined,
    } satisfies Prisma.ServerReviewWhereInput;
    const [rows, aggregateRows] = await this.prisma.$transaction(async (transaction) => {
      const pageRows = await transaction.serverReview.findMany({
        where: {
          ...scopeWhere,
          rating: ratingFilter ?? undefined,
          tags: tagFilter ? { array_contains: [tagFilter] } : undefined,
          AND: positionFilter,
        },
        orderBy: sort === 'newest'
          ? [{ createdAt: 'desc' }, { id: 'desc' }]
          : [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: limit + 1,
      });
      const ratingGroups = await transaction.serverReview.groupBy({
        by: ['rating'],
        where: scopeWhere,
        _count: { _all: true },
      });
      return [pageRows, ratingGroups] as const;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
    const hasMore = rows.length > limit;
    const reviews = rows.slice(0, limit);
    const last = reviews.at(-1);
    const viewer = await this.resolveViewerReviewContext(
      viewerAccountId,
      reviews.map((review) => review.id),
      viewerGroup.accountIds,
    );
    return {
      items: reviews.map((review) =>
        toReviewResponse(
          review,
          viewer.accountIds,
          viewer.helpfulReviewIds.has(review.id),
          viewer.reportStatusByReviewId.get(review.id) ?? 'none',
          scope === 'staff',
        ),
      ),
      nextCursor: hasMore && last
        ? this.feedCursors.encode(cursorBinding, {
            snapshotAt: snapshotAt.toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
            rating: last.rating,
          })
        : null,
      aggregate: toReviewAggregate(aggregateRows),
    };
  }

  private decodePublicReviewCursor(
    value: string,
    binding: ReviewFeedCursorBinding,
  ) {
    if (value.includes('.')) return this.feedCursors.decode(value, binding);
    try {
      const legacy = legacyReviewCursorSchema.parse(
        JSON.parse(Buffer.from(value, 'base64url').toString('utf8')),
      );
      if (
        legacy.sort !== binding.sort
        || legacy.ratingFilter !== binding.ratingFilter
        || legacy.tagFilter !== binding.tagFilter
      ) {
        throw new Error('binding');
      }
      return {
        snapshotAt: legacy.snapshotAt,
        createdAt: legacy.createdAt,
        id: legacy.id,
        rating: legacy.rating,
      };
    } catch {
      throw new BadRequestException('유효하지 않은 리뷰 페이지 커서입니다.');
    }
  }

  async create(
    serverId: string,
    payload: unknown,
    session: SessionPayload
  ): Promise<ServerReview> {
    await this.serverService.ensureExists(serverId);
    const parsed = createReviewSchema.parse(payload);
    const now = new Date();
    const account = await this.accounts.getAccount(session.userId);
    if (!account) {
      throw new ForbiddenException('계정 정보를 찾을 수 없습니다.');
    }

    let identity;
    try {
      identity = await this.minecraft.getStoredIdentity(session.userId);
    } catch {
      throw new ForbiddenException('Minecraft 소유권 인증이 필요합니다.');
    }

    const evidenceVote = await this.enforceVoteGate(serverId, identity.uuid, now);

    const verifiedAt = new Date(identity.lastVerifiedAt);
    if (
      Number.isNaN(verifiedAt.getTime()) ||
      verifiedAt.getTime() > now.getTime() ||
      now.getTime() - verifiedAt.getTime() > OWNERSHIP_VERIFICATION_MAX_AGE_MS
    ) {
      throw new ForbiddenException('Minecraft 소유권을 다시 인증해 주세요.');
    }

    const actualDisplayName = deriveDisplayName(account.displayName, account.providerUserId);
    const isAnonymous = parsed.anonymous ?? false;
    const visibility = normalizeVisibility(parsed.visibility);
    const authorDisplayName = isAnonymous ? '익명' : actualDisplayName;

    const outcome = await withCanonicalAccountGroups(this.prisma, [session.userId], async (transaction, groups) => {
      const group = groups[0];
      if (!group) throw new ForbiddenException('계정 정보를 찾을 수 없습니다.');
      await this.acquireReviewSubmissionGate(
        transaction,
        serverId,
        group.canonicalAccountId,
        group.accountIds,
        now
      );
      const created = await transaction.serverReview.create({
        data: {
          id: randomUUID(),
          serverId,
          authorAccountId: group.canonicalAccountId,
          authorDisplayName,
          rating: parsed.rating,
          body: parsed.body,
          tags: parsed.tags,
          visibility,
          isAnonymous,
          helpfulCount: 0,
          reports: 0,
          evidenceMinecraftUuid: identity.uuid,
          evidenceVoteId: evidenceVote.id ?? null,
          evidenceVerifiedAt: verifiedAt,
          evidencePolicyVersion: '2026-07-12-v1'
        }
      });
      if (visibility === 'public') {
        await transaction.server.update({
          where: { id: serverId },
          data: { reviewsCount: { increment: 1 } }
        });
      }
      return { review: created, accountIds: group.accountIds };
    });
    const review = outcome.review;

    void this.events.track('review.submitted', {
      serverId,
      reviewId: review.id,
      rating: review.rating,
      tags: normalizeReviewTags(review.tags),
      author: review.authorDisplayName
    });

    return toReviewResponse(review, outcome.accountIds);
  }

  async update(
    serverId: string,
    reviewId: string,
    payload: unknown,
    session: SessionPayload
  ): Promise<ServerReview> {
    const parsed = updateReviewSchema.parse(payload);
    const outcome = await withCanonicalAccountGroups(this.prisma, [session.userId], async (transaction, groups) => {
      const group = groups[0];
      const review = await transaction.serverReview.findFirst({ where: { id: reviewId, serverId } });
      if (!review) throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
      if (!group || !group.accountIds.includes(review.authorAccountId)) {
        throw new ForbiddenException('본인이 작성한 리뷰만 수정할 수 있습니다.');
      }
      const updated = await transaction.serverReview.update({
        where: { id: reviewId },
        data: { rating: parsed.rating, body: parsed.body, tags: parsed.tags }
      });
      return { updated, accountIds: group.accountIds };
    });

    return toReviewResponse(outcome.updated, outcome.accountIds);
  }

  async remove(
    serverId: string,
    reviewId: string,
    session: SessionPayload
  ): Promise<void> {
    await withCanonicalAccountGroups(this.prisma, [session.userId], async (transaction, groups) => {
      const group = groups[0];
      const review = await transaction.serverReview.findFirst({ where: { id: reviewId, serverId } });
      if (!review) throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
      if (!group || !group.accountIds.includes(review.authorAccountId)) {
        throw new ForbiddenException('본인이 작성한 리뷰만 삭제할 수 있습니다.');
      }
      const deleted = await transaction.serverReview.delete({ where: { id: reviewId } });
      if (deleted.visibility === 'public') {
        const counter = await transaction.server.updateMany({
          where: { id: serverId, reviewsCount: { gt: 0 } },
          data: { reviewsCount: { decrement: 1 } }
        });
        if (counter.count !== 1) {
          throw new InternalServerErrorException(
            '공개 리뷰 집계가 일치하지 않습니다. 데이터 검증 후 다시 시도해 주세요.',
          );
        }
      }
    });

  }

  async report(
    serverId: string,
    reviewId: string,
    reporterAccountId: string,
    reason: string,
  ): Promise<ServerReview> {
    const normalizedReason = reviewReportReasonSchema.parse(reason);
    const outcome = await withCanonicalAccountGroups(this.prisma, [reporterAccountId], async (transaction, groups) => {
      const group = groups[0];
      if (!group) throw new ForbiddenException('계정 정보를 찾을 수 없습니다.');
      const [review] = await transaction.$queryRaw<Array<{
        id: string;
        authorAccountId: string;
        updatedAt: Date;
      }>>(Prisma.sql`
        SELECT id, authorAccountId, updatedAt
        FROM ServerReview
        WHERE id = ${reviewId}
          AND serverId = ${serverId}
          AND visibility = 'public'
        FOR UPDATE
      `);
      if (!review) {
        throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
      }
      if (group.accountIds.includes(review.authorAccountId)) {
        throw new ForbiddenException('본인이 작성한 리뷰는 신고할 수 없습니다.');
      }
      const activeReport = await transaction.reviewReport.findFirst({
        where: {
          reviewId,
          accountId: { in: [...group.accountIds] },
          status: { in: ['open', 'in_review'] },
        },
        orderBy: [{ statusUpdatedAt: 'desc' }, { id: 'desc' }],
      });
      const latestFinalizedReport = activeReport
        ? null
        : await transaction.reviewReport.findFirst({
            where: {
              reviewId,
              accountId: { in: [...group.accountIds] },
              status: { in: ['resolved', 'dismissed'] },
            },
            orderBy: [{ statusUpdatedAt: 'desc' }, { id: 'desc' }],
          });
      const mayCreateCase = !activeReport
        && (!latestFinalizedReport || review.updatedAt > latestFinalizedReport.statusUpdatedAt);
      if (mayCreateCase) {
        await transaction.reviewReport.create({
          data: {
            reviewId,
            accountId: group.canonicalAccountId,
            reason: normalizedReason,
            status: 'open',
            statusUpdatedAt: new Date(),
          }
        });
        await transaction.serverReview.update({
          where: { id: reviewId },
          data: { reports: { increment: 1 } }
        });
      }
      const updated = await transaction.serverReview.findUnique({ where: { id: reviewId } });
      return {
        created: mayCreateCase,
        createdAfterFinalizedCase: mayCreateCase && Boolean(latestFinalizedReport),
        updated,
        actorAccountId: group.canonicalAccountId,
        accountIds: group.accountIds,
      };
    });

    const updated = outcome.updated;
    if (!updated) {
      throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
    }
    if (outcome.created) {
      await this.events.audit('review.report.created', {
        category: 'review',
        severity: 'warning',
        actorAccountId: outcome.actorAccountId,
        subjectType: 'review_report',
        subjectId: reviewId,
        metadata: {
          serverId,
          reviewId,
          createdAfterFinalizedCase: outcome.createdAfterFinalizedCase,
        },
      });
    }
    const viewer = await this.resolveViewerReviewContext(
      reporterAccountId,
      [reviewId],
      outcome.accountIds,
    );
    return toReviewResponse(
      updated,
      viewer.accountIds,
      viewer.helpfulReviewIds.has(reviewId),
      viewer.reportStatusByReviewId.get(reviewId) ?? 'none',
    );
  }

  async setAdminReply(
    serverId: string,
    reviewId: string,
    responderName: string,
    body: string,
    viewerAccountId?: string
  ): Promise<ServerReview> {
    const review = await this.prisma.serverReview.findFirst({
      where: { id: reviewId, serverId }
    });
    if (!review) {
      throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
    }

    const trimmed = adminReplyBodySchema.parse(body);
    const updated = await this.prisma.serverReview.update({
      where: { id: reviewId },
      data: trimmed.length === 0
        ? {
            adminReplyBody: null,
            adminReplyAuthor: null,
            adminReplyCreatedAt: null
          }
        : {
            adminReplyBody: trimmed,
            adminReplyAuthor: responderName,
            adminReplyCreatedAt: new Date()
          }
    });

    const viewer = await this.resolveViewerReviewContext(viewerAccountId, [reviewId]);
    return toReviewResponse(updated, viewer.accountIds, viewer.helpfulReviewIds.has(reviewId));
  }

  async markHelpful(
    serverId: string,
    reviewId: string,
    voterAccountId: string,
    isHelpful: boolean
  ): Promise<ServerReview> {
    const now = new Date();
    const outcome = await withCanonicalAccountGroups(this.prisma, [voterAccountId], async (transaction, groups) => {
      const group = groups[0];
      if (!group) throw new ForbiddenException('계정 정보를 찾을 수 없습니다.');
      const lockedReviews = await transaction.$queryRaw<Array<{ id: string; authorAccountId: string }>>`
        SELECT id, authorAccountId
        FROM ServerReview
        WHERE id = ${reviewId} AND serverId = ${serverId} AND visibility = 'public'
        FOR UPDATE
      `;
      if (lockedReviews.length !== 1) {
        throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
      }
      if (group.accountIds.includes(lockedReviews[0]!.authorAccountId)) {
        throw new ForbiddenException('본인이 작성한 리뷰에는 도움표시를 할 수 없습니다.');
      }

      const existing = await transaction.reviewHelpfulVote.findFirst({
        where: { reviewId, accountId: { in: [...group.accountIds] } }
      });
      if (existing && now.getTime() - existing.lastMarkedAt.getTime() < HELPFUL_COOLDOWN_MS) {
        throw new ForbiddenException('잠시 후 다시 시도해주세요. (도움표시 쿨다운)');
      }

      if (existing) {
        await transaction.reviewHelpfulVote.update({
          where: { id: existing.id },
          data: {
            isHelpful,
            lastMarkedAt: now
          }
        });
      } else {
        await transaction.reviewHelpfulVote.create({
          data: {
            reviewId,
            accountId: group.canonicalAccountId,
            isHelpful,
            lastMarkedAt: now
          }
        });
      }

      const helpfulCount = await transaction.reviewHelpfulVote.count({
        where: { reviewId, isHelpful: true }
      });
      const updated = await transaction.serverReview.update({
        where: { id: reviewId },
        data: { helpfulCount }
      });
      return { updated, accountIds: group.accountIds };
    });

    const viewer = await this.resolveViewerReviewContext(
      voterAccountId,
      [reviewId],
      outcome.accountIds,
    );
    return toReviewResponse(
      outcome.updated,
      outcome.accountIds,
      isHelpful,
      viewer.reportStatusByReviewId.get(reviewId) ?? 'none',
    );
  }

  async getGateStatus(serverId: string, session?: SessionPayload): Promise<ReviewGateStatus> {
    await this.serverService.ensureExists(serverId);
    if (!session) {
      return {
        isLoggedIn: false,
        isMinecraftOwned: false,
        hasRecentVote: false,
        lastVoteAt: null,
        nextEligibleVoteAt: null,
        displayName: null,
        minecraftUuid: null
      };
    }

    const account = await this.accounts.getAccount(session.userId);
    if (!account) {
      return {
        isLoggedIn: false,
        isMinecraftOwned: false,
        hasRecentVote: false,
        lastVoteAt: null,
        nextEligibleVoteAt: null,
        displayName: null,
        minecraftUuid: null
      };
    }

    const displayName = deriveDisplayName(account.displayName, account.providerUserId);

    let identityUuid: string | null = null;
    try {
      const identity = await this.minecraft.getStoredIdentity(session.userId);
      const verifiedAt = new Date(identity.lastVerifiedAt);
      if (
        Number.isNaN(verifiedAt.getTime()) ||
        verifiedAt.getTime() > Date.now() ||
        Date.now() - verifiedAt.getTime() > OWNERSHIP_VERIFICATION_MAX_AGE_MS
      ) {
        throw new Error('stale minecraft ownership verification');
      }
      identityUuid = identity.uuid;
    } catch {
      return {
        isLoggedIn: true,
        isMinecraftOwned: false,
        hasRecentVote: false,
        lastVoteAt: null,
        nextEligibleVoteAt: null,
        displayName,
        minecraftUuid: null
      };
    }

    const now = new Date();
    const [lastVote, globalLastVote] = identityUuid
      ? await Promise.all([
          this.voteStore.getLastVoteForMinecraft(serverId, identityUuid),
          this.voteStore.getLastVoteForMinecraftGlobal(identityUuid)
        ])
      : [undefined, undefined];
    const recent = lastVote
      ? now.getTime() - lastVote.votedAt.getTime() <= RECENT_VOTE_WINDOW_MS
      : false;
    const nextEligible =
      globalLastVote && isSameKstDay(globalLastVote.votedAt, now)
        ? getNextKstResetAt(now).toISOString()
        : null;

    return {
      isLoggedIn: true,
      isMinecraftOwned: true,
      hasRecentVote: recent,
      lastVoteAt: lastVote ? lastVote.votedAt.toISOString() : null,
      nextEligibleVoteAt: nextEligible,
      displayName,
      minecraftUuid: identityUuid
    };
  }

  private async enforceVoteGate(
    serverId: string,
    minecraftUuid: string,
    now: Date
  ): Promise<VoteRecord> {
    const lastVote = await this.voteStore.getLastVoteForMinecraft(serverId, minecraftUuid);
    if (!lastVote) {
      throw new ForbiddenException('최근 투표 기록이 확인되지 않습니다.');
    }

    if (lastVote.votedAt.getTime() > now.getTime()) {
      throw new ForbiddenException('미래 시간의 투표 기록은 유효하지 않습니다.');
    }

    if (now.getTime() - lastVote.votedAt.getTime() > RECENT_VOTE_WINDOW_MS) {
      throw new ForbiddenException('최근 24시간 내 투표 기록이 필요합니다.');
    }

    return lastVote;
  }

  private async acquireReviewSubmissionGate(
    transaction: Prisma.TransactionClient,
    serverId: string,
    authorAccountId: string,
    accountIds: readonly string[],
    now: Date
  ): Promise<void> {
    const cutoff = new Date(now.getTime() - REVIEW_COOLDOWN_MS);
    const gates = await transaction.reviewSubmissionGate.findMany({
      where: { serverId, authorAccountId: { in: [...accountIds] } },
      orderBy: { lastSubmittedAt: 'desc' }
    });
    if (gates[0] && gates[0].lastSubmittedAt > cutoff) {
      throw new ForbiddenException('이미 최근에 리뷰를 작성했습니다. 잠시 후 다시 시도해주세요.');
    }
    await transaction.reviewSubmissionGate.deleteMany({
      where: { serverId, authorAccountId: { in: [...accountIds] } }
    });
    await transaction.reviewSubmissionGate.create({ data: { serverId, authorAccountId, lastSubmittedAt: now } });
  }

  private async resolveAccountGroupIds(accountId?: string): Promise<readonly string[]> {
    if (!accountId) return [];
    return withCanonicalAccountGroups(this.prisma, [accountId], async (_transaction, groups) =>
      groups[0]?.accountIds ?? []
    );
  }

  private async resolveAccountGroup(accountId: string): Promise<{
    readonly canonicalAccountId: string;
    readonly accountIds: readonly string[];
  } | null> {
    return withCanonicalAccountGroups(this.prisma, [accountId], async (_transaction, groups) => {
      const group = groups[0];
      return group
        ? { canonicalAccountId: group.canonicalAccountId, accountIds: group.accountIds }
        : null;
    });
  }

  private async resolveViewerReviewContext(
    accountId: string | undefined,
    reviewIds: readonly string[],
    resolvedAccountIds?: readonly string[],
  ): Promise<{
    readonly accountIds: readonly string[];
    readonly helpfulReviewIds: ReadonlySet<string>;
    readonly reportStatusByReviewId: ReadonlyMap<string, ServerReview['viewerReportStatus']>;
  }> {
    const accountIds = resolvedAccountIds ?? await this.resolveAccountGroupIds(accountId);
    if (accountIds.length === 0 || reviewIds.length === 0) {
      return {
        accountIds,
        helpfulReviewIds: new Set<string>(),
        reportStatusByReviewId: new Map(),
      };
    }
    const uniqueReviewIds = [...new Set(reviewIds)];
    const [helpfulVotes, reports] = await Promise.all([
      this.prisma.reviewHelpfulVote.findMany({
        where: {
          reviewId: { in: uniqueReviewIds },
          accountId: { in: [...accountIds] },
          isHelpful: true,
        },
        select: { reviewId: true },
      }),
      this.prisma.reviewReport.findMany({
        where: {
          reviewId: { in: uniqueReviewIds },
          accountId: { in: [...accountIds] },
        },
        select: {
          reviewId: true,
          status: true,
          statusUpdatedAt: true,
          review: { select: { updatedAt: true } },
        },
        orderBy: [{ statusUpdatedAt: 'desc' }, { id: 'desc' }],
      }),
    ]);
    const reportStatusByReviewId = new Map<string, ServerReview['viewerReportStatus']>();
    for (const report of reports) {
      const current = reportStatusByReviewId.get(report.reviewId);
      const isActive = ['open', 'in_review'].includes(report.status);
      if (current && ['open', 'in_review'].includes(current)) continue;
      if (current && !isActive) continue;
      const wasEditedAfterFinalization = ['resolved', 'dismissed'].includes(report.status)
        && report.review.updatedAt > report.statusUpdatedAt;
      reportStatusByReviewId.set(
        report.reviewId,
        wasEditedAfterFinalization ? 'none' : report.status,
      );
    }
    return {
      accountIds,
      helpfulReviewIds: new Set(helpfulVotes.map((vote) => vote.reviewId)),
      reportStatusByReviewId,
    };
  }
}

function deriveDisplayName(displayName?: string | null, fallback?: string | null): string {
  if (displayName && displayName.trim().length > 0) {
    return displayName.trim().slice(0, 24);
  }
  if (fallback && fallback.trim().length > 0) {
    return fallback.trim().slice(0, 24);
  }
  return '플레이어';
}

function normalizeVisibility(visibility?: string): ServerReview['visibility'] {
  if (visibility && REVIEW_VISIBILITY_SET.has(visibility as ServerReview['visibility'])) {
    return visibility as ServerReview['visibility'];
  }
  return 'public';
}

function getKstDayStartUtc(date: Date): Date {
  const dayMs = 24 * 60 * 60 * 1000;
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const shifted = date.getTime() + kstOffsetMs;
  const startShifted = Math.floor(shifted / dayMs) * dayMs;
  return new Date(startShifted - kstOffsetMs);
}

function getNextKstResetAt(date: Date): Date {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = getKstDayStartUtc(date);
  return new Date(start.getTime() + dayMs);
}

function isSameKstDay(left: Date, right: Date): boolean {
  return getKstDayStartUtc(left).getTime() === getKstDayStartUtc(right).getTime();
}

function toReviewResponse(review: {
  id: string;
  serverId: string;
  authorAccountId: string;
  authorDisplayName: string;
  rating: number;
  body: string;
  tags: Prisma.JsonValue;
  helpfulCount: number;
  reports: number;
  visibility: ServerReview['visibility'];
  isAnonymous: boolean;
  adminReplyBody: string | null;
  adminReplyAuthor: string | null;
  adminReplyCreatedAt: Date | null;
  createdAt: Date;
  evidenceMinecraftUuid?: string | null;
  evidenceVoteId?: string | null;
  evidenceVerifiedAt?: Date | null;
  evidencePolicyVersion?: string | null;
}, viewerAccountIds: readonly string[] = [], viewerHelpful = false,
viewerReportStatus: ServerReview['viewerReportStatus'] = 'none',
includeModerationCounts = false): ServerReview {
  const tags = normalizeReviewTags(review.tags);
  const adminReplyAuthor = normalizeAdminReplyAuthor(review.adminReplyAuthor);
  return {
    id: review.id,
    serverId: review.serverId,
    authorDisplayName: review.authorDisplayName,
    rating: review.rating,
    body: review.body,
    tags,
    trustLabels:
      review.evidenceMinecraftUuid && review.evidenceVoteId && review.evidenceVerifiedAt
        ? ['ms_owned', 'vote_ack']
        : [],
    helpfulCount: review.helpfulCount,
    viewerHelpful,
    viewerReportStatus,
    reportCount: includeModerationCounts ? review.reports : undefined,
    visibility: review.visibility,
    isAnonymous: review.isAnonymous,
    adminReply: review.adminReplyBody
      ? {
          authorDisplayName: adminReplyAuthor,
          body: review.adminReplyBody,
          createdAt: review.adminReplyCreatedAt
            ? review.adminReplyCreatedAt.toISOString()
            : new Date().toISOString()
        }
      : null,
    createdAt: review.createdAt.toISOString(),
    canManage: viewerAccountIds.includes(review.authorAccountId)
  };
}

function normalizeAdminReplyAuthor(author: string | null): string {
  const trimmed = author?.trim();
  if (!trimmed) {
    return ADMIN_REPLY_AUTHOR_FALLBACK;
  }
  if (CORRUPTED_ADMIN_REPLY_AUTHORS.has(trimmed)) {
    return ADMIN_REPLY_AUTHOR_FALLBACK;
  }
  return trimmed;
}

function normalizeReviewTags(value: Prisma.JsonValue | null | undefined): ServerReview['tags'] {
  if (!value) {
    return [];
  }
  const items = Array.isArray(value) ? value : [];
  return items.filter((item): item is ServerReview['tags'][number] => {
    return typeof item === 'string' && isReviewTag(item);
  });
}
