import { test } from 'node:test';
import assert from 'node:assert/strict';
import { VoteService } from './vote.service';

const serverId = '8d5d43eb-5e53-4ce9-90a0-dfd8fbfa9b6b';
const voteId = '6ebd0b54-5864-46c2-a835-942937b0f6ec';
const targetId = 'f8be13d6-b155-44c9-ad90-2f7efa96b7d7';
const dispatchAttemptId = '6396003e-0956-4a2e-bf2b-a2ad83d7102f';

test('vote accepted creates dispatch attempts and queues vote id', async () => {
  const queuedJobs: unknown[] = [];
  const createdAttempts: unknown[] = [];
  const service = new VoteService(
    {
      ensureExists: async () => ({
        id: serverId,
        voteRequiresOwnership: false,
        votesMonthly: 10
      })
    } as never,
    {
      enqueue: async (job: unknown) => {
        queuedJobs.push(job);
      }
    } as never,
    {
      isCaptchaRequired: () => false
    } as never,
    {
      track: async () => undefined
    } as never,
    {
      getLastVoteForUsernameGlobal: async () => null,
      getLastVoteForAccountGlobal: async () => null,
      getLastVoteForMinecraftGlobal: async () => null,
      getLastVoteForIpGlobal: async () => null,
      getDailyCount: async () => 1
    } as never,
    createPrismaMock(createdAttempts) as never
  );

  const result = await service.submitVote(
    serverId,
    {
      username: 'DemoPlayer',
      agreeTerms: true,
      agreePrivacy: true
    },
    { ipAddress: '192.0.2.10' }
  );

  assert.equal(result.acknowledged, true);
  assert.equal(createdAttempts.length, 1);
  assert.deepEqual(createdAttempts[0], {
    voteId,
    serverId,
    targetId,
    protocol: 'v2',
    status: 'queued'
  });
  assert.equal(queuedJobs.length, 1);
  assert.deepEqual(queuedJobs[0], {
    voteId,
    serverId,
    targets: [
      {
        targetId,
        dispatchAttemptId
      }
    ]
  });
  const serializedJob = JSON.stringify(queuedJobs[0]);
  for (const sensitive of ['DemoPlayer', '192.0.2.10', 'vote.example.com', 'secret-token']) {
    assert.equal(serializedJob.includes(sensitive), false);
  }
});

test('invalidating a vote refreshes valid counters and writes an audit event', async () => {
  let countCall = 0;
  const serverUpdates: unknown[] = [];
  const statsUpdates: unknown[] = [];
  const reviewUpdates: unknown[] = [];
  const auditEvents: unknown[] = [];
  const service = new VoteService(
    {} as never,
    {} as never,
    { isCaptchaRequired: () => false } as never,
    {
      audit: async (...args: unknown[]) => {
        auditEvents.push(args);
      },
    } as never,
    {} as never,
    {
      vote: {
        findUnique: async () => ({ id: voteId, serverId, status: 'valid' }),
        updateMany: async () => ({ count: 1 }),
        count: async () => [4, 10, 20, 100][countCall++] ?? 0,
      },
      server: {
        update: (args: unknown) => {
          serverUpdates.push(args);
          return { operation: 'server.update' };
        },
      },
      serverStats: {
        updateMany: (args: unknown) => {
          statsUpdates.push(args);
          return { operation: 'serverStats.updateMany' };
        },
      },
      serverReview: {
        updateMany: async (args: unknown) => {
          reviewUpdates.push(args);
          return { count: 2 };
        },
      },
      $transaction: async (
        operation: unknown[] | ((transaction: unknown) => Promise<unknown>),
      ) =>
        typeof operation === 'function'
          ? operation({
              vote: {
                updateMany: async () => ({ count: 1 }),
              },
              serverReview: {
                updateMany: async (args: unknown) => {
                  reviewUpdates.push(args);
                  return { count: 2 };
                },
              },
            })
          : operation,
    } as never,
  );

  const result = await service.invalidateVote(voteId, 'account-1', 'automated pattern');

  assert.deepEqual(result, {
    id: voteId,
    serverId,
    status: 'invalid',
    rankRecalculationPending: true,
  });
  assert.deepEqual(serverUpdates, [
    {
      where: { id: serverId },
      data: { votes24h: 4, votesMonthly: 20 },
    },
  ]);
  assert.deepEqual(statsUpdates, [
    {
      where: { serverId },
      data: { votesLast24h: 4, votesLast7d: 10, votesMonthToDate: 20, votesTotal: 100 },
    },
  ]);
  assert.deepEqual(reviewUpdates, [
    {
      where: { evidenceVoteId: voteId, visibility: 'public' },
      data: { visibility: 'staff' },
    },
  ]);
  assert.equal(auditEvents.length, 1);
  assert.equal(
    (auditEvents[0] as [string, { metadata: { restrictedReviews: number } }])[1].metadata
      .restrictedReviews,
    2,
  );
});

test('moderation feed exposes bounded private evidence only to the admin service path', async () => {
  const findInputs: unknown[] = [];
  const service = new VoteService(
    {} as never,
    {} as never,
    { isCaptchaRequired: () => false } as never,
    {} as never,
    {} as never,
    {
      vote: {
        findMany: async (input: unknown) => {
          findInputs.push(input);
          return [
            {
              id: voteId,
              serverId,
              accountId: 'account-1',
              minecraftUuid: null,
              username: 'DemoPlayer',
              ipAddress: '192.0.2.10',
              votedAt: new Date('2026-07-11T00:00:00.000Z'),
              status: 'invalid',
              invalidatedAt: new Date('2026-07-11T01:00:00.000Z'),
              invalidatedBy: 'admin-1',
              invalidationReason: 'automated pattern',
            },
          ];
        },
      },
    } as never,
  );

  const rows = await service.listVotesForModeration({
    serverId,
    status: 'invalid',
    search: 'DemoPlayer',
    limit: 25,
  });

  assert.equal(rows[0]?.votedAt, '2026-07-11T00:00:00.000Z');
  assert.equal(rows[0]?.invalidatedAt, '2026-07-11T01:00:00.000Z');
  assert.equal(rows[0]?.ipAddress, '192.0.2.10');
  assert.equal(findInputs.length, 1);
});

function createPrismaMock(createdAttempts: unknown[]) {
  const tx = {
    vote: {
      create: async () => ({ id: voteId })
    },
    voteDispatchAttempt: {
      create: async (args: { data: unknown }) => {
        createdAttempts.push(args.data);
        return { id: dispatchAttemptId };
      }
    },
    server: {
      update: async () => ({})
    },
    serverStats: {
      upsert: async () => ({})
    }
  };
  return {
    votifierTarget: {
      findMany: async () => [
        {
          id: targetId,
          protocol: 'v2',
          host: 'vote.example.com',
          port: 8192,
          token: 'secret-token',
          publicKey: null
        }
      ]
    },
    voteDispatchAttempt: {
      updateMany: async () => ({ count: 0 })
    },
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx)
  };
}
