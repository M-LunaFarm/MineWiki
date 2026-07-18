import type { PrismaService } from '../common/prisma.service';
import type { AccountExportSection } from './account-export-stream';
import { EXPORT_PAGE_SIZE, pagedSection, staticSection } from './account-export-section-utils';

export function buildIntegrationExportSections(
  prisma: PrismaService,
  sourceAccountIds: readonly string[],
): AccountExportSection[] {
  const accountIds = [...sourceAccountIds];
  const ownedServerIds = () => prisma.server.findMany({
    where: { ownerAccountId: { in: accountIds } },
    select: { id: true },
  }).then((servers) => servers.map((server) => server.id));
  const ownedGuildIds = () => prisma.lunaGuild.findMany({
    where: { ownerAccountId: { in: accountIds } },
    select: { guildId: true },
  }).then((guilds) => guilds.map((guild) => guild.guildId));

  return [
    pagedSection('discordVerificationSessions', (after) => prisma.discordVerificationSession.findMany({
      where: { accountId: { in: accountIds }, id: { gt: after ?? undefined } },
      orderBy: { id: 'asc' }, take: EXPORT_PAGE_SIZE,
      select: {
        id: true, status: true, guildId: true, channelId: true,
        requesterDiscordId: true, accountId: true, minecraftUuid: true,
        minecraftName: true, roleId: true, nicknameTemplate: true,
        lastSyncStatus: true, createdAt: true, expiresAt: true,
        completedAt: true, lastSyncAt: true,
      },
    })),
    staticSection('votifierTargets', async () => prisma.votifierTarget.findMany({
      where: { serverId: { in: await ownedServerIds() } },
      orderBy: { id: 'asc' },
      select: { id: true, serverId: true, protocol: true, host: true, port: true, createdAt: true, updatedAt: true },
    })),
    staticSection('pluginServers', async () => prisma.pluginServer.findMany({
      where: { serverId: { in: await ownedServerIds() } },
      orderBy: { id: 'asc' },
      select: {
        id: true, serverId: true, guildId: true, pluginServerId: true,
        serverName: true, host: true, port: true,
        enabled: true, createdAt: true, updatedAt: true, lastSeenAt: true,
      },
    })),
    staticSection('ownedGuilds', async () => prisma.lunaGuild.findMany({
      where: { ownerAccountId: { in: accountIds } },
      orderBy: { guildId: 'asc' },
      select: {
        guildId: true, ownerAccountId: true, verifiedRoleId: true,
        logChannelId: true, nicknameFormat: true, botMessageTemplate: true,
        createdAt: true, updatedAt: true,
      },
    }).then((guilds) => guilds.map((guild) => ({ id: guild.guildId, ...guild })))),
    staticSection('guildServers', async () => prisma.lunaGuildServer.findMany({
      where: { guildId: { in: await ownedGuildIds() } },
      orderBy: { id: 'asc' },
      select: {
        id: true, guildId: true, serverId: true, serverName: true,
        serverHost: true, serverPort: true, enabled: true,
        createdAt: true, updatedAt: true, lastSeenAt: true,
      },
    })),
  ];
}
