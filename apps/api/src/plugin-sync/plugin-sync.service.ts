import {
  BadRequestException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';

const PLUGIN_SYNC_SKEW_SECONDS = 300;
const PLUGIN_SYNC_COOLDOWN_SECONDS = 30;

const lastSeenByServer = new Map<string, number>();

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

@Injectable()
export class PluginSyncService {
  constructor(private readonly prisma: PrismaService) {}

  async sync(request: PluginSyncRequest): Promise<PluginSyncResponse> {
    this.validateEnvelope(request);
    const serverId = String(request.payload.server_id ?? '').trim();
    if (!serverId) {
      throw new BadRequestException({ error: 'missing_server_id' });
    }

    const server = await this.prisma.lunaGuildServer.findUnique({ where: { serverId } });
    if (!server) {
      throw new NotFoundException({ error: 'server_not_found' });
    }
    if (!server.enabled) {
      throw new ForbiddenException({ error: 'server_disabled' });
    }

    this.assertFreshTimestamp(request.timestamp);
    this.assertValidSignature(server.serverSecret, request);
    this.assertCooldown(serverId);

    const verifications = await this.prisma.lunaGuildVerification.findMany({
      where: { guildId: server.guildId, status: 'verified' },
      orderBy: [{ verifiedAt: 'desc' }]
    });
    const uuids = Array.from(new Set(verifications.map((row) => row.minecraftUuid)));
    const links = uuids.length
      ? await this.prisma.lunaDiscordAccountLink.findMany({
          where: { minecraftUuid: { in: uuids } }
        })
      : [];
    const ignByUuid = new Map(links.map((link) => [link.minecraftUuid, link.minecraftName]));

    await this.prisma.lunaGuildServer.update({
      where: { serverId },
      data: { lastSeenAt: new Date() }
    });

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

  private assertCooldown(serverId: string): void {
    const now = Math.floor(Date.now() / 1000);
    const lastSeen = lastSeenByServer.get(serverId) ?? 0;
    if (lastSeen && now - lastSeen < PLUGIN_SYNC_COOLDOWN_SECONDS) {
      throw new HttpException(
        {
          error: 'rate_limited',
          retry_after: PLUGIN_SYNC_COOLDOWN_SECONDS - (now - lastSeen)
        },
        HttpStatus.TOO_MANY_REQUESTS
      );
    }
    lastSeenByServer.set(serverId, now);
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
