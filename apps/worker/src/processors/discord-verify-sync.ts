import { Logger } from '@minewiki/logger';
import type { PrismaClient } from '@prisma/client';

const DISCORD_API_BASE = 'https://discord.com/api/v10';

type PrismaHandle = Pick<PrismaClient, 'discordVerificationSession'>;

export interface DiscordVerifySyncResult {
  readonly status: 'synced' | 'linked' | 'failed';
  readonly roleApplied: boolean;
  readonly nicknameApplied: boolean;
  readonly dmSent: boolean;
  readonly logSent: boolean;
}

export interface DiscordVerifyExecutionJob {
  readonly action?: 'link' | 'revoke';
  readonly sessionId: string;
  readonly guildId: string;
  readonly discordUserId: string;
  readonly accountId: string;
  readonly minecraftUuid: string;
  readonly playerName?: string;
  readonly roleId?: string;
  readonly nicknameTemplate?: string;
  readonly dmTemplate?: string;
  readonly logChannelId?: string;
  readonly logMessageTemplate?: string;
}

export function createDiscordVerifySyncer(options: {
  prisma: PrismaHandle;
  token: string;
}) {
  const { prisma, token } = options;

  async function sync(job: DiscordVerifyExecutionJob): Promise<DiscordVerifySyncResult> {
    let roleApplied = false;
    let nicknameApplied = false;
    let dmSent = false;
    let logSent = false;
    try {
      if (token && job.roleId) {
        if (job.action === 'revoke') {
          await deleteDiscordRole(token, job.guildId, job.discordUserId, job.roleId);
        } else {
          await putDiscordRole(token, job.guildId, job.discordUserId, job.roleId);
        }
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
      if (token && job.dmTemplate && job.playerName) {
        await sendDirectMessage(
          token,
          job.discordUserId,
          renderMessage(job.dmTemplate, job)
        );
        dmSent = true;
      }
      if (token && job.logChannelId && job.logMessageTemplate) {
        await postChannelMessage(
          token,
          job.logChannelId,
          renderMessage(job.logMessageTemplate, job)
        );
        logSent = true;
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

      return { status, roleApplied, nicknameApplied, dmSent, logSent };
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

async function deleteDiscordRole(
  token: string,
  guildId: string,
  userId: string,
  roleId: string
): Promise<void> {
  const response = await fetch(
    `${DISCORD_API_BASE}/guilds/${guildId}/members/${userId}/roles/${roleId}`,
    {
      method: 'DELETE',
      headers: { Authorization: `Bot ${token}` }
    }
  );
  if (!response.ok) {
    throw new Error(`discord_role_remove_failed_${response.status}`);
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

async function sendDirectMessage(token: string, userId: string, content: string): Promise<void> {
  const channelResponse = await fetch(`${DISCORD_API_BASE}/users/@me/channels`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ recipient_id: userId })
  });
  if (!channelResponse.ok) {
    throw new Error(`discord_dm_channel_failed_${channelResponse.status}`);
  }
  const channel = (await channelResponse.json()) as { id?: string };
  if (!channel.id) {
    throw new Error('discord_dm_channel_missing_id');
  }
  await postChannelMessage(token, channel.id, content);
}

async function postChannelMessage(token: string, channelId: string, content: string): Promise<void> {
  const response = await fetch(`${DISCORD_API_BASE}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      Authorization: `Bot ${token}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ content: content.slice(0, 1900) })
  });
  if (!response.ok) {
    throw new Error(`discord_message_failed_${response.status}`);
  }
}

function renderMessage(template: string, job: DiscordVerifyExecutionJob): string {
  return template
    .replace(/\{player\}/gu, job.playerName ?? 'unknown')
    .replace(/\{uuid\}/gu, job.minecraftUuid)
    .replace(/\{discord\}/gu, job.discordUserId);
}
