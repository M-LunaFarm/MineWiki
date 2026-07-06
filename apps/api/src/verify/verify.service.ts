import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  UnauthorizedException
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
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
    const now = new Date();
    const baseUrl =
      this.config.getOptional('VERIFY_PUBLIC_BASE_URL') ??
      this.config.getOptional('NEXT_PUBLIC_SITE_URL') ??
      'https://minewiki.kr';
    const completionToken = createCompletionToken();
    const completionTokenHash = hashCompletionToken(completionToken);

    await this.ensureGuildChannel(payload.guildId, payload.channelId, now);
    const options = await this.resolveGuildVerificationOptions(payload.guildId, payload.channelId, {
      roleId: payload.roleId,
      nicknameTemplate: payload.nicknameTemplate
    });
    const created = await this.prisma.discordVerificationSession.create({
      data: {
        guildId: payload.guildId,
        channelId: payload.channelId,
        requesterDiscordId: payload.requesterDiscordId,
        roleId: options.roleId ?? null,
        nicknameTemplate: options.nicknameTemplate ?? null,
        completionTokenHash,
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
    const verificationUrl = this.buildVerificationUrl(baseUrl, created.id, completionToken);
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
      verificationUrl: this.publicVerificationUrl(session.verificationUrl, session.id),
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
    if (session.status !== 'pending') {
      throw new ConflictException('Discord verification session is already completed.');
    }
    if (session.expiresAt.getTime() < Date.now()) {
      await this.prisma.discordVerificationSession.update({
        where: { id: session.id },
        data: { status: 'expired' }
      });
      throw new ForbiddenException('Discord verification session expired.');
    }
    this.assertCompletionToken(session.completionTokenHash, payload.completionToken);

    const minecraftUuid = normalizeMinecraftUuid(payload.minecraftUuid);
    const minecraftName = payload.playerName ?? minecraftUuid.replace(/-/g, '').slice(0, 16);
    await this.assertDiscordVerifyLinkConflicts(session, accountId, minecraftUuid);
    const result = await this.prisma.discordVerificationSession.updateMany({
      where: { id: session.id, status: 'pending' },
      data: {
        status: 'sync_pending',
        accountId,
        minecraftUuid,
        minecraftName,
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
    if (result.count !== 1) {
      throw new ConflictException('Discord verification session is already completed.');
    }
    const updated = await this.prisma.discordVerificationSession.findUnique({
      where: { id: session.id }
    });
    if (!updated) {
      throw new NotFoundException('Discord verification session not found.');
    }

    await this.persistDiscordVerification(updated, accountId, minecraftUuid, minecraftName);

    await this.events.track('discord.verify.completed', {
      sessionId: updated.id,
      accountId,
      discordUserId: updated.requesterDiscordId,
      minecraftUuid
    });

    const syncOptions = await this.resolveGuildVerificationOptions(
      updated.guildId,
      updated.channelId,
      {
        roleId: updated.roleId ?? undefined,
        nicknameTemplate: updated.nicknameTemplate ?? undefined
      }
    );
    await this.enqueueDiscordSync({
      action: 'link',
      sessionId: updated.id,
      guildId: updated.guildId,
      discordUserId: updated.requesterDiscordId,
      accountId,
      minecraftUuid,
      playerName: minecraftName,
      roleId: syncOptions.roleId,
      nicknameTemplate: syncOptions.nicknameTemplate,
      dmTemplate: syncOptions.dmTemplate,
      logChannelId: syncOptions.logChannelId,
      logMessageTemplate: syncOptions.logMessageTemplate
    });

    return {
      sessionId: updated.id,
      status: 'sync_pending',
      verificationUrl: this.publicVerificationUrl(updated.verificationUrl, updated.id),
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

  async revokeDiscordVerification(input: {
    readonly guildId: string;
    readonly discordUserId: string;
    readonly reason?: string;
  }): Promise<{ guildId: string; discordUserId: string; status: 'revoked' }> {
    const current = await this.prisma.lunaGuildVerification.findUnique({
      where: {
        guildId_discordUserId: {
          guildId: input.guildId,
          discordUserId: input.discordUserId
        }
      }
    });
    if (!current) {
      throw new NotFoundException('Guild verification not found.');
    }
    const now = new Date();
    await this.prisma.$transaction([
      this.prisma.lunaGuildVerification.update({
        where: {
          guildId_discordUserId: {
            guildId: input.guildId,
            discordUserId: input.discordUserId
          }
        },
        data: {
          status: 'revoked',
          verifiedAt: now
        }
      }),
      this.prisma.lunaEvent.create({
        data: {
          eventId: createLunaId(),
          eventType: 'minecraft_revoked',
          guildId: input.guildId,
          channelId: null,
          discordUserId: input.discordUserId,
          minecraftUuid: current.minecraftUuid,
          minecraftName: current.minecraftUuid.replace(/-/g, '').slice(0, 16),
          occurredAt: now.toISOString(),
          payloadJson: toJsonValue({ reason: input.reason ?? 'api_revoke' }),
          createdAt: now
        }
      })
    ]);
    await this.events.track('discord.verify.revoked', {
      guildId: input.guildId,
      discordUserId: input.discordUserId
    });
    return {
      guildId: input.guildId,
      discordUserId: input.discordUserId,
      status: 'revoked'
    };
  }

  async listGuilds(): Promise<LunaGuildResponse[]> {
    const guilds = await this.prisma.lunaGuild.findMany({
      orderBy: [{ updatedAt: 'desc' }],
      take: 100
    });
    return guilds.map((guild) => this.toGuildResponse(guild));
  }

  async getGuild(guildId: string): Promise<LunaGuildDetailResponse> {
    const guild = await this.prisma.lunaGuild.findUnique({ where: { guildId } });
    if (!guild) {
      throw new NotFoundException('Guild not found.');
    }
    const [channels, verificationCount, actionProfiles] = await Promise.all([
      this.prisma.lunaGuildChannelSetting.findMany({
        where: { guildId },
        orderBy: [{ updatedAt: 'desc' }],
        take: 100
      }),
      this.prisma.lunaGuildVerification.count({ where: { guildId, status: 'verified' } }),
      this.prisma.lunaActionProfile.findMany({
        where: { guildId },
        orderBy: [{ updatedAt: 'desc' }],
        take: 100
      })
    ]);
    return {
      ...this.toGuildResponse(guild),
      verificationCount,
      channels: channels.map((channel) => this.toChannelResponse(channel)),
      actionProfiles: actionProfiles.map((profile) => ({
        profileId: profile.profileId,
        channelId: profile.channelId,
        name: profile.name,
        triggerEvent: profile.triggerEvent,
        enabled: profile.enabled,
        updatedAt: profile.updatedAt.toISOString()
      }))
    };
  }

  async updateGuildSettings(
    guildId: string,
    input: LunaGuildSettingsRequest
  ): Promise<LunaGuildResponse | LunaGuildChannelResponse> {
    const now = new Date();
    const data = {
      verifiedRoleId: input.verifiedRoleId ?? null,
      logChannelId: input.logChannelId ?? null,
      nicknameFormat: input.nicknameFormat ?? null,
      botMessageTemplate: input.botMessageTemplate ?? null,
      botMessagePayload: input.botMessagePayload
        ? toJsonValue(input.botMessagePayload)
        : Prisma.JsonNull,
      verifyReplyPayload: input.verifyReplyPayload
        ? toJsonValue(input.verifyReplyPayload)
        : Prisma.JsonNull,
      policyJson: input.policyJson ? toJsonValue(input.policyJson) : Prisma.JsonNull,
      updatedAt: now
    };
    if (input.channelId) {
      const channel = await this.prisma.lunaGuildChannelSetting.upsert({
        where: {
          guildId_channelId: {
            guildId,
            channelId: input.channelId
          }
        },
        create: {
          guildId,
          channelId: input.channelId,
          ...data,
          createdAt: now
        },
        update: data
      });
      await this.ensureGuild(guildId, now);
      return this.toChannelResponse(channel);
    }
    const guild = await this.prisma.lunaGuild.upsert({
      where: { guildId },
      create: {
        guildId,
        ...data,
        createdAt: now
      },
      update: data
    });
    return this.toGuildResponse(guild);
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

  private async persistDiscordVerification(
    session: {
      id: string;
      guildId: string;
      channelId: string;
      requesterDiscordId: string;
    },
    accountId: string,
    minecraftUuid: string,
    minecraftName: string
  ): Promise<void> {
    const now = new Date();
    await this.ensureGuild(session.guildId, now);
    await this.prisma.$transaction([
      this.prisma.minecraftIdentity.upsert({
        where: { accountId },
        create: {
          accountId,
          uuid: minecraftUuid,
          playerName: minecraftName,
          msOwned: true,
          lastVerifiedAt: now
        },
        update: {
          uuid: minecraftUuid,
          playerName: minecraftName,
          msOwned: true,
          lastVerifiedAt: now
        }
      }),
      this.prisma.lunaDiscordAccountLink.upsert({
        where: { discordUserId: session.requesterDiscordId },
        create: {
          discordUserId: session.requesterDiscordId,
          minecraftUuid,
          minecraftName,
          lastVerifiedAt: now,
          updatedAt: now
        },
        update: {
          minecraftUuid,
          minecraftName,
          lastVerifiedAt: now,
          updatedAt: now
        }
      }),
      this.prisma.lunaGuildVerification.upsert({
        where: {
          guildId_discordUserId: {
            guildId: session.guildId,
            discordUserId: session.requesterDiscordId
          }
        },
        create: {
          guildId: session.guildId,
          discordUserId: session.requesterDiscordId,
          minecraftUuid,
          status: 'verified',
          verifiedAt: now
        },
        update: {
          minecraftUuid,
          status: 'verified',
          verifiedAt: now
        }
      }),
      this.prisma.lunaPrivacyConsent.upsert({
        where: {
          discordUserId_consentType: {
            discordUserId: session.requesterDiscordId,
            consentType: 'minecraft_verify'
          }
        },
        create: {
          discordUserId: session.requesterDiscordId,
          consentType: 'minecraft_verify',
          consentedAt: now,
          updatedAt: now
        },
        update: {
          consentedAt: now,
          updatedAt: now
        }
      }),
      this.prisma.lunaEvent.create({
        data: {
          eventId: createLunaId(),
          eventType: 'minecraft_verified',
          guildId: session.guildId,
          channelId: session.channelId,
          discordUserId: session.requesterDiscordId,
          minecraftUuid,
          minecraftName,
          occurredAt: now.toISOString(),
          payloadJson: toJsonValue({ sessionId: session.id, accountId }),
          createdAt: now
        }
      })
    ]);
  }

  private assertCompletionToken(expectedHash: string | null, token: string): void {
    if (!expectedHash || !token) {
      throw new ForbiddenException('Discord verification token is invalid.');
    }
    const actualHash = hashCompletionToken(token);
    const expected = Buffer.from(expectedHash, 'hex');
    const actual = Buffer.from(actualHash, 'hex');
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
      throw new ForbiddenException('Discord verification token is invalid.');
    }
  }

  private async assertDiscordVerifyLinkConflicts(
    session: { requesterDiscordId: string },
    accountId: string,
    minecraftUuid: string
  ): Promise<void> {
    const [identityForUuid, discordLink, minecraftLink] = await Promise.all([
      this.prisma.minecraftIdentity.findFirst({
        where: {
          uuid: minecraftUuid,
          accountId: { not: accountId }
        },
        select: { accountId: true }
      }),
      this.prisma.lunaDiscordAccountLink.findUnique({
        where: { discordUserId: session.requesterDiscordId }
      }),
      this.prisma.lunaDiscordAccountLink.findUnique({
        where: { minecraftUuid }
      })
    ]);
    if (identityForUuid) {
      throw new ConflictException('Minecraft identity is already linked to another MineWiki account.');
    }
    if (discordLink && discordLink.minecraftUuid !== minecraftUuid) {
      throw new ConflictException('Discord account is already linked to another Minecraft identity.');
    }
    if (minecraftLink && minecraftLink.discordUserId !== session.requesterDiscordId) {
      throw new ConflictException('Minecraft identity is already linked to another Discord account.');
    }
  }

  private async ensureGuild(guildId: string, now = new Date()): Promise<void> {
    await this.prisma.lunaGuild.upsert({
      where: { guildId },
      create: {
        guildId,
        createdAt: now,
        updatedAt: now
      },
      update: {
        updatedAt: now
      }
    });
  }

  private async ensureGuildChannel(
    guildId: string,
    channelId: string,
    now = new Date()
  ): Promise<void> {
    await this.ensureGuild(guildId, now);
    await this.prisma.lunaGuildChannelSetting.upsert({
      where: {
        guildId_channelId: {
          guildId,
          channelId
        }
      },
      create: {
        guildId,
        channelId,
        createdAt: now,
        updatedAt: now
      },
      update: {
        updatedAt: now
      }
    });
  }

  private async resolveGuildVerificationOptions(
    guildId: string,
    channelId: string,
    overrides: { roleId?: string; nicknameTemplate?: string } = {}
  ): Promise<DiscordVerificationOptions> {
    const [guild, channel] = await Promise.all([
      this.prisma.lunaGuild.findUnique({ where: { guildId } }),
      this.prisma.lunaGuildChannelSetting.findUnique({
        where: { guildId_channelId: { guildId, channelId } }
      })
    ]);
    const roleId = overrides.roleId ?? channel?.verifiedRoleId ?? guild?.verifiedRoleId ?? undefined;
    const nicknameTemplate =
      overrides.nicknameTemplate ?? channel?.nicknameFormat ?? guild?.nicknameFormat ?? undefined;
    const dmTemplate =
      channel?.botMessageTemplate ??
      guild?.botMessageTemplate ??
      'MineWiki 인증이 완료되었습니다. Minecraft: {player}';
    const logChannelId = channel?.logChannelId ?? guild?.logChannelId ?? undefined;
    const logMessageTemplate = logChannelId
      ? '<@{discord}> 님이 Minecraft 계정 {player} ({uuid}) 인증을 완료했습니다.'
      : undefined;
    return {
      roleId,
      nicknameTemplate,
      dmTemplate,
      logChannelId,
      logMessageTemplate
    };
  }

  private toGuildResponse(guild: {
    guildId: string;
    verifiedRoleId: string | null;
    logChannelId: string | null;
    nicknameFormat: string | null;
    botMessageTemplate: string | null;
    botMessagePayload: Prisma.JsonValue | null;
    verifyReplyPayload: Prisma.JsonValue | null;
    policyJson: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
  }): LunaGuildResponse {
    return {
      guildId: guild.guildId,
      verifiedRoleId: guild.verifiedRoleId,
      logChannelId: guild.logChannelId,
      nicknameFormat: guild.nicknameFormat,
      botMessageTemplate: guild.botMessageTemplate,
      botMessagePayload: guild.botMessagePayload,
      verifyReplyPayload: guild.verifyReplyPayload,
      policyJson: guild.policyJson,
      createdAt: guild.createdAt.toISOString(),
      updatedAt: guild.updatedAt.toISOString()
    };
  }

  private toChannelResponse(channel: {
    guildId: string;
    channelId: string;
    verifiedRoleId: string | null;
    logChannelId: string | null;
    nicknameFormat: string | null;
    botMessageTemplate: string | null;
    botMessagePayload: Prisma.JsonValue | null;
    verifyReplyPayload: Prisma.JsonValue | null;
    policyJson: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
  }): LunaGuildChannelResponse {
    return {
      guildId: channel.guildId,
      channelId: channel.channelId,
      verifiedRoleId: channel.verifiedRoleId,
      logChannelId: channel.logChannelId,
      nicknameFormat: channel.nicknameFormat,
      botMessageTemplate: channel.botMessageTemplate,
      botMessagePayload: channel.botMessagePayload,
      verifyReplyPayload: channel.verifyReplyPayload,
      policyJson: channel.policyJson,
      createdAt: channel.createdAt.toISOString(),
      updatedAt: channel.updatedAt.toISOString()
    };
  }

  private buildVerificationUrl(baseUrl: string, sessionId: string, completionToken?: string): string {
    const url = new URL('/me', baseUrl);
    url.searchParams.set('verifySessionId', sessionId);
    if (completionToken) {
      url.searchParams.set('verifyToken', completionToken);
    }
    return url.toString();
  }

  private sanitizeVerificationUrl(url: string | null | undefined): string | null {
    if (!url) {
      return null;
    }
    try {
      const parsed = new URL(url);
      parsed.searchParams.delete('verifyToken');
      return parsed.toString();
    } catch {
      return null;
    }
  }

  private publicVerificationUrl(url: string | null | undefined, sessionId: string): string {
    return this.sanitizeVerificationUrl(url) ?? this.buildVerificationUrl('https://minewiki.kr', sessionId);
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

export interface LunaGuildSettingsRequest {
  readonly channelId?: string;
  readonly verifiedRoleId?: string | null;
  readonly logChannelId?: string | null;
  readonly nicknameFormat?: string | null;
  readonly botMessageTemplate?: string | null;
  readonly botMessagePayload?: unknown;
  readonly verifyReplyPayload?: unknown;
  readonly policyJson?: unknown;
}

interface DiscordVerificationOptions {
  readonly roleId?: string;
  readonly nicknameTemplate?: string;
  readonly dmTemplate?: string;
  readonly logChannelId?: string;
  readonly logMessageTemplate?: string;
}

export interface LunaGuildResponse {
  readonly guildId: string;
  readonly verifiedRoleId: string | null;
  readonly logChannelId: string | null;
  readonly nicknameFormat: string | null;
  readonly botMessageTemplate: string | null;
  readonly botMessagePayload: Prisma.JsonValue | null;
  readonly verifyReplyPayload: Prisma.JsonValue | null;
  readonly policyJson: Prisma.JsonValue | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface LunaGuildChannelResponse extends LunaGuildResponse {
  readonly channelId: string;
}

export interface LunaGuildDetailResponse extends LunaGuildResponse {
  readonly verificationCount: number;
  readonly channels: LunaGuildChannelResponse[];
  readonly actionProfiles: Array<{
    readonly profileId: string;
    readonly channelId: string | null;
    readonly name: string;
    readonly triggerEvent: string;
    readonly enabled: boolean;
    readonly updatedAt: string;
  }>;
}

function createLunaId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 32);
}

function createCompletionToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashCompletionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}
