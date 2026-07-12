import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException
} from '@nestjs/common';
import { z } from 'zod';
import { ServerService } from '../server/server.service';
import { VoteQueueService } from './vote.queue';
import {
  voteDispatchJobSchema,
  type VoteDispatchTarget,
} from '@minewiki/schemas';
import { CaptchaService } from '../captcha/captcha.service';
import { BusinessEventService } from '../events/business-event.service';
import { VoteStore } from './vote.store';
import { PrismaService } from '../common/prisma.service';

const votePayloadSchema = z.object({
  username: z.string().trim().min(3).max(16),
  captchaToken: z.string().trim().min(1).optional(),
  agreeTerms: z.boolean().optional(),
  agreePrivacy: z.boolean().optional()
});

export interface VoteRequestContext {
  readonly accountId?: string;
  readonly minecraftUuid?: string;
  readonly ipAddress?: string;
}

export interface VoteModerationQuery {
  readonly serverId?: string;
  readonly status?: 'valid' | 'invalid';
  readonly search?: string;
  readonly limit: number;
}

interface StoredVotifierTargetReference {
  readonly targetId: string;
  readonly protocol: 'v1' | 'v2';
}

@Injectable()
export class VoteService {
  private readonly logger = new Logger(VoteService.name);
  private readonly captchaRequired: boolean;

  constructor(
    private readonly serverService: ServerService,
    private readonly voteQueue: VoteQueueService,
    private readonly captchaService: CaptchaService,
    private readonly events: BusinessEventService,
    private readonly voteStore: VoteStore,
    private readonly prisma: PrismaService
  ) {
    this.captchaRequired = this.captchaService.isCaptchaRequired();
  }

  async submitVote(
    serverId: string,
    rawPayload: unknown,
    context: VoteRequestContext = {}
  ) {
    const server = await this.serverService.ensureExists(serverId);

    const parsedPayload = votePayloadSchema.safeParse(rawPayload);
    if (!parsedPayload.success) {
      throw new BadRequestException('닉네임을 3~16자 사이로 입력해 주세요.');
    }
    const payload = parsedPayload.data;
    if (!payload.agreeTerms || !payload.agreePrivacy) {
      throw new BadRequestException('이용약관과 개인정보 처리방침에 동의해 주세요.');
    }
    await this.verifyCaptchaToken(payload.captchaToken, context.ipAddress);
    const normalizedUsername = payload.username;

    if (server.voteRequiresOwnership && !context.minecraftUuid) {
      throw new ForbiddenException(
        '인증된 플레이어만 투표할 수 있습니다. 로그인 후 /me에서 계정을 인증해주세요.'
      );
    }

    const now = new Date();
    const nextKstResetAt = getNextKstResetAt(now);
    const playerKey = derivePlayerKey(normalizedUsername, context);

    const previousVote = context.minecraftUuid
      ? await this.voteStore.getLastVoteForMinecraftGlobal(context.minecraftUuid)
      : context.accountId
        ? await this.voteStore.getLastVoteForAccountGlobal(context.accountId)
        : await this.voteStore.getLastVoteForUsernameGlobal(normalizedUsername);

    if (previousVote && isSameKstDay(previousVote.votedAt, now)) {
      throw new ForbiddenException(
        `이미 투표가 등록되었습니다. 다음 투표 가능 시간: ${nextKstResetAt.toISOString()}`
      );
    }

    if (context.ipAddress) {
      const lastIpVote = await this.voteStore.getLastVoteForIpGlobal(context.ipAddress);
      if (lastIpVote && isSameKstDay(lastIpVote.votedAt, now)) {
        throw new ForbiddenException(
          `같은 네트워크에서 오늘 이미 투표가 진행되었습니다. 다음 가능 시간: ${nextKstResetAt.toISOString()}`
        );
      }
    }

    const targets = await this.resolveVotifierTargets(serverId);
    const dispatchTargets: VoteDispatchTarget[] = [];
    const vote = await this.prisma.$transaction(async (tx) => {
      const createdVote = await tx.vote.create({
        data: {
          serverId,
          username: normalizedUsername,
          usernameNormalized: normalizedUsername.toLowerCase(),
          ipAddress: context.ipAddress ?? null,
          accountId: context.accountId ?? null,
          minecraftUuid: context.minecraftUuid ?? null,
          votedAt: now
        }
      });

      for (const target of targets) {
        const attempt = await tx.voteDispatchAttempt.create({
          data: {
            voteId: createdVote.id,
            serverId,
            targetId: target.targetId,
            protocol: target.protocol,
            status: 'queued'
          }
        });
        dispatchTargets.push({
          targetId: target.targetId,
          dispatchAttemptId: attempt.id
        });
      }

      await tx.server.update({
        where: { id: serverId },
        data: {
          votes24h: { increment: 1 },
          votesMonthly: server.votesMonthly === null ? 1 : { increment: 1 }
        }
      });

      await tx.serverStats.upsert({
        where: { serverId },
        create: {
          serverId,
          rankCurrent: 1,
          rankDelta24h: 0,
          rankBest: 1,
          votesLast24h: 1,
          votesLast7d: 1,
          votesMonthToDate: 1,
          votesTotal: 1,
          playersOnline: 0,
          playersMax: 0,
          uptimePercent: 0,
          sparkline: [],
          latencyMs: 0
        },
        update: {
          votesLast24h: { increment: 1 },
          votesLast7d: { increment: 1 },
          votesMonthToDate: { increment: 1 },
          votesTotal: { increment: 1 }
        }
      });

      return createdVote;
    });

    this.logger.log({ serverId, voteId: vote.id }, 'Vote accepted');

    if (dispatchTargets.length > 0) {
      try {
        const job = voteDispatchJobSchema.parse({
          voteId: vote.id,
          serverId,
          targets: dispatchTargets
        });
        await this.voteQueue.enqueue(job);
      } catch (error) {
        await this.markDispatchEnqueueFailed(
          dispatchTargets.map((target) => target.dispatchAttemptId),
          error
        );
        this.logger.error(
          {
            err: error,
            serverId
          },
          'Vote dispatch enqueue failed'
        );
      }
    }

    try {
      await this.events.track('vote.submitted', {
        serverId,
        username: normalizedUsername,
        voterKey: playerKey,
        ipAddress: context.ipAddress ?? undefined
      });
    } catch (error) {
      this.logger.error(
        { err: error, serverId },
        'Failed to track vote.submitted event'
      );
    }

    return {
      acknowledged: true,
      nextEligibleAt: nextKstResetAt.toISOString(),
      votesToday: await this.voteStore.getDailyCount(serverId, now)
    };
  }

  async listDispatchAttempts(
    serverId: string
  ): Promise<{
    recent: VoteDispatchAttemptSummary[];
    failed: VoteDispatchAttemptSummary[];
  }> {
    await this.serverService.ensureExists(serverId);
    const [recent, failed] = await Promise.all([
      this.prisma.voteDispatchAttempt.findMany({
        where: { serverId },
        include: {
          vote: { select: { username: true, votedAt: true } },
          target: { select: { host: true, port: true } }
        },
        orderBy: { createdAt: 'desc' },
        take: 20
      }),
      this.prisma.voteDispatchAttempt.findMany({
        where: {
          serverId,
          status: 'failed',
          vote: {
            dispatchAttempts: {
              none: { status: 'success' }
            }
          }
        },
        include: {
          vote: { select: { username: true, votedAt: true } },
          target: { select: { host: true, port: true } }
        },
        orderBy: [{ lastAttemptAt: 'desc' }, { createdAt: 'desc' }],
        take: 20
      })
    ]);
    return {
      recent: recent.map(toDispatchAttemptSummary),
      failed: failed.map(toDispatchAttemptSummary)
    };
  }

  async replayDispatchAttempt(serverId: string, attemptId: string): Promise<{ queued: true }> {
    await this.serverService.ensureExists(serverId);
    const attempt = await this.prisma.voteDispatchAttempt.findFirst({
      where: { id: attemptId, serverId },
      include: {
        vote: true,
        target: true
      }
    });
    if (!attempt) {
      throw new BadRequestException('투표 전달 기록을 찾을 수 없습니다.');
    }
    if (attempt.status !== 'failed') {
      throw new BadRequestException('실패한 투표 전달만 재시도할 수 있습니다.');
    }
    const succeededAttempts = await this.prisma.voteDispatchAttempt.count({
      where: { voteId: attempt.voteId, status: 'success' }
    });
    if (succeededAttempts > 0) {
      throw new BadRequestException('이미 성공한 투표 전달은 재시도할 수 없습니다.');
    }
    if (!attempt.target) {
      throw new BadRequestException('삭제된 Votifier 대상은 재시도할 수 없습니다.');
    }

    const target = toStoredVotifierTargetReference(attempt.target);
    if (!target) {
      throw new BadRequestException('재시도 가능한 Votifier 인증 정보가 없습니다.');
    }

    await this.prisma.voteDispatchAttempt.update({
      where: { id: attempt.id },
      data: {
        status: 'queued',
        error: null
      }
    });

    try {
      await this.voteQueue.enqueue(
        voteDispatchJobSchema.parse({
          voteId: attempt.voteId,
          serverId,
          targets: [
            {
              targetId: target.targetId,
              dispatchAttemptId: attempt.id
            }
          ]
        })
      );
    } catch (error) {
      await this.markDispatchEnqueueFailed([attempt.id], error);
      throw error;
    }

    return { queued: true };
  }

  async listRecentVotes(
    serverId: string,
    options: { limit?: number; search?: string } = {}
  ): Promise<Array<{ username: string; votedAt: string }>> {
    await this.serverService.ensureExists(serverId);
    const limit = Math.min(Math.max(options.limit ?? 100, 1), 200);
    const search = options.search?.trim();
    const votes = await this.prisma.vote.findMany({
      where: {
        serverId,
        status: 'valid',
        usernameNormalized: search ? { contains: search.toLowerCase() } : undefined
      },
      orderBy: { votedAt: 'desc' },
      take: limit
    });
    return votes.map((vote) => ({
      username: vote.username,
      votedAt: vote.votedAt.toISOString()
    }));
  }

  async invalidateVote(voteId: string, actorAccountId: string, reason: string) {
    const normalizedReason = reason.trim();
    const vote = await this.prisma.vote.findUnique({
      where: { id: voteId },
      select: { id: true, serverId: true, status: true },
    });
    if (!vote) {
      throw new NotFoundException('투표를 찾을 수 없습니다.');
    }
    if (vote.status !== 'valid') {
      throw new BadRequestException('이미 무효 처리된 투표입니다.');
    }

    const invalidatedAt = new Date();
    const restrictedReviews = await this.prisma.$transaction(async (transaction) => {
      const result = await transaction.vote.updateMany({
        where: { id: voteId, status: 'valid' },
        data: {
          status: 'invalid',
          invalidatedAt,
          invalidatedBy: actorAccountId,
          invalidationReason: normalizedReason,
        },
      });
      if (result.count !== 1) {
        throw new BadRequestException('투표 상태가 변경되어 다시 확인해야 합니다.');
      }
      const reviews = await transaction.serverReview.updateMany({
        where: { evidenceVoteId: voteId, visibility: 'public' },
        data: { visibility: 'staff' },
      });
      return reviews.count;
    });

    await this.refreshVoteCounters(vote.serverId);

    await this.events.audit('vote.invalidated', {
      category: 'vote',
      severity: 'warning',
      actorAccountId,
      subjectType: 'vote',
      subjectId: voteId,
      metadata: {
        serverId: vote.serverId,
        reason: normalizedReason,
        restrictedReviews,
      },
    });
    return {
      id: voteId,
      serverId: vote.serverId,
      status: 'invalid' as const,
      rankRecalculationPending: true,
    };
  }

  async listVotesForModeration(query: VoteModerationQuery) {
    const search = query.search?.toLowerCase();
    const votes = await this.prisma.vote.findMany({
      where: {
        serverId: query.serverId,
        status: query.status,
        OR: search
          ? [
              { usernameNormalized: { contains: search } },
              { ipAddress: { contains: query.search } },
              { accountId: query.search },
              { minecraftUuid: query.search },
            ]
          : undefined,
      },
      orderBy: { votedAt: 'desc' },
      take: query.limit,
      select: {
        id: true,
        serverId: true,
        accountId: true,
        minecraftUuid: true,
        username: true,
        ipAddress: true,
        votedAt: true,
        status: true,
        invalidatedAt: true,
        invalidatedBy: true,
        invalidationReason: true,
      },
    });
    return votes.map((vote) => ({
      ...vote,
      votedAt: vote.votedAt.toISOString(),
      invalidatedAt: vote.invalidatedAt?.toISOString() ?? null,
    }));
  }

  private async refreshVoteCounters(serverId: string): Promise<void> {
    const now = new Date();
    const last24h = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    const last7d = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    const monthStart = startOfMonthKst(now);
    const valid = { serverId, status: 'valid' } as const;
    const [votesLast24h, votesLast7d, votesMonthToDate, votesTotal] = await Promise.all([
      this.prisma.vote.count({ where: { ...valid, votedAt: { gte: last24h } } }),
      this.prisma.vote.count({ where: { ...valid, votedAt: { gte: last7d } } }),
      this.prisma.vote.count({ where: { ...valid, votedAt: { gte: monthStart } } }),
      this.prisma.vote.count({ where: valid }),
    ]);
    await this.prisma.$transaction([
      this.prisma.server.update({
        where: { id: serverId },
        data: { votes24h: votesLast24h, votesMonthly: votesMonthToDate },
      }),
      this.prisma.serverStats.updateMany({
        where: { serverId },
        data: { votesLast24h, votesLast7d, votesMonthToDate, votesTotal },
      }),
    ]);
  }

  private async verifyCaptchaToken(token?: string | null, ipAddress?: string): Promise<void> {
    if (!this.captchaRequired) {
      return;
    }
    const result = await this.captchaService.verifyCaptcha(token, ipAddress);
    if (!result.success) {
      this.logger.warn({ errors: result.errors }, 'CAPTCHA 검증 실패');
      throw new ForbiddenException('CAPTCHA 검증에 실패했습니다. 새로고침 후 다시 시도해주세요.');
    }
    this.logger.debug('CAPTCHA 토큰 검증 완료.');
  }

  private async resolveVotifierTargets(serverId: string): Promise<StoredVotifierTargetReference[]> {
    const targets = await this.prisma.votifierTarget.findMany({
      where: { serverId },
      orderBy: { createdAt: 'asc' }
    });
    return targets
      .map(toStoredVotifierTargetReference)
      .filter((target): target is StoredVotifierTargetReference => Boolean(target));
  }

  private async markDispatchEnqueueFailed(attemptIds: string[], error: unknown): Promise<void> {
    if (attemptIds.length === 0) {
      return;
    }
    await this.prisma.voteDispatchAttempt.updateMany({
      where: { id: { in: attemptIds } },
      data: {
        status: 'failed',
        error: truncateDispatchError(error)
      }
    });
  }
}

export interface VoteDispatchAttemptSummary {
  readonly id: string;
  readonly voteId: string;
  readonly serverId: string;
  readonly targetId: string | null;
  readonly protocol: 'v1' | 'v2';
  readonly status: string;
  readonly attempts: number;
  readonly error: string | null;
  readonly lastAttemptAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly username: string;
  readonly votedAt: string;
  readonly target: {
    readonly host: string | null;
    readonly port: number | null;
  };
}

function toStoredVotifierTargetReference(target: {
  id: string;
  protocol: 'v1' | 'v2';
  host: string;
  port: number;
  token?: string | null;
  publicKey?: string | null;
}): StoredVotifierTargetReference | null {
  if (target.protocol === 'v2') {
    return target.token ? { targetId: target.id, protocol: 'v2' } : null;
  }
  return target.publicKey ? { targetId: target.id, protocol: 'v1' } : null;
}

function toDispatchAttemptSummary(attempt: {
  id: string;
  voteId: string;
  serverId: string;
  targetId: string | null;
  protocol: 'v1' | 'v2';
  status: string;
  attempts: number;
  error: string | null;
  lastAttemptAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  vote: { username: string; votedAt: Date };
  target: { host: string; port: number } | null;
}): VoteDispatchAttemptSummary {
  return {
    id: attempt.id,
    voteId: attempt.voteId,
    serverId: attempt.serverId,
    targetId: attempt.targetId,
    protocol: attempt.protocol,
    status: attempt.status,
    attempts: attempt.attempts,
    error: attempt.error,
    lastAttemptAt: attempt.lastAttemptAt?.toISOString() ?? null,
    createdAt: attempt.createdAt.toISOString(),
    updatedAt: attempt.updatedAt.toISOString(),
    username: attempt.vote.username,
    votedAt: attempt.vote.votedAt.toISOString(),
    target: {
      host: attempt.target?.host ?? null,
      port: attempt.target?.port ?? null
    }
  };
}

function truncateDispatchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}

function derivePlayerKey(username: string, context: VoteRequestContext): string {
  if (context.minecraftUuid) {
    return `uuid:${context.minecraftUuid}`;
  }
  if (context.accountId) {
    return `acct:${context.accountId}`;
  }
  return `user:${username.toLowerCase()}`;
}

function getKstDayStartUtc(date: Date): Date {
  const dayMs = 24 * 60 * 60 * 1000;
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const shifted = date.getTime() + kstOffsetMs;
  const startShifted = Math.floor(shifted / dayMs) * dayMs;
  return new Date(startShifted - kstOffsetMs);
}

function startOfMonthKst(date: Date): Date {
  const kstOffsetMs = 9 * 60 * 60 * 1000;
  const shifted = new Date(date.getTime() + kstOffsetMs);
  return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), 1) - kstOffsetMs);
}

function getNextKstResetAt(date: Date): Date {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = getKstDayStartUtc(date);
  return new Date(start.getTime() + dayMs);
}

function isSameKstDay(left: Date, right: Date): boolean {
  return getKstDayStartUtc(left).getTime() === getKstDayStartUtc(right).getTime();
}
