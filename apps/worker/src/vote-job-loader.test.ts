import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret } from '@minewiki/security';
import type { VoteDispatchJob } from '@minewiki/schemas';
import { loadVoteDispatchExecutionJob } from './vote-job-loader';

test('vote queue payload contains only references and worker hydrates credentials at execution', async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = 'worker-loader-test-key';
  const job: VoteDispatchJob = {
    voteId: '11111111-1111-4111-8111-111111111111',
    serverId: '22222222-2222-4222-8222-222222222222',
    targets: [{
      targetId: '33333333-3333-4333-8333-333333333333',
      dispatchAttemptId: '44444444-4444-4444-8444-444444444444',
    }],
  };
  const prisma = {
    vote: {
      findFirst: async () => ({
        username: 'PrivatePlayer',
        ipAddress: '203.0.113.10',
        votedAt: new Date('2026-07-11T00:00:00.000Z'),
      }),
    },
    votifierTarget: {
      findMany: async () => [{
        id: job.targets[0]!.targetId,
        serverId: job.serverId,
        protocol: 'v2',
        host: 'vote.example.com',
        port: 8192,
        token: encryptSecret('votifier-secret-token', process.env.APP_ENCRYPTION_KEY!),
        publicKey: null,
      }],
    },
  };

  try {
    const queued = JSON.stringify(job);
    for (const secret of ['PrivatePlayer', '203.0.113.10', 'votifier-secret-token', 'vote.example.com']) {
      assert.equal(queued.includes(secret), false);
    }

    const execution = await loadVoteDispatchExecutionJob(prisma as never, job);
    assert.equal(execution.username, 'PrivatePlayer');
    assert.equal(execution.ipAddress, '203.0.113.10');
    assert.equal(execution.targets[0]?.token, 'votifier-secret-token');
    assert.equal(execution.targets[0]?.host, 'vote.example.com');
  } finally {
    if (previousKey === undefined) {
      delete process.env.APP_ENCRYPTION_KEY;
    } else {
      process.env.APP_ENCRYPTION_KEY = previousKey;
    }
  }
});
