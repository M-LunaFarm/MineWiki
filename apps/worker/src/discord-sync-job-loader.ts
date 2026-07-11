import type { PrismaClient } from '@prisma/client';
import type { DiscordVerifySyncJob } from '@minewiki/schemas';
import type { DiscordVerifyExecutionJob } from './processors/discord-verify-sync';

type PrismaHandle = Pick<
  PrismaClient,
  'discordVerificationSession' | 'lunaGuild' | 'lunaGuildChannelSetting'
>;

export async function loadDiscordVerifyExecutionJob(
  prisma: PrismaHandle,
  job: DiscordVerifySyncJob,
): Promise<DiscordVerifyExecutionJob> {
  const session = await prisma.discordVerificationSession.findUnique({
    where: { id: job.sessionId },
  });
  if (!session?.accountId || !session.minecraftUuid) {
    throw new Error('discord_verify_session_not_ready');
  }

  const [guild, channel] = await Promise.all([
    prisma.lunaGuild.findUnique({ where: { guildId: session.guildId } }),
    prisma.lunaGuildChannelSetting.findUnique({
      where: {
        guildId_channelId: {
          guildId: session.guildId,
          channelId: session.channelId,
        },
      },
    }),
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
