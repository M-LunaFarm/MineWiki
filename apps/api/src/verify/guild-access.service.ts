import { ForbiddenException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { PrismaService } from '../common/prisma.service';
import { decryptAppSecret, encryptAppSecret } from '../common/secret-codec';
import type { SessionPayload } from '../session/session.service';
import { GuildSettingsRepository, toGuildResponse } from './guild.repositories';
import type { GuildSummaryResponse } from './guild.types';
import { fetchWithTimeout } from '../common/http/external-fetch';

const DISCORD_MANAGE_GUILD = 0x20n;
const TOKEN_REFRESH_SKEW_MS = 60_000;

type DiscordGuild = {
  readonly id?: string;
  readonly owner?: boolean;
  readonly permissions?: string;
};

type OAuthCredentialRecord = {
  readonly id: string;
  readonly accountId: string;
  readonly providerUserId: string;
  readonly accessToken: string;
  readonly refreshToken: string | null;
  readonly tokenType: string | null;
  readonly scope: string | null;
  readonly expiresAt: Date | null;
};

@Injectable()
export class GuildAccessService {
  private readonly guildSettings: GuildSettingsRepository;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    @Optional() guildSettings?: GuildSettingsRepository
  ) {
    this.guildSettings = guildSettings ?? new GuildSettingsRepository(prisma);
  }

  async listAccessibleGuilds(session: SessionPayload): Promise<GuildSummaryResponse[]> {
    if (this.hasGuildAdmin(session)) {
      const guilds = await this.guildSettings.list();
      return guilds.map(toGuildResponse);
    }

    const accessibleIds = await this.resolveManageableGuildIds(session.userId);
    if (accessibleIds.size === 0) {
      return [];
    }
    const guilds = await this.guildSettings.listByIds([...accessibleIds]);
    return guilds.map(toGuildResponse);
  }

  async assertCanViewGuild(session: SessionPayload, guildId: string): Promise<void> {
    await this.assertCanManageGuild(session, guildId);
  }

  async assertCanManageGuild(session: SessionPayload, guildId: string): Promise<void> {
    if (this.hasGuildAdmin(session)) {
      return;
    }
    const accessibleIds = await this.resolveManageableGuildIds(session.userId);
    if (!accessibleIds.has(guildId)) {
      throw new ForbiddenException('Discord guild management permission is required.');
    }
  }

  private hasGuildAdmin(session: SessionPayload): boolean {
    return session.isElevated || session.permissions?.includes('guild.admin') === true;
  }

  private async resolveManageableGuildIds(accountId: string): Promise<Set<string>> {
    const accountIds = await this.collectConnectedAccountIds(accountId);
    const credentials = await this.prisma.oAuthCredential.findMany({
      where: {
        accountId: { in: [...accountIds] },
        provider: 'discord',
      },
      orderBy: [{ updatedAt: 'desc' }],
    });

    const manageable = new Set<string>();
    for (const credential of credentials) {
      if (!hasScope(credential.scope, 'guilds')) {
        continue;
      }
      const guilds = await this.fetchDiscordGuilds(await this.ensureFreshCredential(credential));
      for (const guild of guilds) {
        if (guild.id && canManageDiscordGuild(guild)) {
          manageable.add(guild.id);
        }
      }
    }
    return manageable;
  }

  private async collectConnectedAccountIds(accountId: string): Promise<Set<string>> {
    const visited = new Set<string>([accountId]);
    let frontier = [accountId];
    while (frontier.length > 0) {
      const links = await this.prisma.accountLink.findMany({
        where: {
          OR: [{ primaryAccountId: { in: frontier } }, { linkedAccountId: { in: frontier } }],
        },
        select: { primaryAccountId: true, linkedAccountId: true },
      });
      const next: string[] = [];
      for (const link of links) {
        if (!visited.has(link.primaryAccountId)) {
          visited.add(link.primaryAccountId);
          next.push(link.primaryAccountId);
        }
        if (!visited.has(link.linkedAccountId)) {
          visited.add(link.linkedAccountId);
          next.push(link.linkedAccountId);
        }
      }
      frontier = next;
    }
    return visited;
  }

  private async ensureFreshCredential(
    credential: OAuthCredentialRecord,
  ): Promise<OAuthCredentialRecord> {
    if (
      !credential.expiresAt ||
      credential.expiresAt.getTime() - Date.now() > TOKEN_REFRESH_SKEW_MS
    ) {
      return decryptCredential(credential);
    }
    if (!credential.refreshToken) {
      throw new UnauthorizedException('Discord OAuth credential has expired.');
    }
    return this.refreshDiscordCredential(credential);
  }

  private async refreshDiscordCredential(
    credential: OAuthCredentialRecord,
  ): Promise<OAuthCredentialRecord> {
    const clientId = this.config.getOptional('DISCORD_CLIENT_ID');
    const clientSecret = this.config.getOptional('DISCORD_CLIENT_SECRET');
    if (!clientId || !clientSecret) {
      throw new UnauthorizedException('Discord OAuth refresh is not configured.');
    }

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret,
      grant_type: 'refresh_token',
      refresh_token: decryptAppSecret(credential.refreshToken) ?? '',
    });
    const response = await fetchWithTimeout('https://discord.com/api/oauth2/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });
    if (!response.ok) {
      throw new UnauthorizedException('Discord OAuth credential refresh failed.');
    }
    const payload = (await response.json().catch(() => ({}))) as {
      access_token?: string;
      refresh_token?: string;
      token_type?: string;
      scope?: string;
      expires_in?: number;
    };
    if (!payload.access_token) {
      throw new UnauthorizedException('Discord OAuth refresh did not return an access token.');
    }
    const updated = await this.prisma.oAuthCredential.update({
      where: { id: credential.id },
      data: {
        accessToken: encryptAppSecret(payload.access_token) ?? payload.access_token,
        refreshToken: encryptAppSecret(payload.refresh_token ?? decryptAppSecret(credential.refreshToken)),
        tokenType: payload.token_type ?? credential.tokenType,
        scope: payload.scope ?? credential.scope,
        expiresAt: payload.expires_in ? new Date(Date.now() + payload.expires_in * 1000) : null,
      },
    });
    return decryptCredential(updated);
  }

  private async fetchDiscordGuilds(credential: OAuthCredentialRecord): Promise<DiscordGuild[]> {
    const response = await fetchWithTimeout('https://discord.com/api/users/@me/guilds', {
      headers: { Authorization: `Bearer ${credential.accessToken}` },
    });
    if (!response.ok) {
      throw new UnauthorizedException('Discord guild list could not be loaded.');
    }
    const payload = await response.json().catch(() => []);
    return Array.isArray(payload) ? (payload as DiscordGuild[]) : [];
  }
}

function decryptCredential(credential: OAuthCredentialRecord): OAuthCredentialRecord {
  return {
    ...credential,
    accessToken: decryptAppSecret(credential.accessToken) ?? credential.accessToken,
    refreshToken: decryptAppSecret(credential.refreshToken),
  };
}

function hasScope(scope: string | null, required: string): boolean {
  return Boolean(scope?.split(/\s+/).includes(required));
}

function canManageDiscordGuild(guild: DiscordGuild): boolean {
  if (guild.owner) {
    return true;
  }
  try {
    const permissions = BigInt(guild.permissions ?? '0');
    return (permissions & DISCORD_MANAGE_GUILD) === DISCORD_MANAGE_GUILD;
  } catch {
    return false;
  }
}
