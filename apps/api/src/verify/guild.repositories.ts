import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { decryptAppSecret } from '../common/secret-codec';
import { redactAuditValue } from '../events/business-event.service';
import type {
  DiscordMinecraftLinkRecord,
  GuildChannelResponse,
  GuildChannelSettingsRecord,
  GuildSettingsRecord,
  GuildSummaryResponse,
  GuildVerificationRecord,
  ResolvedPluginServer
} from './guild.types';

@Injectable()
export class GuildSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  list(limit = 100): Promise<GuildSettingsRecord[]> {
    return this.prisma.lunaGuild.findMany({
      orderBy: [{ updatedAt: 'desc' }],
      take: limit
    });
  }

  listByIds(guildIds: string[], limit = 100): Promise<GuildSettingsRecord[]> {
    return this.prisma.lunaGuild.findMany({
      where: { guildId: { in: guildIds } },
      orderBy: [{ updatedAt: 'desc' }],
      take: limit
    });
  }

  listOwnedByAccountIds(accountIds: string[], store: Pick<PrismaService, 'lunaGuild'> = this.prisma) {
    return store.lunaGuild.findMany({
      where: { ownerAccountId: { in: accountIds } },
      select: { guildId: true }
    });
  }

  find(guildId: string): Promise<GuildSettingsRecord | null> {
    return this.prisma.lunaGuild.findUnique({ where: { guildId } });
  }

  async ensure(guildId: string, now = new Date()): Promise<void> {
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

  async claimOwnerIfUnset(guildId: string, accountId: string): Promise<void> {
    await this.prisma.lunaGuild.updateMany({
      where: { guildId, ownerAccountId: null },
      data: { ownerAccountId: accountId }
    });
  }

  upsertSettings(guildId: string, data: GuildSettingsMutation): Promise<GuildSettingsRecord> {
    return this.prisma.lunaGuild.upsert({
      where: { guildId },
      create: {
        guildId,
        ...data,
        createdAt: data.updatedAt
      },
      update: data
    });
  }

  listActionProfiles(guildId: string, limit = 100) {
    return this.prisma.lunaActionProfile.findMany({
      where: { guildId },
      orderBy: [{ updatedAt: 'desc' }],
      take: limit
    });
  }
}

@Injectable()
export class GuildChannelSettingsRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(guildId: string, channelId: string): Promise<GuildChannelSettingsRecord | null> {
    return this.prisma.lunaGuildChannelSetting.findUnique({
      where: { guildId_channelId: { guildId, channelId } }
    });
  }

  listByGuild(guildId: string, limit = 100): Promise<GuildChannelSettingsRecord[]> {
    return this.prisma.lunaGuildChannelSetting.findMany({
      where: { guildId },
      orderBy: [{ updatedAt: 'desc' }],
      take: limit
    });
  }

  async ensure(guildId: string, channelId: string, now = new Date()): Promise<void> {
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

  upsertSettings(
    guildId: string,
    channelId: string,
    data: GuildSettingsMutation
  ): Promise<GuildChannelSettingsRecord> {
    return this.prisma.lunaGuildChannelSetting.upsert({
      where: {
        guildId_channelId: {
          guildId,
          channelId
        }
      },
      create: {
        guildId,
        channelId,
        ...data,
        createdAt: data.updatedAt
      },
      update: data
    });
  }
}

@Injectable()
export class PluginServerRepository {
  constructor(private readonly prisma: PrismaService) {}

  async find(pluginServerId: string): Promise<ResolvedPluginServer | null> {
    const canonical = await this.prisma.pluginServer.findUnique({
      where: { pluginServerId }
    });
    if (canonical) {
      return {
        source: 'canonical',
        pluginServerId: canonical.pluginServerId,
        guildId: canonical.guildId,
        serverSecret: decryptAppSecret(canonical.serverSecret) ?? canonical.serverSecret,
        enabled: canonical.enabled
      };
    }

    const legacy = await this.prisma.lunaGuildServer.findUnique({
      where: { serverId: pluginServerId }
    });
    if (!legacy) {
      return null;
    }
    return {
      source: 'legacy',
      pluginServerId: legacy.serverId,
      guildId: legacy.guildId,
      serverSecret: decryptAppSecret(legacy.serverSecret) ?? legacy.serverSecret,
      enabled: legacy.enabled
    };
  }

  async touch(server: ResolvedPluginServer, now = new Date()): Promise<void> {
    if (server.source === 'canonical') {
      await this.prisma.pluginServer.update({
        where: { pluginServerId: server.pluginServerId },
        data: { lastSeenAt: now }
      });
      return;
    }
    await this.prisma.lunaGuildServer.update({
      where: { serverId: server.pluginServerId },
      data: { lastSeenAt: now }
    });
  }
}

@Injectable()
export class DiscordMinecraftLinkRepository {
  constructor(private readonly prisma: PrismaService) {}

  findByDiscordUserId(discordUserId: string): Promise<DiscordMinecraftLinkRecord | null> {
    return this.prisma.lunaDiscordAccountLink.findUnique({
      where: { discordUserId }
    });
  }

  findByMinecraftUuid(minecraftUuid: string): Promise<DiscordMinecraftLinkRecord | null> {
    return this.prisma.lunaDiscordAccountLink.findUnique({
      where: { minecraftUuid }
    });
  }

  listByMinecraftUuids(minecraftUuids: string[]): Promise<DiscordMinecraftLinkRecord[]> {
    return this.prisma.lunaDiscordAccountLink.findMany({
      where: { minecraftUuid: { in: minecraftUuids } }
    });
  }

  async persistVerifiedLink(input: {
    readonly sessionId: string;
    readonly guildId: string;
    readonly channelId: string;
    readonly discordUserId: string;
    readonly accountId: string;
    readonly minecraftUuid: string;
    readonly minecraftName: string;
  }, store?: Prisma.TransactionClient): Promise<void> {
    const now = new Date();
    const db = store ?? this.prisma;
    const operations = [
      db.minecraftIdentity.upsert({
        where: { accountId: input.accountId },
        create: {
          accountId: input.accountId,
          uuid: input.minecraftUuid,
          playerName: input.minecraftName,
          msOwned: true,
          lastVerifiedAt: now
        },
        update: {
          uuid: input.minecraftUuid,
          playerName: input.minecraftName,
          msOwned: true,
          lastVerifiedAt: now
        }
      }),
      db.lunaDiscordAccountLink.upsert({
        where: { discordUserId: input.discordUserId },
        create: {
          discordUserId: input.discordUserId,
          minecraftUuid: input.minecraftUuid,
          minecraftName: input.minecraftName,
          lastVerifiedAt: now,
          updatedAt: now
        },
        update: {
          minecraftUuid: input.minecraftUuid,
          minecraftName: input.minecraftName,
          lastVerifiedAt: now,
          updatedAt: now
        }
      }),
      db.lunaGuildVerification.upsert({
        where: {
          guildId_discordUserId: {
            guildId: input.guildId,
            discordUserId: input.discordUserId
          }
        },
        create: {
          guildId: input.guildId,
          discordUserId: input.discordUserId,
          minecraftUuid: input.minecraftUuid,
          status: 'verified',
          verifiedAt: now
        },
        update: {
          minecraftUuid: input.minecraftUuid,
          status: 'verified',
          verifiedAt: now
        }
      }),
      db.lunaPrivacyConsent.upsert({
        where: {
          discordUserId_consentType: {
            discordUserId: input.discordUserId,
            consentType: 'minecraft_verify'
          }
        },
        create: {
          discordUserId: input.discordUserId,
          consentType: 'minecraft_verify',
          consentedAt: now,
          updatedAt: now
        },
        update: {
          consentedAt: now,
          updatedAt: now
        }
      }),
      db.lunaEvent.create({
        data: {
          eventId: createLegacyEventId(),
          eventType: 'minecraft_verified',
          guildId: input.guildId,
          channelId: input.channelId,
          discordUserId: input.discordUserId,
          minecraftUuid: input.minecraftUuid,
          minecraftName: input.minecraftName,
          occurredAt: now.toISOString(),
          payloadJson: toJsonValue({ sessionId: input.sessionId, accountId: input.accountId }),
          createdAt: now
        }
      })
    ];
    if (store) {
      for (const operation of operations) await operation;
    } else {
      await this.prisma.$transaction(operations);
    }
  }
}

@Injectable()
export class AccountDeletionLegacyIdentityRepository {
  constructor(private readonly prisma: PrismaService) {}

  listLinks(discordUserIds: string[], minecraftUuids: string[], store?: Prisma.TransactionClient) {
    const db = store ?? this.prisma;
    if (discordUserIds.length === 0 && minecraftUuids.length === 0) return Promise.resolve([]);
    return db.lunaDiscordAccountLink.findMany({
      where: {
        OR: [
          ...(discordUserIds.length ? [{ discordUserId: { in: discordUserIds } }] : []),
          ...(minecraftUuids.length ? [{ minecraftUuid: { in: minecraftUuids } }] : []),
        ],
      },
      select: { discordUserId: true, minecraftUuid: true },
    });
  }

  listVerifications(discordUserIds: string[], minecraftUuids: string[], store?: Prisma.TransactionClient) {
    const db = store ?? this.prisma;
    if (discordUserIds.length === 0 && minecraftUuids.length === 0) return Promise.resolve([]);
    return db.lunaGuildVerification.findMany({
      where: {
        OR: [
          ...(discordUserIds.length ? [{ discordUserId: { in: discordUserIds } }] : []),
          ...(minecraftUuids.length ? [{ minecraftUuid: { in: minecraftUuids } }] : []),
        ],
      },
      select: { guildId: true, discordUserId: true, minecraftUuid: true },
    });
  }

  listGuildRoles(guildIds: string[], store?: Prisma.TransactionClient) {
    const db = store ?? this.prisma;
    if (guildIds.length === 0) return Promise.resolve([]);
    return db.lunaGuild.findMany({
      where: { guildId: { in: guildIds } },
      select: { guildId: true, verifiedRoleId: true },
    });
  }

  async scrub(
    discordUserIds: string[],
    minecraftUuids: string[],
    store?: Prisma.TransactionClient,
  ): Promise<void> {
    const db = store ?? this.prisma;
    if (discordUserIds.length === 0 && minecraftUuids.length === 0) return;
    const identityWhere = {
      OR: [
        ...(discordUserIds.length ? [{ discordUserId: { in: discordUserIds } }] : []),
        ...(minecraftUuids.length ? [{ minecraftUuid: { in: minecraftUuids } }] : []),
      ],
    };
    await db.lunaDiscordAccountLink.deleteMany({ where: identityWhere });
    await db.lunaGuildVerification.deleteMany({ where: identityWhere });
    if (discordUserIds.length > 0) {
      await db.lunaPrivacyConsent.deleteMany({ where: { discordUserId: { in: discordUserIds } } });
    }
    const events = await db.lunaEvent.findMany({ where: identityWhere, select: { eventId: true } });
    for (const event of events) {
      await db.lunaEvent.update({
        where: { eventId: event.eventId },
        data: {
          discordUserId: `deleted:${event.eventId}`.slice(0, 32),
          minecraftUuid: '00000000-0000-0000-0000-000000000000',
          minecraftName: '탈퇴한 사용자',
          payloadJson: Prisma.JsonNull,
        },
      });
    }
  }
}

@Injectable()
export class GuildVerificationRepository {
  constructor(private readonly prisma: PrismaService) {}

  find(guildId: string, discordUserId: string): Promise<GuildVerificationRecord | null> {
    return this.prisma.lunaGuildVerification.findUnique({
      where: {
        guildId_discordUserId: {
          guildId,
          discordUserId
        }
      }
    });
  }

  listVerifiedByGuild(guildId: string): Promise<GuildVerificationRecord[]> {
    return this.prisma.lunaGuildVerification.findMany({
      where: { guildId, status: 'verified' },
      orderBy: [{ verifiedAt: 'desc' }]
    });
  }

  countVerified(guildId: string): Promise<number> {
    return this.prisma.lunaGuildVerification.count({ where: { guildId, status: 'verified' } });
  }

  async markRevoked(guildId: string, discordUserId: string, now = new Date()): Promise<void> {
    await this.prisma.lunaGuildVerification.update({
      where: {
        guildId_discordUserId: {
          guildId,
          discordUserId
        }
      },
      data: {
        status: 'revoked',
        verifiedAt: now
      }
    });
  }
}

@Injectable()
export class GuildEventRepository {
  constructor(private readonly prisma: PrismaService) {}

  createMinecraftRevoked(input: {
    readonly guildId: string;
    readonly discordUserId: string;
    readonly minecraftUuid: string;
    readonly reason: string;
    readonly now?: Date;
  }): Promise<unknown> {
    const now = input.now ?? new Date();
    return this.prisma.lunaEvent.create({
      data: {
        eventId: createLegacyEventId(),
        eventType: 'minecraft_revoked',
        guildId: input.guildId,
        channelId: null,
        discordUserId: input.discordUserId,
        minecraftUuid: input.minecraftUuid,
        minecraftName: input.minecraftUuid.replace(/-/g, '').slice(0, 16),
        occurredAt: now.toISOString(),
        payloadJson: toJsonValue({ reason: input.reason }),
        createdAt: now
      }
    });
  }

  async recordPluginSync(input: {
    readonly serverId: string | null;
    readonly pluginServerId: string | null;
    readonly discordUserId: string | null;
    readonly minecraftUuid: string;
    readonly playerName: string | null;
    readonly action: string;
    readonly payload?: unknown;
  }): Promise<{ id: string }> {
    const data: {
      serverId: string | null;
      pluginServerId: string | null;
      discordUserId: string | null;
      minecraftUuid: string;
      playerName: string | null;
      action: string;
      payload?: Prisma.InputJsonValue;
    } = {
      serverId: input.serverId,
      pluginServerId: input.pluginServerId,
      discordUserId: input.discordUserId,
      minecraftUuid: input.minecraftUuid,
      playerName: input.playerName,
      action: input.action
    };
    if (input.payload) {
      data.payload = toRedactedJsonValue(input.payload);
    }
    return this.prisma.serverPluginSyncEvent.create({ data });
  }

  recordPluginSyncAudit(input: {
    readonly pluginServerId: string;
    readonly minecraftUuid: string;
    readonly action: string;
    readonly payload: unknown;
  }): Promise<{ id: string }> {
    return this.prisma.serverPluginSyncEvent.create({
      data: {
        serverId: null,
        pluginServerId: input.pluginServerId,
        discordUserId: null,
        minecraftUuid: input.minecraftUuid,
        playerName: null,
        action: input.action,
        payload: toRedactedJsonValue(input.payload)
      }
    });
  }
}

export function toGuildResponse(guild: GuildSettingsRecord): GuildSummaryResponse {
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

export function toChannelResponse(channel: GuildChannelSettingsRecord): GuildChannelResponse {
  return {
    ...toGuildResponse(channel),
    channelId: channel.channelId
  };
}

export function guildSettingsMutation(input: {
  readonly verifiedRoleId?: string | null;
  readonly logChannelId?: string | null;
  readonly nicknameFormat?: string | null;
  readonly botMessageTemplate?: string | null;
  readonly botMessagePayload?: unknown;
  readonly verifyReplyPayload?: unknown;
  readonly policyJson?: unknown;
  readonly updatedAt: Date;
}): GuildSettingsMutation {
  return {
    verifiedRoleId: input.verifiedRoleId ?? null,
    logChannelId: input.logChannelId ?? null,
    nicknameFormat: input.nicknameFormat ?? null,
    botMessageTemplate: input.botMessageTemplate ?? null,
    botMessagePayload: input.botMessagePayload ? toJsonValue(input.botMessagePayload) : Prisma.JsonNull,
    verifyReplyPayload: input.verifyReplyPayload ? toJsonValue(input.verifyReplyPayload) : Prisma.JsonNull,
    policyJson: input.policyJson ? toJsonValue(input.policyJson) : Prisma.JsonNull,
    updatedAt: input.updatedAt
  };
}

type GuildSettingsMutation = {
  readonly verifiedRoleId: string | null;
  readonly logChannelId: string | null;
  readonly nicknameFormat: string | null;
  readonly botMessageTemplate: string | null;
  readonly botMessagePayload: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  readonly verifyReplyPayload: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  readonly policyJson: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput;
  readonly updatedAt: Date;
};

function createLegacyEventId(): string {
  return randomUUID().replace(/-/g, '').slice(0, 32);
}

function toJsonValue(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function toRedactedJsonValue(value: unknown): Prisma.InputJsonValue {
  return toJsonValue(redactAuditValue(value));
}
