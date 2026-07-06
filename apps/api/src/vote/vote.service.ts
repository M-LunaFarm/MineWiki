import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger
} from '@nestjs/common';
import { z } from 'zod';
import { ServerService } from '../server/server.service';
import { VoteQueueService } from './vote.queue';
import { voteDispatchJobSchema, type VotifierTarget } from '@minewiki/schemas';
import { CaptchaService } from '../captcha/captcha.service';
import { BusinessEventService } from '../events/business-event.service';
import { VoteStore } from './vote.store';
import { PrismaService } from '../common/prisma.service';
import { decryptAppSecret } from '../common/secret-codec';

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

    await this.prisma.$transaction(async (tx) => {
      await tx.vote.create({
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
    });

    this.logger.log(
      `Vote accepted for ${serverId} by ${normalizedUsername} (ip=${context.ipAddress ?? 'n/a'})`
    );

    const targets = await this.resolveVotifierTargets(serverId);
    if (targets.length > 0) {
      try {
        const job = voteDispatchJobSchema.parse({
          serverId,
          username: normalizedUsername,
          ipAddress: context.ipAddress,
          votedAt: now.toISOString(),
          targets
        });
        await this.voteQueue.enqueue(job);
      } catch (error) {
        this.logger.error(
          {
            err: error,
            serverId,
            username: normalizedUsername
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
        { err: error, serverId, username: normalizedUsername },
        'Failed to track vote.submitted event'
      );
    }

    return {
      acknowledged: true,
      nextEligibleAt: nextKstResetAt.toISOString(),
      votesToday: await this.voteStore.getDailyCount(serverId, now)
    };
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

  private async verifyCaptchaToken(token?: string | null, ipAddress?: string): Promise<void> {
    if (!this.captchaRequired) {
      return;
    }
    const result = await this.captchaService.verifyCaptcha(token, ipAddress);
    if (!result.success) {
      this.logger.warn({ errors: result.errors, ipAddress }, 'CAPTCHA 검증 실패');
      throw new ForbiddenException('CAPTCHA 검증에 실패했습니다. 새로고침 후 다시 시도해주세요.');
    }
    this.logger.debug('CAPTCHA 토큰 검증 완료.');
  }

  private async resolveVotifierTargets(serverId: string): Promise<VotifierTarget[]> {
    const targets = await this.prisma.votifierTarget.findMany({
      where: { serverId },
      orderBy: { createdAt: 'asc' }
    });
    return targets
      .map((target) => {
        const protocol: VotifierTarget['protocol'] = target.protocol === 'v1' ? 'v1' : 'v2';
        return {
          protocol,
          host: target.host,
          port: target.port,
          token: decryptAppSecret(target.token) ?? undefined,
          publicKey: target.publicKey ?? undefined
        };
      })
      .filter((target) =>
        target.protocol === 'v2' ? Boolean(target.token) : Boolean(target.publicKey)
      );
  }
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

function getNextKstResetAt(date: Date): Date {
  const dayMs = 24 * 60 * 60 * 1000;
  const start = getKstDayStartUtc(date);
  return new Date(start.getTime() + dayMs);
}

function isSameKstDay(left: Date, right: Date): boolean {
  return getKstDayStartUtc(left).getTime() === getKstDayStartUtc(right).getTime();
}
