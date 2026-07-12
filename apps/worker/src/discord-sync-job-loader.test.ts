import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { DiscordVerifySyncJob } from '@minewiki/schemas';
import { loadDiscordVerifyExecutionJob } from './discord-sync-job-loader';

test('Discord sync queue stores only a session reference and hydrates private state at execution', async () => {
  const job: DiscordVerifySyncJob = {
    action: 'link',
    sessionId: '11111111-1111-4111-8111-111111111111',
  };
  const repository = {
    findSession: async () => ({
      id: job.sessionId,
      guildId: 'guild-private',
      channelId: 'channel-private',
      requesterDiscordId: 'discord-user-private',
      accountId: '22222222-2222-4222-8222-222222222222',
      minecraftUuid: '33333333-3333-4333-8333-333333333333',
      minecraftName: 'PrivatePlayer',
      roleId: 'attacker-selected-role',
      nicknameTemplate: '[Owner] {player}',
    }),
    findGuildSettings: async () => ({
      verifiedRoleId: 'verified-role',
      nicknameFormat: '[Member] {player}',
      botMessageTemplate: 'Welcome {player}',
      logChannelId: 'log-channel',
    }),
    findChannelSettings: async () => ({
      verifiedRoleId: 'channel-approved-role',
      nicknameFormat: '[Channel] {player}',
      botMessageTemplate: null,
      logChannelId: null,
    }),
  };

  const queued = JSON.stringify(job);
  for (const privateValue of [
    'guild-private',
    'discord-user-private',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    'PrivatePlayer',
    'Welcome {player}',
  ]) {
    assert.equal(queued.includes(privateValue), false);
  }

  const execution = await loadDiscordVerifyExecutionJob(repository, job);
  assert.equal(execution.discordUserId, 'discord-user-private');
  assert.equal(execution.minecraftUuid, '33333333-3333-4333-8333-333333333333');
  assert.equal(execution.roleId, 'channel-approved-role');
  assert.equal(execution.nicknameTemplate, '[Channel] {player}');
  assert.equal(execution.dmTemplate, 'Welcome {player}');
  assert.equal(execution.logChannelId, 'log-channel');
});
