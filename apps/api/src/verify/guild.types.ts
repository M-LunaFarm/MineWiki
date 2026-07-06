import type { Prisma } from '@prisma/client';

export interface GuildSettingsRequest {
  readonly channelId?: string;
  readonly verifiedRoleId?: string | null;
  readonly logChannelId?: string | null;
  readonly nicknameFormat?: string | null;
  readonly botMessageTemplate?: string | null;
  readonly botMessagePayload?: unknown;
  readonly verifyReplyPayload?: unknown;
  readonly policyJson?: unknown;
}

export interface GuildSummaryResponse {
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

export interface GuildChannelResponse extends GuildSummaryResponse {
  readonly channelId: string;
}

export interface GuildDetailResponse extends GuildSummaryResponse {
  readonly verificationCount: number;
  readonly channels: GuildChannelResponse[];
  readonly actionProfiles: Array<{
    readonly profileId: string;
    readonly channelId: string | null;
    readonly name: string;
    readonly triggerEvent: string;
    readonly enabled: boolean;
    readonly updatedAt: string;
  }>;
}

export interface GuildSettingsRecord {
  readonly guildId: string;
  readonly verifiedRoleId: string | null;
  readonly logChannelId: string | null;
  readonly nicknameFormat: string | null;
  readonly botMessageTemplate: string | null;
  readonly botMessagePayload: Prisma.JsonValue | null;
  readonly verifyReplyPayload: Prisma.JsonValue | null;
  readonly policyJson: Prisma.JsonValue | null;
  readonly createdAt: Date;
  readonly updatedAt: Date;
}

export interface GuildChannelSettingsRecord extends GuildSettingsRecord {
  readonly channelId: string;
}

export interface GuildVerificationRecord {
  readonly guildId: string;
  readonly discordUserId: string;
  readonly minecraftUuid: string;
  readonly status: string;
  readonly verifiedAt: Date | null;
}

export interface DiscordMinecraftLinkRecord {
  readonly discordUserId: string;
  readonly minecraftUuid: string;
  readonly minecraftName: string | null;
}

export interface ResolvedPluginServer {
  readonly source: 'canonical' | 'legacy';
  readonly pluginServerId: string;
  readonly guildId: string;
  readonly serverSecret: string;
  readonly enabled: boolean;
}
