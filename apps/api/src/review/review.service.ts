import { BadRequestException, ForbiddenException, Injectable, InternalServerErrorException, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createReviewSchema,
  reviewTagSchema,
  reviewVisibilitySchema,
  type ReviewGateStatus,
  type ServerReview
} from '@minewiki/schemas';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { ServerService } from '../server/server.service';
import { BusinessEventService } from '../events/business-event.service';
import { VoteStore, type VoteRecord } from '../vote/vote.store';
import { MinecraftService } from '../minecraft/minecraft.service';
import { AccountSeparationService } from '../auth/account-separation.service';
import type { SessionPayload } from '../session/session.service';

const REVIEW_COOLDOWN_MS = 1000 * 60 * 60 * 24; // 24시간
const RECENT_VOTE_WINDOW_MS = 1000 * 60 * 60 * 24; // 24시간 내 투표 필요
const OWNERSHIP_VERIFICATION_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 180; // 180일
const WILSON_Z = 1.96;
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

export interface ReviewPageResponse {
  readonly items: ServerReview[];
  readonly nextCursor: string | null;
}

const REVIEW_TAG_SET = new Set(reviewTagSchema.options);
const REVIEW_VISIBILITY_SET = new Set(reviewVisibilitySchema.options);
const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(1).max(80),
  tags: z.array(reviewTagSchema).max(3)
});
const reviewReportReasonSchema = z.string().trim().min(3).max(500);
const reviewCursorSchema = z.object({
  version: z.literal(1),
  sort: z.enum(['wilson', 'newest']),
  ratingFilter: z.number().int().min(1).max(5).nullable(),
  tagFilter: reviewTagSchema.nullable(),
  snapshotAt: z.string().datetime(),
  createdAt: z.string().datetime(),
  id: z.string().uuid(),
  rating: z.number().int().min(1).max(5)
}).strict();

type ReviewCursor = z.infer<typeof reviewCursorSchema>;

export function isReviewTag(
  value?: string | null
): value is ServerReview['tags'][number] {
  if (!value) {
    return false;
  }
  return REVIEW_TAG_SET.has(value as ServerReview['tags'][number]);
}

function calculateWilsonScore(rating: number): number {
  const positive = Math.max(0, Math.min(5, rating));
  const total = 5;
  const p = positive / total;
  const z = WILSON_Z;
  const denominator = 1 + (z * z) / total;
  const centreAdjustment = (z * z) / (2 * total);
  const adjustedStandardDeviation = z * Math.sqrt((p * (1 - p) + (z * z) / (4 * total)) / total);
  return Math.max(0, (p + centreAdjustment - adjustedStandardDeviation) / denominator);
}

@Injectable()
export class ReviewService {
  constructor(
    private readonly serverService: ServerService,
    private readonly events: BusinessEventService,
    private readonly voteStore: VoteStore,
    private readonly minecraft: MinecraftService,
    private readonly accounts: AccountSeparationService,
    private readonly prisma: PrismaService
  ) {}

  async list(
    serverId: string,
    options: ReviewListOptions = {},
    viewerAccountId?: string
  ): Promise<ServerReview[]> {
    await this.serverService.ensureExists(serverId);

    const ratingFilter = options.rating && options.rating >= 1 && options.rating <= 5
      ? options.rating
      : undefined;
    const tagFilter = options.tag;
    const sortMode: ReviewSort = options.sort ?? 'wilson';

    const reviews = await this.prisma.serverReview.findMany({
      where: {
        serverId,
        visibility: 'public',
        rating: ratingFilter
      },
      orderBy: {
        createdAt: 'desc'
      }
    });

    const filtered = tagFilter
      ? reviews.filter((review) => normalizeReviewTags(review.tags).includes(tagFilter))
      : reviews;
    const mapped = filtered.map((review) => toReviewResponse(review, viewerAccountId));
    const sorted = sortMode === 'wilson'
      ? [...mapped].sort((a, b) => {
          const diff = calculateWilsonScore(b.rating) - calculateWilsonScore(a.rating);
          if (Math.abs(diff) > Number.EPSILON) {
            return diff > 0 ? 1 : -1;
          }
          return Date.parse(b.createdAt) - Date.parse(a.createdAt);
        })
      : mapped;

    if (options.limit && options.limit > 0) {
      return sorted.slice(0, options.limit);
    }
    return sorted;
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
    const cursor = options.cursor
      ? this.decodeReviewCursor(options.cursor, { sort, ratingFilter, tagFilter })
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
    const rows = await this.prisma.serverReview.findMany({
      where: {
        serverId,
        visibility: 'public',
        createdAt: { lte: snapshotAt },
        updatedAt: { lte: snapshotAt },
        rating: ratingFilter ?? undefined,
        tags: tagFilter ? { array_contains: [tagFilter] } : undefined,
        AND: positionFilter
      },
      orderBy: sort === 'newest'
        ? [{ createdAt: 'desc' }, { id: 'desc' }]
        : [{ rating: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
      take: limit + 1
    });
    const hasMore = rows.length > limit;
    const pageRows = rows.slice(0, limit);
    const last = pageRows.at(-1);
    return {
      items: pageRows.map((review) => toReviewResponse(review, viewerAccountId)),
      nextCursor: hasMore && last
        ? this.encodeReviewCursor({
            version: 1,
            sort,
            ratingFilter,
            tagFilter,
            snapshotAt: snapshotAt.toISOString(),
            createdAt: last.createdAt.toISOString(),
            id: last.id,
            rating: last.rating
          })
        : null
    };
  }

  async listAll(serverId: string, viewerAccountId?: string): Promise<ServerReview[]> {
    await this.serverService.ensureExists(serverId);
    const reviews = await this.prisma.serverReview.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' }
    });
    return reviews.map((review) => toReviewResponse(review, viewerAccountId));
  }

  private encodeReviewCursor(cursor: ReviewCursor): string {
    return Buffer.from(JSON.stringify(cursor), 'utf8').toString('base64url');
  }

  private decodeReviewCursor(
    encoded: string,
    filters: Pick<ReviewCursor, 'sort' | 'ratingFilter' | 'tagFilter'>
  ): ReviewCursor {
    let cursor: ReviewCursor;
    try {
      cursor = reviewCursorSchema.parse(JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')));
    } catch {
      throw new BadRequestException('유효하지 않은 리뷰 페이지 커서입니다.');
    }
    if (
      cursor.sort !== filters.sort ||
      cursor.ratingFilter !== filters.ratingFilter ||
      cursor.tagFilter !== filters.tagFilter
    ) {
      throw new BadRequestException('리뷰 필터가 변경되어 페이지를 이어갈 수 없습니다.');
    }
    return cursor;
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

    const review = await this.prisma.$transaction(async (transaction) => {
      await this.acquireReviewSubmissionGate(
        transaction,
        serverId,
        session.userId,
        now
      );
      const created = await transaction.serverReview.create({
        data: {
          id: randomUUID(),
          serverId,
          authorAccountId: session.userId,
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
      return created;
    });

    void this.events.track('review.submitted', {
      serverId,
      reviewId: review.id,
      rating: review.rating,
      tags: normalizeReviewTags(review.tags),
      author: review.authorDisplayName
    });

    return toReviewResponse(review, session.userId);
  }

  async update(
    serverId: string,
    reviewId: string,
    payload: unknown,
    session: SessionPayload
  ): Promise<ServerReview> {
    const review = await this.prisma.serverReview.findFirst({
      where: { id: reviewId, serverId }
    });
    if (!review) {
      throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
    }
    if (review.authorAccountId !== session.userId) {
      throw new ForbiddenException('본인이 작성한 리뷰만 수정할 수 있습니다.');
    }

    const parsed = updateReviewSchema.parse(payload);
    const updated = await this.prisma.serverReview.update({
      where: { id: reviewId },
      data: {
        rating: parsed.rating,
        body: parsed.body,
        tags: parsed.tags
      }
    });

    return toReviewResponse(updated, session.userId);
  }

  async remove(
    serverId: string,
    reviewId: string,
    session: SessionPayload
  ): Promise<void> {
    const review = await this.prisma.serverReview.findFirst({
      where: { id: reviewId, serverId }
    });
    if (!review) {
      throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
    }
    if (review.authorAccountId !== session.userId) {
      throw new ForbiddenException('본인이 작성한 리뷰만 삭제할 수 있습니다.');
    }

    await this.prisma.$transaction(async (transaction) => {
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
    const review = await this.prisma.serverReview.findFirst({
      where: { id: reviewId, serverId }
    });
    if (!review) {
      throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
    }

    let created = false;
    try {
      await this.prisma.$transaction(async (transaction) => {
        await transaction.reviewReport.create({
          data: {
            reviewId,
            accountId: reporterAccountId,
            reason: normalizedReason,
            status: 'open',
            statusUpdatedAt: new Date(),
          }
        });
        await transaction.serverReview.update({
          where: { id: reviewId },
          data: { reports: { increment: 1 } }
        });
      });
      created = true;
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        // Duplicate report; ignore.
      } else {
        throw error;
      }
    }

    const updated = await this.prisma.serverReview.findUnique({
      where: { id: reviewId }
    });
    if (!updated) {
      throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
    }
    if (created) {
      await this.events.audit('review.report.created', {
        category: 'review',
        severity: 'warning',
        actorAccountId: reporterAccountId,
        subjectType: 'review_report',
        subjectId: reviewId,
        metadata: { serverId, reviewId },
      });
    }
    return toReviewResponse(updated, reporterAccountId);
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

    const trimmed = body.trim();
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

    return toReviewResponse(updated, viewerAccountId);
  }

  async markHelpful(
    serverId: string,
    reviewId: string,
    voterAccountId: string,
    isHelpful: boolean
  ): Promise<ServerReview> {
    const now = new Date();
    const updated = await this.prisma.$transaction(async (transaction) => {
      const lockedReviews = await transaction.$queryRaw<Array<{ id: string }>>`
        SELECT id
        FROM ServerReview
        WHERE id = ${reviewId} AND serverId = ${serverId}
        FOR UPDATE
      `;
      if (lockedReviews.length !== 1) {
        throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
      }

      const existing = await transaction.reviewHelpfulVote.findUnique({
        where: {
          reviewId_accountId: {
            reviewId,
            accountId: voterAccountId
          }
        }
      });
      if (existing && now.getTime() - existing.lastMarkedAt.getTime() < HELPFUL_COOLDOWN_MS) {
        throw new ForbiddenException('잠시 후 다시 시도해주세요. (도움표시 쿨다운)');
      }

      if (existing) {
        await transaction.reviewHelpfulVote.update({
          where: {
            reviewId_accountId: {
              reviewId,
              accountId: voterAccountId
            }
          },
          data: {
            isHelpful,
            lastMarkedAt: now
          }
        });
      } else {
        await transaction.reviewHelpfulVote.create({
          data: {
            reviewId,
            accountId: voterAccountId,
            isHelpful,
            lastMarkedAt: now
          }
        });
      }

      const helpfulCount = await transaction.reviewHelpfulVote.count({
        where: { reviewId, isHelpful: true }
      });
      return transaction.serverReview.update({
        where: { id: reviewId },
        data: { helpfulCount }
      });
    });

    return toReviewResponse(updated, voterAccountId);
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
    now: Date
  ): Promise<void> {
    const cutoff = new Date(now.getTime() - REVIEW_COOLDOWN_MS);
    const refreshed = await transaction.reviewSubmissionGate.updateMany({
      where: { serverId, authorAccountId, lastSubmittedAt: { lte: cutoff } },
      data: { lastSubmittedAt: now }
    });
    if (refreshed.count === 1) {
      return;
    }
    try {
      await transaction.reviewSubmissionGate.create({
        data: { serverId, authorAccountId, lastSubmittedAt: now }
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ForbiddenException('이미 최근에 리뷰를 작성했습니다. 잠시 후 다시 시도해주세요.');
      }
      throw error;
    }
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
}, viewerAccountId?: string): ServerReview {
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
    reports: review.reports,
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
    canManage: Boolean(viewerAccountId && viewerAccountId === review.authorAccountId)
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
