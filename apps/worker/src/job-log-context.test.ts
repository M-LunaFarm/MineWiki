import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordVerifySyncLogContext, voteDispatchLogContext } from './job-log-context';

test('vote dispatch logs exclude credentials and voter identity', () => {
  const context = voteDispatchLogContext({
    voteId: '11111111-1111-4111-8111-111111111111',
    serverId: '22222222-2222-4222-8222-222222222222',
    targets: [{
      targetId: '33333333-3333-4333-8333-333333333333',
      dispatchAttemptId: '44444444-4444-4444-8444-444444444444',
    }],
  });
  const serialized = JSON.stringify(context);

  assert.deepEqual(Object.keys(context).sort(), ['serverId', 'targetCount', 'voteId']);
  assert.equal(serialized.includes('44444444-4444-4444-8444-444444444444'), false);
});

test('Discord sync logs exclude linked identities and message templates', () => {
  const context = discordVerifySyncLogContext({
    action: 'link',
    sessionId: '11111111-1111-4111-8111-111111111111',
  });
  const serialized = JSON.stringify(context);

  assert.deepEqual(Object.keys(context).sort(), ['action', 'sessionId']);
  assert.equal(serialized.includes('private-discord-user'), false);
});
