import { ForbiddenException, Injectable, NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  createReviewSchema,
  reviewTagSchema,
  reviewVisibilitySchema,
  type ReviewGateStatus,
  type ServerReview
} from '@creepervote/schemas';
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
const WILSON_Z = 1.96;
const HELPFUL_COOLDOWN_MS = 1000 * 60 * 5; // 5분
const ADMIN_REPLY_AUTHOR_FALLBACK = '운영진';
const CORRUPTED_ADMIN_REPLY_AUTHORS = new Set(['?댁쁺吏?']);

export type ReviewSort = 'wilson' | 'newest';

export interface ReviewListOptions {
  readonly limit?: number;
  readonly rating?: number;
  readonly tag?: ServerReview['tags'][number];
  readonly sort?: ReviewSort;
}

const REVIEW_TAG_SET = new Set(reviewTagSchema.options);
const REVIEW_VISIBILITY_SET = new Set(reviewVisibilitySchema.options);
const updateReviewSchema = z.object({
  rating: z.number().int().min(1).max(5),
  body: z.string().trim().min(1).max(80),
  tags: z.array(reviewTagSchema).max(3)
});

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

  async listAll(serverId: string, viewerAccountId?: string): Promise<ServerReview[]> {
    await this.serverService.ensureExists(serverId);
    const reviews = await this.prisma.serverReview.findMany({
      where: { serverId },
      orderBy: { createdAt: 'desc' }
    });
    return reviews.map((review) => toReviewResponse(review, viewerAccountId));
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
      identity = await this.minecraft.getIdentity(session.userId);
    } catch {
      throw new ForbiddenException('Minecraft 소유권 인증이 필요합니다.');
    }

    await this.enforceVoteGate(serverId, identity.uuid, now);

    const lastReview = await this.prisma.serverReview.findFirst({
      where: {
        serverId,
        authorAccountId: session.userId
      },
      orderBy: { createdAt: 'desc' }
    });
    if (lastReview && now.getTime() - lastReview.createdAt.getTime() < REVIEW_COOLDOWN_MS) {
      throw new ForbiddenException('이미 최근에 리뷰를 작성했습니다. 잠시 후 다시 시도해주세요.');
    }

    const actualDisplayName = deriveDisplayName(account.displayName, account.providerUserId);
    const isAnonymous = parsed.anonymous ?? false;
    const visibility = normalizeVisibility(parsed.visibility);
    const authorDisplayName = isAnonymous ? '익명' : actualDisplayName;

    const review = await this.prisma.serverReview.create({
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
        reports: 0
      }
    });

    await this.serverService.incrementReviewCount(serverId);

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

    await this.prisma.$transaction([
      this.prisma.serverReview.delete({ where: { id: reviewId } }),
      this.prisma.server.updateMany({
        where: {
          id: serverId,
          reviewsCount: { gt: 0 }
        },
        data: {
          reviewsCount: { decrement: 1 }
        }
      })
    ]);

  }

  async report(serverId: string, reviewId: string, reporterAccountId: string): Promise<ServerReview> {
    const review = await this.prisma.serverReview.findFirst({
      where: { id: reviewId, serverId }
    });
    if (!review) {
      throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
    }

    try {
      await this.prisma.reviewReport.create({
        data: {
          reviewId,
          accountId: reporterAccountId
        }
      });
      await this.prisma.serverReview.update({
        where: { id: reviewId },
        data: { reports: { increment: 1 } }
      });
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
    const review = await this.prisma.serverReview.findFirst({
      where: { id: reviewId, serverId }
    });
    if (!review) {
      throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
    }

    const now = new Date();
    const existing = await this.prisma.reviewHelpfulVote.findUnique({
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

    let delta = 0;
    if (!existing && isHelpful) {
      delta = 1;
    } else if (existing && existing.isHelpful && !isHelpful) {
      delta = -1;
    } else if (existing && !existing.isHelpful && isHelpful) {
      delta = 1;
    }

    await this.prisma.$transaction([
      existing
        ? this.prisma.reviewHelpfulVote.update({
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
          })
        : this.prisma.reviewHelpfulVote.create({
            data: {
              reviewId,
              accountId: voterAccountId,
              isHelpful,
              lastMarkedAt: now
            }
          }),
      delta !== 0
        ? this.prisma.serverReview.update({
            where: { id: reviewId },
            data: { helpfulCount: { increment: delta } }
          })
        : this.prisma.serverReview.update({
            where: { id: reviewId },
            data: {}
          })
    ]);

    const updated = await this.prisma.serverReview.findUnique({
      where: { id: reviewId }
    });
    if (!updated) {
      throw new NotFoundException(`Review ${reviewId} not found for server ${serverId}`);
    }

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
      const identity = await this.minecraft.getIdentity(session.userId);
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
    trustLabels: ['ms_owned', 'vote_ack'],
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
