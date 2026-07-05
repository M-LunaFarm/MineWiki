import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createDiscordVerifySyncer } from './discord-verify-sync';

test('discord verify sync marks linked when bot token is missing', async () => {
  const updates: unknown[] = [];
  const prisma = {
    discordVerificationSession: {
      update: async (args: unknown) => {
        updates.push(args);
      }
    }
  };
  const syncer = createDiscordVerifySyncer({ prisma: prisma as never, token: '' });
  const result = await syncer.sync({
    action: 'link',
    sessionId: randomUUID(),
    guildId: 'guild-1',
    discordUserId: 'user-1',
    accountId: randomUUID(),
    minecraftUuid: randomUUID(),
    playerName: 'Tester',
    roleId: 'role-1',
    nicknameTemplate: '{player}',
    dmTemplate: 'Welcome {player}',
    logChannelId: 'log-1',
    logMessageTemplate: '{discord} verified as {player}'
  });

  assert.deepEqual(result, {
    status: 'linked',
    roleApplied: false,
    nicknameApplied: false,
    dmSent: false,
    logSent: false
  });
  assert.equal(updates.length, 1);
});
