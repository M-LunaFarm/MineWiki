import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  Optional
} from '@nestjs/common';
import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import {
  DiscordMinecraftLinkRepository,
  GuildEventRepository,
  GuildVerificationRepository,
  PluginServerRepository
} from '../verify/guild.repositories';
import type { ResolvedPluginServer } from '../verify/guild.types';

const PLUGIN_SYNC_SKEW_SECONDS = 300;
const PLUGIN_SYNC_COOLDOWN_SECONDS = 30;
const AUDIT_MINECRAFT_UUID = '00000000-0000-0000-0000-000000000000';

export interface PluginSyncRequest {
  readonly timestamp: string;
  readonly nonce: string;
  readonly signature: string;
  readonly payload: Record<string, unknown>;
}

export interface PluginSyncResponse {
  readonly server_id: string;
  readonly guild_id: string;
  readonly generated_at: string;
  readonly entries: Array<{
    readonly mc_uuid: string;
    readonly mc_ign: string | null;
    readonly discord_user_id: string;
    readonly guild_id: string;
    readonly verified_at: string | null;
  }>;
}

export interface PluginSyncSecurityStore {
  claimNonce(serverId: string, nonce: string, ttlSeconds: number, now: Date): Promise<boolean>;
  touchCooldown(serverId: string, cooldownSeconds: number, now: Date): Promise<number | null>;
}

@Injectable()
export class PluginSyncService {
  private readonly securityStore: PluginSyncSecurityStore;
  private readonly pluginServers: PluginServerRepository;
  private readonly guildVerifications: GuildVerificationRepository;
  private readonly discordMinecraftLinks: DiscordMinecraftLinkRepository;
  private readonly guildEvents: GuildEventRepository;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() securityStore?: PluginSyncSecurityStore,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() pluginServers?: PluginServerRepository,
    @Optional() guildVerifications?: GuildVerificationRepository,
    @Optional() discordMinecraftLinks?: DiscordMinecraftLinkRepository,
    @Optional() guildEvents?: GuildEventRepository
  ) {
    this.securityStore = securityStore ?? new PrismaPluginSyncSecurityStore(prisma);
    this.pluginServers = pluginServers ?? new PluginServerRepository(prisma);
    this.guildVerifications = guildVerifications ?? new GuildVerificationRepository(prisma);
    this.discordMinecraftLinks =
      discordMinecraftLinks ?? new DiscordMinecraftLinkRepository(prisma);
    this.guildEvents = guildEvents ?? new GuildEventRepository(prisma);
  }

  async sync(request: PluginSyncRequest): Promise<PluginSyncResponse> {
    this.validateEnvelope(request);
    const serverId = String(request.payload.server_id ?? '').trim();
    if (!serverId) {
      throw new BadRequestException({ error: 'missing_server_id' });
    }

    const server = await this.resolvePluginServer(serverId);
    if (!server) {
      throw new NotFoundException({ error: 'server_not_found' });
    }
    if (!server.enabled) {
      throw new ForbiddenException({ error: 'server_disabled' });
    }

    try {
      this.assertFreshTimestamp(request.timestamp);
    } catch (error) {
      await this.auditSecurityEvent(serverId, 'stale', request);
      throw error;
    }
    try {
      this.assertValidSignature(server.serverSecret, request);
    } catch (error) {
      await this.auditSecurityEvent(serverId, 'bad_signature', request);
      throw error;
    }

    const now = new Date();
    const nonceAccepted = await this.securityStore.claimNonce(
      serverId,
      request.nonce,
      PLUGIN_SYNC_SKEW_SECONDS,
      now
    );
    if (!nonceAccepted) {
      await this.auditSecurityEvent(serverId, 'replay', request);
      throw new ConflictException({ error: 'replay' });
    }
    const retryAfter = await this.securityStore.touchCooldown(serverId, PLUGIN_SYNC_COOLDOWN_SECONDS, now);
    if (retryAfter !== null) {
      await this.auditSecurityEvent(serverId, 'rate_limited', request, { retry_after: retryAfter });
      throw new HttpException(
        {
          error: 'rate_limited',
          retry_after: retryAfter
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }

    const verifications = await this.guildVerifications.listVerifiedByGuild(server.guildId);
    const uuids = Array.from(new Set(verifications.map((row) => row.minecraftUuid)));
    const links = uuids.length
      ? await this.discordMinecraftLinks.listByMinecraftUuids(uuids)
      : [];
    const ignByUuid = new Map(links.map((link) => [link.minecraftUuid, link.minecraftName]));

    await this.touchPluginServer(server);
    await this.auditSecurityEvent(serverId, 'accepted', request);

    return {
      server_id: serverId,
      guild_id: server.guildId,
      generated_at: new Date().toISOString(),
      entries: verifications.map((row) => ({
        mc_uuid: row.minecraftUuid,
        mc_ign: ignByUuid.get(row.minecraftUuid) ?? null,
        discord_user_id: row.discordUserId,
        guild_id: server.guildId,
        verified_at: row.verifiedAt ? row.verifiedAt.toISOString() : null
      }))
    };
  }

  private validateEnvelope(request: PluginSyncRequest): void {
    if (!request.timestamp || !request.nonce || !request.signature || !request.payload) {
      throw new BadRequestException({ error: 'missing_fields' });
    }
    if (typeof request.payload !== 'object' || Array.isArray(request.payload)) {
      throw new BadRequestException({ error: 'invalid_payload' });
    }
  }

  private async resolvePluginServer(pluginServerId: string): Promise<ResolvedPluginServer | null> {
    return this.pluginServers.find(pluginServerId);
  }

  private async touchPluginServer(server: ResolvedPluginServer): Promise<void> {
    await this.pluginServers.touch(server);
  }

  private assertFreshTimestamp(timestamp: string): void {
    const now = Math.floor(Date.now() / 1000);
    const parsed = Number.parseInt(timestamp, 10);
    if (Number.isNaN(parsed) || Math.abs(now - parsed) > PLUGIN_SYNC_SKEW_SECONDS) {
      throw new BadRequestException({ error: 'stale' });
    }
  }

  private assertValidSignature(secret: string, request: PluginSyncRequest): void {
    const body = buildSignatureBody(request.timestamp, request.nonce, request.payload);
    const expected = hmacSha256Hex(secret, body);
    if (!safeEquals(expected, request.signature)) {
      throw new ForbiddenException({ error: 'bad_signature' });
    }
  }

  private async auditSecurityEvent(
    serverId: string,
    action: 'accepted' | 'bad_signature' | 'rate_limited' | 'replay' | 'stale',
    request: PluginSyncRequest,
    extraPayload: Record<string, unknown> = {}
  ): Promise<void> {
    await this.guildEvents.recordPluginSyncAudit({
      pluginServerId: serverId,
      minecraftUuid: AUDIT_MINECRAFT_UUID,
      action,
      payload: {
        timestamp: request.timestamp,
        nonce: request.nonce,
        payload: request.payload,
        ...extraPayload
      }
    });
    await this.events?.audit(`plugin.sync.${action}`, {
      category: 'plugin.sync',
      severity: action === 'accepted' ? 'info' : 'warning',
      subjectType: 'plugin_server',
      subjectId: serverId,
      metadata: {
        timestamp: request.timestamp,
        nonce: request.nonce,
        payload: request.payload,
        ...extraPayload
      }
    });
  }
}

class PrismaPluginSyncSecurityStore implements PluginSyncSecurityStore {
  constructor(private readonly prisma: PrismaService) {}

  async claimNonce(serverId: string, nonce: string, ttlSeconds: number, now: Date): Promise<boolean> {
    await this.prisma.$executeRawUnsafe(
      'DELETE FROM `plugin_sync_replay_guards` WHERE `expires_at` < ?',
      now
    );
    const expiresAt = new Date(now.getTime() + ttlSeconds * 1000);
    try {
      await this.prisma.$executeRawUnsafe(
        'INSERT INTO `plugin_sync_replay_guards` (`id`, `server_id`, `nonce`, `expires_at`, `created_at`) VALUES (?, ?, ?, ?, ?)',
        randomUUID(),
        serverId,
        nonce,
        expiresAt,
        now
      );
      return true;
    } catch (error) {
      if (isDuplicateKeyError(error)) {
        return false;
      }
      throw error;
    }
  }

  async touchCooldown(serverId: string, cooldownSeconds: number, now: Date): Promise<number | null> {
    return this.prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<Array<{ last_seen_at?: Date; lastSeenAt?: Date }>>(
        'SELECT `last_seen_at` FROM `plugin_sync_cooldowns` WHERE `server_id` = ? FOR UPDATE',
        serverId
      );
      const lastSeenAt = rows[0]?.last_seen_at ?? rows[0]?.lastSeenAt ?? null;
      if (lastSeenAt) {
        const elapsedSeconds = Math.floor((now.getTime() - new Date(lastSeenAt).getTime()) / 1000);
        if (elapsedSeconds < cooldownSeconds) {
          return cooldownSeconds - elapsedSeconds;
        }
      }
      await tx.$executeRawUnsafe(
        'INSERT INTO `plugin_sync_cooldowns` (`server_id`, `last_seen_at`, `updated_at`) VALUES (?, ?, ?) ON DUPLICATE KEY UPDATE `last_seen_at` = VALUES(`last_seen_at`), `updated_at` = VALUES(`updated_at`)',
        serverId,
        now,
        now
      );
      return null;
    });
  }
}

export function buildSignatureBody(
  timestamp: string,
  nonce: string,
  payload: Record<string, unknown>
): string {
  return `{"timestamp":${JSON.stringify(timestamp)},"nonce":${JSON.stringify(
    nonce
  )},"payload":${JSON.stringify(payload)}}`;
}

export function hmacSha256Hex(secret: string, input: string): string {
  return createHmac('sha256', secret).update(input).digest('hex');
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isDuplicateKeyError(error: unknown): boolean {
  const serialized = JSON.stringify(error);
  return serialized.includes('P2002') || serialized.includes('1062') || serialized.includes('Duplicate entry');
}
