import { test } from 'node:test';
import assert from 'node:assert/strict';
import { Prisma } from '@prisma/client';
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
      getLastVoteForUsername: async () => null,
      getLastVoteForAccount: async () => null,
      getLastVoteForMinecraft: async () => null,
      getLastVoteForIp: async () => null,
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
    { accountId: 'canonical-account', ipAddress: '192.0.2.10' }
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

test('atomic cooldown claim rejects a concurrent duplicate before dispatch and counters', async () => {
  const queuedJobs: unknown[] = [];
  const createdAttempts: unknown[] = [];
  const prisma = createPrismaMock(createdAttempts, true);
  const service = new VoteService(
    {
      ensureExists: async () => ({
        id: serverId,
        voteRequiresOwnership: false,
        votesMonthly: 10
      })
    } as never,
    { enqueue: async (job: unknown) => queuedJobs.push(job) } as never,
    { isCaptchaRequired: () => false } as never,
    { track: async () => undefined } as never,
    {
      getLastVoteForUsername: async () => null,
      getLastVoteForAccount: async () => null,
      getLastVoteForMinecraft: async () => null,
      getLastVoteForIp: async () => null
    } as never,
    prisma as never
  );

  await assert.rejects(
    service.submitVote(
      serverId,
      { username: 'DemoPlayer', agreeTerms: true, agreePrivacy: true },
      { accountId: 'canonical-account', ipAddress: '192.0.2.10' }
    ),
    /이미 오늘 투표가 등록되었습니다/
  );
  assert.equal(createdAttempts.length, 0);
  assert.equal(queuedJobs.length, 0);
});

test('linked aliases vote as the canonical account and share a verified-email cooldown', async () => {
  const createdAttempts: unknown[] = [];
  const createdClaims: Array<{ identityType: string; identityKey: string }> = [];
  const createdVotes: Array<{ accountId?: string | null }> = [];
  const canonicalAccountId = 'canonical-account';
  const prisma = createPrismaMock(createdAttempts, false, createdClaims, createdVotes) as ReturnType<typeof createPrismaMock> & {
    account: unknown;
  };
  prisma.account = {
    findUnique: async () => ({ id: 'alias-account', canonicalAccountId, lifecycleStatus: 'active' }),
    findMany: async () => [
      { email: 'Same.User@example.com', emailVerified: true },
      { email: 'same.user@example.com', emailVerified: true },
    ],
  };
  const service = new VoteService(
    { ensureExists: async () => ({ id: serverId, voteRequiresOwnership: false, votesMonthly: 10 }) } as never,
    { enqueue: async () => undefined } as never,
    { isCaptchaRequired: () => false } as never,
    { track: async () => undefined } as never,
    {
      getLastVoteForAccount: async () => null,
      getLastVoteForMinecraft: async () => null,
      getLastVoteForUsername: async () => null,
      getLastVoteForIp: async () => null,
      getDailyCount: async () => 1,
    } as never,
    prisma as never,
  );

  await service.submitVote(
    serverId,
    { username: 'DemoPlayer', agreeTerms: true, agreePrivacy: true },
    { accountId: 'alias-account' },
  );

  assert.equal(createdVotes[0]?.accountId, canonicalAccountId);
  assert.equal(createdClaims.filter((claim) => claim.identityType === 'account')[0]?.identityKey, `acct:${canonicalAccountId}`);
  const emailClaims = createdClaims.filter((claim) => claim.identityType === 'verified_email');
  assert.equal(emailClaims.length, 1);
  assert.match(emailClaims[0]?.identityKey ?? '', /^[0-9a-f]{64}$/);
  assert.equal(JSON.stringify(createdClaims).includes('same.user@example.com'), false);
});

test('verified Minecraft voters cannot redirect rewards to a typed nickname', async () => {
  const createdAttempts: unknown[] = [];
  const createdClaims: Array<{ identityType?: string; identityKey?: string }> = [];
  const createdVotes: Array<{ username?: string; usernameNormalized?: string }> = [];
  const prisma = createPrismaMock(createdAttempts, false, createdClaims, createdVotes) as ReturnType<typeof createPrismaMock> & {
    account: unknown;
  };
  prisma.account = {
    findUnique: async () => ({ id: 'canonical-account', canonicalAccountId: 'canonical-account', lifecycleStatus: 'active' }),
    findMany: async () => [],
  };
  const service = new VoteService(
    { ensureExists: async () => ({ id: serverId, voteRequiresOwnership: true, votesMonthly: 10 }) } as never,
    { enqueue: async () => undefined } as never,
    { isCaptchaRequired: () => false } as never,
    { track: async () => undefined } as never,
    {
      getLastVoteForMinecraft: async () => null,
      getLastVoteForAccount: async () => null,
      getLastVoteForIp: async () => null,
      getDailyCount: async () => 1,
    } as never,
    prisma as never,
  );

  await service.submitVote(
    serverId,
    { username: 'RewardThief', agreeTerms: true, agreePrivacy: true },
    {
      minecraftUuid: '3f0df999-1ab4-48cf-9c96-c5a834d0d1ee',
      minecraftUsername: 'OwnedPlayer',
      accountId: 'canonical-account',
    },
  );

  assert.equal(createdVotes[0]?.username, 'OwnedPlayer');
  assert.equal(createdVotes[0]?.usernameNormalized, 'ownedplayer');
  assert.ok(createdClaims.some((claim) => claim.identityKey === 'uuid:3f0df999-1ab4-48cf-9c96-c5a834d0d1ee'));
  assert.ok(createdClaims.some((claim) => claim.identityKey === 'acct:canonical-account'));
});

test('verified Minecraft votes fail closed when the canonical player name is unavailable', async () => {
  const prisma = createPrismaMock([]);
  const service = new VoteService(
    { ensureExists: async () => ({ id: serverId, voteRequiresOwnership: true, votesMonthly: 10 }) } as never,
    {} as never,
    { isCaptchaRequired: () => false } as never,
    {} as never,
    {} as never,
    prisma as never,
  );

  await assert.rejects(
    service.submitVote(
      serverId,
      { username: 'TypedPlayer', agreeTerms: true, agreePrivacy: true },
      {
        accountId: 'canonical-account',
        minecraftUuid: '3f0df999-1ab4-48cf-9c96-c5a834d0d1ee',
      },
    ),
    /인증된 Minecraft 닉네임을 확인할 수 없습니다/,
  );
});

test('vote API rejects nicknames outside the Minecraft username character set', async () => {
  const service = new VoteService(
    { ensureExists: async () => ({ id: serverId, voteRequiresOwnership: false, votesMonthly: 10 }) } as never,
    {} as never,
    { isCaptchaRequired: () => false } as never,
    {} as never,
    {} as never,
    {} as never,
  );

  await assert.rejects(
    service.submitVote(
      serverId,
      { username: '보상탈취', agreeTerms: true, agreePrivacy: true },
    ),
    /닉네임을 3~16자 사이로 입력해 주세요/,
  );
});

test('vote service rejects calls without a logged-in MineWiki account', async () => {
  const service = new VoteService(
    { ensureExists: async () => ({ id: serverId, voteRequiresOwnership: false, votesMonthly: 10 }) } as never,
    {} as never,
    { isCaptchaRequired: () => false } as never,
    {} as never,
    {} as never,
    {} as never,
  );

  await assert.rejects(
    service.submitVote(serverId, {
      username: 'DemoPlayer',
      agreeTerms: true,
      agreePrivacy: true,
    }),
    /로그인한 MineWiki 계정만 투표할 수 있습니다/,
  );
});

test('eligibility checks the selected server instead of a global vote cooldown', async () => {
  const calls: Array<[string, string]> = [];
  const now = new Date();
  const prisma = createPrismaMock([]) as ReturnType<typeof createPrismaMock> & { account: unknown };
  const service = new VoteService(
    { ensureExists: async () => ({ id: serverId, voteRequiresOwnership: false, votesMonthly: 10 }) } as never,
    {} as never,
    { isCaptchaRequired: () => false } as never,
    {} as never,
    {
      getLastVoteForAccount: async (selectedServerId: string, accountId: string) => {
        calls.push([selectedServerId, accountId]);
        return { serverId: selectedServerId, username: 'DemoPlayer', votedAt: now };
      },
      getLastVoteForMinecraft: async () => null,
      getLastVoteForIp: async () => null,
    } as never,
    prisma as never,
  );

  const result = await service.getEligibility(serverId, { accountId: 'canonical-account' });

  assert.deepEqual(calls, [[serverId, 'canonical-account']]);
  assert.equal(result.eligible, false);
  assert.equal(result.reason, 'cooldown');
  assert.ok(result.nextEligibleAt);
});

test('manual dispatch replay acquires failed state exactly once before queueing', async () => {
  let acquired = true;
  const queued: unknown[] = [];
  const attempt = {
    id: dispatchAttemptId,
    voteId,
    serverId,
    status: 'failed',
    vote: { id: voteId },
    target: {
      id: targetId,
      protocol: 'v2',
      host: 'vote.example.com',
      port: 8192,
      token: 'secret-token',
      publicKey: null
    }
  };
  const service = new VoteService(
    { ensureExists: async () => ({ id: serverId }) } as never,
    { enqueue: async (job: unknown) => queued.push(job) } as never,
    { isCaptchaRequired: () => false } as never,
    {} as never,
    {} as never,
    {
      voteDispatchAttempt: {
        findFirst: async () => attempt,
        count: async () => 0,
        updateMany: async () => ({ count: acquired ? 1 : 0 })
      }
    } as never
  );

  await service.replayDispatchAttempt(serverId, dispatchAttemptId);
  assert.equal(queued.length, 1);

  acquired = false;
  await assert.rejects(
    service.replayDispatchAttempt(serverId, dispatchAttemptId),
    /이미 재시도 중인 투표 전달/
  );
  assert.equal(queued.length, 1);
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
              server: {
                updateMany: (args: unknown) => {
                  serverUpdates.push(args);
                  return { count: 1 };
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
      where: { id: serverId, reviewsCount: { gte: 2 } },
      data: { reviewsCount: { decrement: 2 } },
    },
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

function createPrismaMock(
  createdAttempts: unknown[],
  rejectCooldownClaim = false,
  createdClaims: unknown[] = [],
  createdVotes: unknown[] = [],
) {
  const tx = {
    vote: {
      create: async (args: { data: unknown }) => {
        createdVotes.push(args.data);
        return { id: voteId };
      }
    },
    voteDispatchAttempt: {
      create: async (args: { data: unknown }) => {
        createdAttempts.push(args.data);
        return { id: dispatchAttemptId };
      }
    },
    voteCooldownClaim: {
      create: async (args: { data: unknown }) => {
        if (rejectCooldownClaim) {
          throw new Prisma.PrismaClientKnownRequestError('duplicate cooldown claim', {
            code: 'P2002',
            clientVersion: 'test'
          });
        }
        createdClaims.push(args.data);
        return args.data;
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
    account: {
      findUnique: async () => ({
        id: 'canonical-account',
        canonicalAccountId: 'canonical-account',
        lifecycleStatus: 'active',
      }),
      findMany: async () => [],
    },
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
