import {
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { Queue } from 'bullmq';
import type { Prisma } from '@prisma/client';
import { ConfigService } from '@minewiki/config';
import { normalizeMinecraftUuid } from '@minewiki/minecraft';
import type {
  DiscordVerifyCompleteRequest,
  DiscordVerifySessionCreateRequest,
  DiscordVerifySessionResponse,
  DiscordVerifySyncJob,
  PluginSyncEvent
} from '@minewiki/schemas';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';

const VERIFY_SESSION_TTL_MS = 1000 * 60 * 15;

@Injectable()
export class VerifyService {
  private readonly syncQueue: Queue<DiscordVerifySyncJob> | null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events: BusinessEventService
  ) {
    const redisUrl = this.config.getOptional('REDIS_URL');
    this.syncQueue = redisUrl
      ? new Queue<DiscordVerifySyncJob>('discord-verify-sync', {
          connection: { url: redisUrl },
          defaultJobOptions: {
            attempts: 5,
            backoff: { type: 'exponential', delay: 1000 },
            removeOnComplete: 100,
            removeOnFail: 500
          }
        })
      : null;
  }

  assertInternalBotToken(headerValue: string | undefined): void {
    const expected = this.config.getOptional('INTERNAL_BOT_API_TOKEN');
    if (!expected || headerValue !== `Bearer ${expected}`) {
      throw new UnauthorizedException('Internal bot token is invalid.');
    }
  }

  assertPluginSyncToken(headerValue: string | undefined): void {
    const expected = this.config.getOptional('PLUGIN_SYNC_TOKEN');
    if (!expected || headerValue !== `Bearer ${expected}`) {
      throw new UnauthorizedException('Plugin sync token is invalid.');
    }
  }

  async createDiscordSession(
    payload: DiscordVerifySessionCreateRequest
  ): Promise<DiscordVerifySessionResponse> {
    const expiresAt = new Date(Date.now() + VERIFY_SESSION_TTL_MS);
    const baseUrl =
      this.config.getOptional('VERIFY_PUBLIC_BASE_URL') ??
      this.config.getOptional('NEXT_PUBLIC_SITE_URL') ??
      'https://minewiki.kr';

    const created = await this.prisma.discordVerificationSession.create({
      data: {
        guildId: payload.guildId,
        channelId: payload.channelId,
        requesterDiscordId: payload.requesterDiscordId,
        roleId: payload.roleId ?? null,
        nicknameTemplate: payload.nicknameTemplate ?? null,
        expiresAt,
        eventLog: [
          {
            type: 'created',
            at: new Date().toISOString(),
            requesterDiscordId: payload.requesterDiscordId
          }
        ]
      }
    });
    const verificationUrl = this.buildVerificationUrl(baseUrl, created.id);
    await this.prisma.discordVerificationSession.update({
      where: { id: created.id },
      data: { verificationUrl }
    });

    await this.events.track('discord.verify.session.created', {
      sessionId: created.id,
      guildId: payload.guildId,
      requesterDiscordId: payload.requesterDiscordId
    });

    return {
      sessionId: created.id,
      status: 'pending',
      verificationUrl,
      expiresAt: expiresAt.toISOString()
    };
  }

  async getDiscordSession(sessionId: string): Promise<DiscordVerifySessionResponse> {
    const session = await this.prisma.discordVerificationSession.findUnique({
      where: { id: sessionId }
    });
    if (!session) {
      throw new NotFoundException('Discord verification session not found.');
    }
    const status = this.normalizeStatus(session.status, session.expiresAt);
    return {
      sessionId: session.id,
      status,
      verificationUrl: session.verificationUrl ?? this.buildVerificationUrl('https://minewiki.kr', session.id),
      expiresAt: session.expiresAt.toISOString()
    };
  }

  async completeDiscordSession(
    sessionId: string,
    accountId: string,
    payload: DiscordVerifyCompleteRequest
  ): Promise<DiscordVerifySessionResponse> {
    const session = await this.prisma.discordVerificationSession.findUnique({
      where: { id: sessionId }
    });
    if (!session) {
      throw new NotFoundException('Discord verification session not found.');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      await this.prisma.discordVerificationSession.update({
        where: { id: session.id },
        data: { status: 'expired' }
      });
      throw new ForbiddenException('Discord verification session expired.');
    }

    const minecraftUuid = normalizeMinecraftUuid(payload.minecraftUuid);
    const updated = await this.prisma.discordVerificationSession.update({
      where: { id: session.id },
      data: {
        status: 'sync_pending',
        accountId,
        minecraftUuid,
        minecraftName: payload.playerName ?? null,
        completedAt: new Date(),
        eventLog: [
          ...(Array.isArray(session.eventLog) ? session.eventLog : []),
          {
            type: 'completed',
            at: new Date().toISOString(),
            accountId,
            minecraftUuid
          }
        ]
      }
    });

    await this.events.track('discord.verify.completed', {
      sessionId: updated.id,
      accountId,
      discordUserId: updated.requesterDiscordId,
      minecraftUuid
    });

    await this.enqueueDiscordSync({
      sessionId: updated.id,
      guildId: updated.guildId,
      discordUserId: updated.requesterDiscordId,
      accountId,
      minecraftUuid,
      playerName: payload.playerName,
      roleId: updated.roleId ?? undefined,
      nicknameTemplate: updated.nicknameTemplate ?? undefined
    });

    return {
      sessionId: updated.id,
      status: 'sync_pending',
      verificationUrl: updated.verificationUrl ?? this.buildVerificationUrl('https://minewiki.kr', updated.id),
      expiresAt: updated.expiresAt.toISOString()
    };
  }

  async recordPluginSync(event: PluginSyncEvent): Promise<{ id: string; accepted: true }> {
    const minecraftUuid = normalizeMinecraftUuid(event.minecraftUuid);
    const data: {
      serverId: string | null;
      pluginServerId: string | null;
      discordUserId: string | null;
      minecraftUuid: string;
      playerName: string | null;
      action: string;
      payload?: Prisma.InputJsonValue;
    } = {
      serverId: event.serverId ?? null,
      pluginServerId: event.pluginServerId ?? null,
      discordUserId: event.discordUserId ?? null,
      minecraftUuid,
      playerName: event.playerName ?? null,
      action: event.action
    };
    if (event.payload) {
      data.payload = JSON.parse(JSON.stringify(event.payload)) as Prisma.InputJsonValue;
    }
    const created = await this.prisma.serverPluginSyncEvent.create({
      data
    });
    await this.events.track('plugin.sync.received', {
      serverId: event.serverId,
      minecraftUuid,
      action: event.action
    });
    return { id: created.id, accepted: true };
  }

  private async enqueueDiscordSync(job: DiscordVerifySyncJob): Promise<void> {
    if (!this.syncQueue) {
      await this.prisma.discordVerificationSession.update({
        where: { id: job.sessionId },
        data: {
          status: 'linked',
          lastSyncStatus: 'queue_unavailable'
        }
      });
      return;
    }
    await this.syncQueue.add('sync', job, { jobId: `discord-verify:${job.sessionId}` });
  }

  private buildVerificationUrl(baseUrl: string, sessionId: string): string {
    const url = new URL('/me', baseUrl);
    url.searchParams.set('verifySessionId', sessionId);
    return url.toString();
  }

  private normalizeStatus(status: string, expiresAt: Date): DiscordVerifySessionResponse['status'] {
    if (expiresAt.getTime() < Date.now() && status === 'pending') {
      return 'expired';
    }
    if (
      status === 'pending' ||
      status === 'linked' ||
      status === 'sync_pending' ||
      status === 'synced' ||
      status === 'failed' ||
      status === 'expired'
    ) {
      return status;
    }
    return 'pending';
  }
}
