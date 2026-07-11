import {
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
  UnauthorizedException
} from '@nestjs/common';
import { Queue } from 'bullmq';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
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
import {
  DiscordMinecraftLinkRepository,
  GuildChannelSettingsRepository,
  GuildEventRepository,
  GuildSettingsRepository,
  GuildVerificationRepository,
  guildSettingsMutation,
  toChannelResponse,
  toGuildResponse
} from './guild.repositories';
import type {
  GuildChannelResponse,
  GuildDetailResponse,
  GuildSettingsRequest,
  GuildSummaryResponse
} from './guild.types';

const VERIFY_SESSION_TTL_MS = 1000 * 60 * 15;

@Injectable()
export class VerifyService {
  private readonly syncQueue: Queue<DiscordVerifySyncJob> | null;
  private readonly guildSettings: GuildSettingsRepository;
  private readonly guildChannelSettings: GuildChannelSettingsRepository;
  private readonly discordMinecraftLinks: DiscordMinecraftLinkRepository;
  private readonly guildVerifications: GuildVerificationRepository;
  private readonly guildEvents: GuildEventRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly events: BusinessEventService,
    @Optional() guildSettings?: GuildSettingsRepository,
    @Optional() guildChannelSettings?: GuildChannelSettingsRepository,
    @Optional() discordMinecraftLinks?: DiscordMinecraftLinkRepository,
    @Optional() guildVerifications?: GuildVerificationRepository,
    @Optional() guildEvents?: GuildEventRepository
  ) {
    this.guildSettings = guildSettings ?? new GuildSettingsRepository(prisma);
    this.guildChannelSettings =
      guildChannelSettings ?? new GuildChannelSettingsRepository(prisma);
    this.discordMinecraftLinks =
      discordMinecraftLinks ?? new DiscordMinecraftLinkRepository(prisma);
    this.guildVerifications = guildVerifications ?? new GuildVerificationRepository(prisma);
    this.guildEvents = guildEvents ?? new GuildEventRepository(prisma);

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
    if (!this.isInternalBotToken(headerValue)) {
      throw new UnauthorizedException('Internal bot token is invalid.');
    }
  }

  isInternalBotToken(headerValue: string | undefined): boolean {
    const expected = this.config.getOptional('INTERNAL_BOT_API_TOKEN');
    return Boolean(expected && headerValue === `Bearer ${expected}`);
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

    await this.enqueueDiscordSync({
      action: 'link',
      sessionId: updated.id
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
    const created = await this.guildEvents.recordPluginSync({
      serverId: event.serverId ?? null,
      pluginServerId: event.pluginServerId ?? null,
      discordUserId: event.discordUserId ?? null,
      minecraftUuid,
      playerName: event.playerName ?? null,
      action: event.action,
      payload: event.payload
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
    const current = await this.guildVerifications.find(input.guildId, input.discordUserId);
    if (!current) {
      throw new NotFoundException('Guild verification not found.');
    }
    const now = new Date();
    await this.guildVerifications.markRevoked(input.guildId, input.discordUserId, now);
    await this.guildEvents.createMinecraftRevoked({
      guildId: input.guildId,
      discordUserId: input.discordUserId,
      minecraftUuid: current.minecraftUuid,
      reason: input.reason ?? 'api_revoke',
      now
    });
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

  async listGuilds(): Promise<GuildSummaryResponse[]> {
    const guilds = await this.guildSettings.list();
    return guilds.map(toGuildResponse);
  }

  async getGuild(guildId: string): Promise<GuildDetailResponse> {
    const guild = await this.guildSettings.find(guildId);
    if (!guild) {
      throw new NotFoundException('Guild not found.');
    }
    const [channels, verificationCount, actionProfiles] = await Promise.all([
      this.guildChannelSettings.listByGuild(guildId),
      this.guildVerifications.countVerified(guildId),
      this.guildSettings.listActionProfiles(guildId)
    ]);
    return {
      ...toGuildResponse(guild),
      verificationCount,
      channels: channels.map(toChannelResponse),
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
    input: GuildSettingsRequest
  ): Promise<GuildSummaryResponse | GuildChannelResponse> {
    const now = new Date();
    const data = guildSettingsMutation({
      verifiedRoleId: input.verifiedRoleId ?? null,
      logChannelId: input.logChannelId ?? null,
      nicknameFormat: input.nicknameFormat ?? null,
      botMessageTemplate: input.botMessageTemplate ?? null,
      botMessagePayload: input.botMessagePayload,
      verifyReplyPayload: input.verifyReplyPayload,
      policyJson: input.policyJson,
      updatedAt: now
    });
    if (input.channelId) {
      const channel = await this.guildChannelSettings.upsertSettings(guildId, input.channelId, data);
      await this.ensureGuild(guildId, now);
      return toChannelResponse(channel);
    }
    const guild = await this.guildSettings.upsertSettings(guildId, data);
    return toGuildResponse(guild);
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
    await this.discordMinecraftLinks.persistVerifiedLink({
      sessionId: session.id,
      guildId: session.guildId,
      channelId: session.channelId,
      discordUserId: session.requesterDiscordId,
      accountId,
      minecraftUuid,
      minecraftName
    });
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
      this.discordMinecraftLinks.findByDiscordUserId(session.requesterDiscordId),
      this.discordMinecraftLinks.findByMinecraftUuid(minecraftUuid)
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
    await this.guildSettings.ensure(guildId, now);
  }

  private async ensureGuildChannel(
    guildId: string,
    channelId: string,
    now = new Date()
  ): Promise<void> {
    await this.ensureGuild(guildId, now);
    await this.guildChannelSettings.ensure(guildId, channelId, now);
  }

  private async resolveGuildVerificationOptions(
    guildId: string,
    channelId: string,
    overrides: { roleId?: string; nicknameTemplate?: string } = {}
  ): Promise<DiscordVerificationOptions> {
    const [guild, channel] = await Promise.all([
      this.guildSettings.find(guildId),
      this.guildChannelSettings.find(guildId, channelId)
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

interface DiscordVerificationOptions {
  readonly roleId?: string;
  readonly nicknameTemplate?: string;
  readonly dmTemplate?: string;
  readonly logChannelId?: string;
  readonly logMessageTemplate?: string;
}

function createCompletionToken(): string {
  return randomBytes(32).toString('base64url');
}

function hashCompletionToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
