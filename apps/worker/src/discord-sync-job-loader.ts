import type { DiscordVerifySyncJob } from '@minewiki/schemas';
import type { DiscordVerifyExecutionJob } from './processors/discord-verify-sync';

export interface DiscordVerificationReader {
  findSession(sessionId: string): Promise<DiscordVerificationSessionRecord | null>;
  findGuildSettings(guildId: string): Promise<DiscordGuildSettingsRecord | null>;
  findChannelSettings(
    guildId: string,
    channelId: string,
  ): Promise<DiscordGuildSettingsRecord | null>;
}

interface DiscordVerificationSessionRecord {
  readonly id: string;
  readonly guildId: string;
  readonly channelId: string;
  readonly requesterDiscordId: string;
  readonly accountId: string | null;
  readonly minecraftUuid: string | null;
  readonly minecraftName: string | null;
  readonly roleId: string | null;
  readonly nicknameTemplate: string | null;
}

interface DiscordGuildSettingsRecord {
  readonly verifiedRoleId: string | null;
  readonly nicknameFormat: string | null;
  readonly botMessageTemplate: string | null;
  readonly logChannelId: string | null;
}

export async function loadDiscordVerifyExecutionJob(
  repository: DiscordVerificationReader,
  job: DiscordVerifySyncJob,
): Promise<DiscordVerifyExecutionJob> {
  const session = await repository.findSession(job.sessionId);
  if (!session?.accountId || !session.minecraftUuid) {
    throw new Error('discord_verify_session_not_ready');
  }

  const [guild, channel] = await Promise.all([
    repository.findGuildSettings(session.guildId),
    repository.findChannelSettings(session.guildId, session.channelId),
  ]);
  const roleId = session.roleId ?? channel?.verifiedRoleId ?? guild?.verifiedRoleId ?? undefined;
  const nicknameTemplate =
    session.nicknameTemplate ?? channel?.nicknameFormat ?? guild?.nicknameFormat ?? undefined;
  const dmTemplate =
    channel?.botMessageTemplate ??
    guild?.botMessageTemplate ??
    'MineWiki 인증이 완료되었습니다. Minecraft: {player}';
  const logChannelId = channel?.logChannelId ?? guild?.logChannelId ?? undefined;

  return {
    action: job.action ?? 'link',
    sessionId: session.id,
    guildId: session.guildId,
    discordUserId: session.requesterDiscordId,
    accountId: session.accountId,
    minecraftUuid: session.minecraftUuid,
    playerName: session.minecraftName ?? undefined,
    roleId,
    nicknameTemplate,
    dmTemplate,
    logChannelId,
    logMessageTemplate: logChannelId
      ? '<@{discord}> 님이 Minecraft 계정 {player} ({uuid}) 인증을 완료했습니다.'
      : undefined,
  };
}
