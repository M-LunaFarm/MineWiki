import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordVerifySyncLogContext, voteDispatchLogContext } from './job-log-context';

test('vote dispatch logs exclude credentials and voter identity', () => {
  const context = voteDispatchLogContext({
    voteId: '11111111-1111-4111-8111-111111111111',
    serverId: '22222222-2222-4222-8222-222222222222',
    username: 'PrivatePlayer',
    ipAddress: '203.0.113.10',
    votedAt: '2026-07-11T00:00:00.000Z',
    targets: [{
      targetId: '33333333-3333-4333-8333-333333333333',
      dispatchAttemptId: '44444444-4444-4444-8444-444444444444',
      protocol: 'v2',
      host: 'mc.private.example',
      port: 8192,
      token: 'votifier-secret-token',
    }],
  });
  const serialized = JSON.stringify(context);

  assert.deepEqual(Object.keys(context).sort(), ['serverId', 'targetCount', 'voteId']);
  for (const secret of ['PrivatePlayer', '203.0.113.10', 'votifier-secret-token', 'mc.private.example']) {
    assert.equal(serialized.includes(secret), false);
  }
});

test('Discord sync logs exclude linked identities and message templates', () => {
  const context = discordVerifySyncLogContext({
    action: 'link',
    sessionId: '11111111-1111-4111-8111-111111111111',
    guildId: 'guild-1',
    discordUserId: 'private-discord-user',
    accountId: '22222222-2222-4222-8222-222222222222',
    minecraftUuid: '33333333-3333-4333-8333-333333333333',
    playerName: 'PrivatePlayer',
    dmTemplate: 'secret direct message',
  });
  const serialized = JSON.stringify(context);

  assert.deepEqual(Object.keys(context).sort(), ['action', 'guildId', 'sessionId']);
  for (const secret of [
    'private-discord-user',
    '22222222-2222-4222-8222-222222222222',
    '33333333-3333-4333-8333-333333333333',
    'PrivatePlayer',
    'secret direct message',
  ]) {
    assert.equal(serialized.includes(secret), false);
  }
});
