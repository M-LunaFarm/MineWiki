import { Logger } from '@minewiki/logger';
import type { DiscordVerifySyncJob } from '@minewiki/schemas';
import type { PrismaClient } from '@prisma/client';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

type PrismaHandle = Pick<PrismaClient, 'discordVerificationSession'>;

export interface DiscordVerifySyncResult {
  readonly status: 'synced' | 'linked' | 'failed';
  readonly roleApplied: boolean;
  readonly nicknameApplied: boolean;
}

export function createDiscordVerifySyncer(options: {
  prisma: PrismaHandle;
  token: string;
}) {
  const { prisma, token } = options;

  async function sync(job: DiscordVerifySyncJob): Promise<DiscordVerifySyncResult> {
    let roleApplied = false;
    let nicknameApplied = false;
    try {
      if (token && job.roleId) {
        await putDiscordRole(token, job.guildId, job.discordUserId, job.roleId);
        roleApplied = true;
      }
      if (token && job.nicknameTemplate && job.playerName) {
        await patchDiscordNickname(
          token,
          job.guildId,
          job.discordUserId,
          renderNickname(job.nicknameTemplate, job.playerName)
        );
        nicknameApplied = true;
      }

      const status = token ? 'synced' : 'linked';
      await prisma.discordVerificationSession.update({
        where: { id: job.sessionId },
        data: {
          status,
          syncAttempts: { increment: 1 },
          lastSyncStatus: token ? 'discord_synced' : 'discord_token_missing',
          lastSyncAt: new Date()
        }
      });

      return { status, roleApplied, nicknameApplied };
    } catch (error) {
      Logger.warn({ err: error, sessionId: job.sessionId }, 'Discord verification sync failed');
      await prisma.discordVerificationSession.update({
        where: { id: job.sessionId },
        data: {
          status: 'failed',
          syncAttempts: { increment: 1 },
          lastSyncStatus: error instanceof Error ? error.message.slice(0, 160) : 'sync_failed',
          lastSyncAt: new Date()
        }
      });
      throw error;
    }
  }

  return { sync };
}

async function putDiscordRole(
  token: string,
  guildId: string,
  userId: string,
  roleId: string
): Promise<void> {
  const response = await fetch(
    `${DISCORD_API_BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: 'PUT',
      headers: { Authorization: `Bot ${token}` }
    }
  );
  if (!response.ok) {
    throw new Error(`discord_role_sync_failed_${response.status}`);
  }
}

async function patchDiscordNickname(
  token: string,
  guildId: string,
  userId: string,
  nick: string
): Promise<void> {
  const response = await fetch(`${DISCORD_API_BASE}/guilds/${guildId}/members/${userId}`, {
    method: 'PATCH',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ nick })
  });
  if (!response.ok) {
    throw new Error(`discord_nickname_sync_failed_${response.status}`);
  }
}

function renderNickname(template: string, playerName: string): string {
  return template.replace(/\{player\}/gu, playerName).slice(0, 32);
}
