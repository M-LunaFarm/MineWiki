import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ConfigService } from '@minewiki/config';
import { ForbiddenException } from '@nestjs/common';
import { GuildAccessService } from './guild-access.service';

test('elevated session can list all configured guilds', async () => {
  const prisma = {
    lunaGuild: {
      async findMany() {
        return [
          {
            guildId: 'guild-1',
            verifiedRoleId: 'role-1',
            logChannelId: null,
            nicknameFormat: null,
            botMessageTemplate: null,
            botMessagePayload: null,
            verifyReplyPayload: null,
            policyJson: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-02T00:00:00.000Z'),
          },
        ];
      },
    },
  };
  const service = new GuildAccessService(prisma as never, config() as never);
  const guilds = await service.listAccessibleGuilds({
    sessionId: 'session-1',
    userId: 'account-1',
    isElevated: true,
  });

  assert.equal(guilds.length, 1);
  assert.equal(guilds[0].guildId, 'guild-1');
});

test('discord oauth guild permission allows manage guild access only', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () =>
    new Response(
      JSON.stringify([
        { id: 'guild-manage', owner: false, permissions: '32' },
        { id: 'guild-member', owner: false, permissions: '0' },
      ]),
      { status: 200 },
    );

  const prisma = {
    accountLink: {
      async findMany() {
        return [];
      },
    },
    oAuthCredential: {
      async findMany() {
        return [
          {
            id: 'credential-1',
            accountId: 'account-1',
            providerUserId: 'discord-1',
            accessToken: 'access-token',
            refreshToken: 'refresh-token',
            tokenType: 'Bearer',
            scope: 'identify email guilds',
            expiresAt: new Date(Date.now() + 120_000),
          },
        ];
      },
    },
  };
  const service = new GuildAccessService(prisma as never, config() as never);
  const session = { sessionId: 'session-1', userId: 'account-1', isElevated: false };

  try {
    await assert.doesNotReject(() => service.assertCanManageGuild(session, 'guild-manage'));
    await assert.rejects(
      () => service.assertCanManageGuild(session, 'guild-member'),
      ForbiddenException,
    );
  } finally {
    global.fetch = originalFetch;
  }
});

function config(): Pick<ConfigService, 'getOptional'> {
  return {
    getOptional() {
      return undefined;
    },
  };
}
