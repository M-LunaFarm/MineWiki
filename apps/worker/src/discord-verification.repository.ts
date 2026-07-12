import type { PrismaClient } from '@prisma/client';

export class DiscordVerificationRepository {
  constructor(private readonly prisma: PrismaClient) {}

  findSession(sessionId: string) {
    return this.prisma.discordVerificationSession.findUnique({
      where: { id: sessionId },
    });
  }

  findGuildSettings(guildId: string) {
    return this.prisma.lunaGuild.findUnique({ where: { guildId } });
  }

  findChannelSettings(guildId: string, channelId: string) {
    return this.prisma.lunaGuildChannelSetting.findUnique({
      where: { guildId_channelId: { guildId, channelId } },
    });
  }
}
