import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConflictException } from '@nestjs/common';
import { ClaimService, hashClaimToken, matchesClaimToken } from './claim.service';
import { decryptAppSecret } from '../common/secret-codec';
import {
  SERVER_OWNERSHIP_CHALLENGE_GRACE_MS,
  serverOwnershipVerificationTransition,
} from '@minewiki/schemas';

function ownershipServer(overrides: Record<string, unknown> = {}) {
  return {
    ownerAccountId: null,
    registrantAccountId: null,
    registrationLeaseExpiresAt: null,
    listingStatus: 'pending',
    ownershipVerificationFailures: 0,
    ownershipChallengeStartedAt: null,
    ownershipChallengeExpiresAt: null,
    ownershipChallengeSuspendedAt: null,
    ownershipLastFailureAt: null,
    ...overrides,
  };
}

test('claim tokens are stored as deterministic one-way hashes', () => {
  const token = 'claim-token-that-must-not-be-stored';
  const stored = hashClaimToken(token);

  assert.match(stored, /^sha256:[a-f0-9]{64}$/);
  assert.equal(stored.includes(token), false);
  assert.equal(matchesClaimToken(stored, token), true);
  assert.equal(matchesClaimToken(stored, `${token}-wrong`), false);
});

test('legacy plaintext claim tokens remain verifiable during rotation', () => {
  assert.equal(matchesClaimToken('legacy-token', 'legacy-token'), true);
  assert.equal(matchesClaimToken('legacy-token', 'wrong-token'), false);
});

test('ownership challenge counts only spaced confirmed proof absence and requires a post-grace failure', () => {
  const owner = 'account-owner';
  const start = new Date('2026-07-01T00:00:00.000Z');
  let state = ownershipServer({ ownerAccountId: owner });

  const inconclusive = serverOwnershipVerificationTransition(state, 'inconclusive', start);
  assert.equal(inconclusive.ownershipVerificationFailures, 0);

  for (const hours of [0, 6, 12]) {
    const checkedAt = new Date(start.getTime() + hours * 60 * 60 * 1000);
    const transition = serverOwnershipVerificationTransition(state, 'confirmed_absent', checkedAt);
    state = { ...state, ...transition };
  }
  assert.equal(state.ownershipVerificationFailures, 3);
  assert.equal((state.ownershipChallengeStartedAt as Date).toISOString(), new Date(start.getTime() + 12 * 60 * 60 * 1000).toISOString());
  assert.equal((state.ownershipChallengeExpiresAt as Date).toISOString(), new Date(
    start.getTime() + 12 * 60 * 60 * 1000 + SERVER_OWNERSHIP_CHALLENGE_GRACE_MS,
  ).toISOString());

  const beforeGrace = serverOwnershipVerificationTransition(
    state,
    'confirmed_absent',
    new Date((state.ownershipChallengeExpiresAt as Date).getTime() - 1),
  );
  assert.equal(beforeGrace.challengeMatured, false);
  const afterGrace = serverOwnershipVerificationTransition(
    state,
    'confirmed_absent',
    new Date((state.ownershipChallengeExpiresAt as Date).getTime() + 1),
  );
  assert.equal(afterGrace.challengeMatured, true);

  const restored = serverOwnershipVerificationTransition(
    { ...state, ownershipChallengeSuspendedAt: new Date() },
    'verified',
    new Date(),
  );
  assert.equal(restored.ownershipVerificationFailures, 0);
  assert.equal(restored.ownershipChallengeExpiresAt, null);
  assert.equal(restored.ownershipLastFailureAt, null);
});

test('token issuance stores a hash plus encrypted proof and reveals the token once', async () => {
  let storedToken = '';
  let storedCiphertext = '';
  let leaseUpdate: Record<string, unknown> | null = null;
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = 'claim-token-test-key';
  const serverService = {
    ensureExists: async () => ({ ownerAccountId: null, registrantAccountId: 'account-1' }),
  };
  const prisma = {
    serverClaimMethod: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        storedToken = String(create.token);
        storedCiphertext = String(create.tokenCiphertext);
        return {
          ...create,
          id: 'claim-method-1',
          verifiedAt: null,
          note: 'token_issued',
        };
      },
      findMany: async () => [],
    },
    server: {
      findUnique: async () => ownershipServer(),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        leaseUpdate = data;
        return { count: 1 };
      },
      update: async () => ({}),
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
  };
  try {
    const service = new ClaimService(serverService as never, prisma as never);
    const [issued] = await service.issueTokens('server-1', 'account-1', ['dns']);

    assert.ok(issued?.token);
    assert.match(storedToken, /^sha256:[a-f0-9]{64}$/);
    assert.match(storedCiphertext, /^enc:v1:/);
    assert.notEqual(storedToken, issued.token);
    assert.notEqual(storedCiphertext, issued.token);
    assert.equal(matchesClaimToken(storedToken, issued.token), true);
    assert.equal(decryptAppSecret(storedCiphertext), issued.token);
    assert.equal(leaseUpdate?.registrantAccountId, 'account-1');
    assert.ok(leaseUpdate?.registrationLeaseExpiresAt instanceof Date);
    assert.ok(
      (leaseUpdate.registrationLeaseExpiresAt as Date).getTime() > Date.now() + 23 * 60 * 60 * 1000,
    );
  } finally {
    if (previousKey === undefined) {
      delete process.env.APP_ENCRYPTION_KEY;
    } else {
      process.env.APP_ENCRYPTION_KEY = previousKey;
    }
  }
});

test('unsupported claim methods cannot be issued through an internal caller', async () => {
  const service = new ClaimService(
    { ensureExists: async () => ({ ownerAccountId: null }) } as never,
    {} as never,
  );

  await assert.rejects(
    () => service.issueTokens('server-1', 'account-1', ['plugin'] as never),
    /허용되지 않는 검증 방식.*plugin/,
  );
});

test('only the registering account can start the first ownership claim', async () => {
  const service = new ClaimService(
    {
      ensureExists: async () => ({
        ownerAccountId: null,
        registrantAccountId: 'account-registrant',
      }),
    } as never,
    {} as never,
  );

  await assert.rejects(
    () => service.issueTokens('server-1', 'account-attacker', ['dns']),
    /서버를 등록한 계정만 최초 소유권 검증을 시작할 수 있습니다/,
  );
});

test('token issuance rechecks the registration lease inside the write transaction', async () => {
  let tokenWrites = 0;
  const prisma = {
    server: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => ({ ownerAccountId: null, registrantAccountId: 'account-new' }),
    },
    serverClaimMethod: {
      upsert: async () => { tokenWrites += 1; return {}; },
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new ClaimService(
    {
      ensureExists: async () => ({ ownerAccountId: null, registrantAccountId: 'account-old' }),
    } as never,
    prisma as never,
  );

  await assert.rejects(
    () => service.issueTokens('server-1', 'account-old', ['dns']),
    /서버를 등록한 계정만 최초 소유권 검증을 시작할 수 있습니다/,
  );
  assert.equal(tokenWrites, 0);
});

test('a suspended ownership challenge admits one fresh takeover claimant', async () => {
  const suspendedAt = new Date('2026-07-19T00:00:00.000Z');
  const server = ownershipServer({
    ownerAccountId: 'account-old',
    ownershipChallengeSuspendedAt: suspendedAt,
  });
  const leaseWrites: Array<Record<string, unknown>> = [];
  let tokenAccountId: unknown = null;
  const prisma = {
    server: {
      findUnique: async () => server,
      updateMany: async (input: { where: Record<string, unknown>; data: Record<string, unknown> }) => {
        leaseWrites.push(input);
        return { count: 1 };
      },
      update: async () => ({}),
    },
    serverClaimMethod: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        tokenAccountId = create.accountId;
        return { ...create, id: 'method-1', verifiedAt: null, note: 'token_issued' };
      },
      findMany: async () => [],
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new ClaimService({ ensureExists: async () => server } as never, prisma as never);

  const issued = await service.issueTokens('server-1', 'account-new', ['dns']);

  assert.ok(issued[0]?.token);
  assert.equal(tokenAccountId, 'account-new');
  const leaseWhere = leaseWrites[0]?.where as Record<string, unknown>;
  assert.equal(leaseWhere.id, 'server-1');
  assert.equal(leaseWhere.ownerAccountId, 'account-old');
  assert.deepEqual(leaseWhere.ownershipChallengeSuspendedAt, { not: null });
  const leaseOr = leaseWhere.OR as Array<Record<string, unknown>>;
  assert.deepEqual(leaseOr.slice(0, 2), [
    { registrantAccountId: null },
    { registrantAccountId: 'account-new' },
  ]);
  assert.ok((leaseOr[2]?.registrationLeaseExpiresAt as { lte?: unknown }).lte instanceof Date);
  assert.equal(
    (leaseWrites[0]?.data as Record<string, unknown> | undefined)?.registrantAccountId,
    'account-new',
  );
});

test('an active suspended-owner registration lease cannot be replaced by another account', async () => {
  const activeLease = ownershipServer({
    ownerAccountId: 'account-old',
    registrantAccountId: 'account-a',
    registrationLeaseExpiresAt: new Date(Date.now() + 60_000),
    ownershipChallengeSuspendedAt: new Date(),
  });
  let tokenWrites = 0;
  const prisma = {
    server: {
      updateMany: async () => ({ count: 0 }),
      findUnique: async () => activeLease,
    },
    serverClaimMethod: {
      upsert: async () => { tokenWrites += 1; return {}; },
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new ClaimService(
    { ensureExists: async () => ownershipServer({ ownerAccountId: 'account-old', ownershipChallengeSuspendedAt: new Date() }) } as never,
    prisma as never,
  );

  await assert.rejects(
    () => service.issueTokens('server-1', 'account-b', ['dns']),
    (error: unknown) => error instanceof ConflictException && /다른 계정이 서버 소유권 등록을 진행 중/u.test(error.message),
  );
  assert.equal(tokenWrites, 0);
});

test('the same takeover claimant can refresh its lease and an expired lease admits a new claimant', async () => {
  const suspendedAt = new Date();
  for (const scenario of [
    { existing: 'account-a', requester: 'account-a', expiresAt: new Date(Date.now() + 60_000) },
    { existing: 'account-a', requester: 'account-b', expiresAt: new Date(Date.now() - 60_000) },
  ]) {
    let tokenWrites = 0;
    const server = ownershipServer({
      ownerAccountId: 'account-old',
      registrantAccountId: scenario.existing,
      registrationLeaseExpiresAt: scenario.expiresAt,
      ownershipChallengeSuspendedAt: suspendedAt,
    });
    const prisma = {
      server: {
        findUnique: async () => server,
        updateMany: async ({ where }: { where: { OR?: Array<Record<string, unknown>> } }) => {
          assert.ok(where.OR?.some((entry) => entry.registrantAccountId === scenario.requester));
          assert.ok(where.OR?.some((entry) => 'registrationLeaseExpiresAt' in entry));
          return { count: 1 };
        },
        update: async () => ({}),
      },
      serverClaimMethod: {
        upsert: async ({ create }: { create: Record<string, unknown> }) => {
          tokenWrites += 1;
          return { ...create, id: `method-${scenario.requester}`, verifiedAt: null };
        },
        findMany: async () => [],
      },
      $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
    };
    const service = new ClaimService({ ensureExists: async () => server } as never, prisma as never);
    await service.issueTokens('server-1', scenario.requester, ['dns']);
    assert.equal(tokenWrites, 1);
  }
});

test('verified takeover replaces the suspended owner while keeping authority locked for wiki reconciliation', async () => {
  const suspendedAt = new Date('2026-07-19T00:00:00.000Z');
  const current = ownershipServer({
    ownerAccountId: 'account-old',
    registrantAccountId: 'account-new',
    registrationLeaseExpiresAt: new Date('2026-07-20T00:00:00.000Z'),
    listingStatus: 'suspended',
    ownershipVerificationFailures: 4,
    ownershipChallengeStartedAt: new Date('2026-07-10T00:00:00.000Z'),
    ownershipChallengeExpiresAt: new Date('2026-07-17T00:00:00.000Z'),
    ownershipChallengeSuspendedAt: suspendedAt,
    ownershipLastFailureAt: suspendedAt,
  });
  const ownershipWrites: Array<Record<string, unknown>> = [];
  const serverUpdates: Array<Record<string, unknown>> = [];
  const snapshot = {
    id: 'claim-method-new', serverId: 'server-1', accountId: 'account-new', method: 'dns',
    token: hashClaimToken('proof'), issuedAt: new Date(), version: 1,
  };
  const prisma = {
    serverOwnershipTransfer: { updateMany: async () => ({ count: 0 }) },
    serverClaimMethod: {
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [{ method: 'dns', status: 'verified' }],
    },
    server: {
      findUnique: async () => current,
      updateMany: async (input: Record<string, unknown>) => {
        ownershipWrites.push(input);
        return { count: 1 };
      },
      update: async ({ data }: { data: Record<string, unknown> }) => {
        serverUpdates.push(data);
        return {};
      },
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new ClaimService({ ensureExists: async () => current } as never, prisma as never);

  const checkedAt = new Date('2026-07-19T12:00:00.000Z');
  assert.equal(await service.applyVerificationResult(snapshot, {
    status: 'verified', checkedAt: checkedAt.toISOString(), note: 'dns_token_confirmed',
  }), true);
  assert.equal((ownershipWrites[0]?.data as Record<string, unknown>)?.ownerAccountId, 'account-new');
  assert.deepEqual((ownershipWrites[0]?.where as { OR: unknown[] }).OR.at(-1), {
    ownerAccountId: 'account-old',
    registrantAccountId: 'account-new',
    registrationLeaseExpiresAt: { gt: checkedAt },
    ownershipChallengeSuspendedAt: { not: null },
  });
  assert.equal(serverUpdates[0]?.ownershipVerificationFailures, 0);
  assert.equal(serverUpdates[0]?.ownershipChallengeSuspendedAt, suspendedAt);
  assert.equal(serverUpdates[0]?.listingStatus, 'suspended');
});

test('an expired takeover lease cannot promote a stale verification result', async () => {
  const checkedAt = new Date('2026-07-19T12:00:00.000Z');
  const current = ownershipServer({
    ownerAccountId: 'account-old',
    registrantAccountId: 'account-new',
    registrationLeaseExpiresAt: new Date('2026-07-19T11:59:59.000Z'),
    ownershipChallengeSuspendedAt: new Date('2026-07-19T00:00:00.000Z'),
  });
  let ownershipAttempts = 0;
  const snapshot = {
    id: 'claim-method-new', serverId: 'server-1', accountId: 'account-new', method: 'dns',
    token: hashClaimToken('proof'), issuedAt: new Date(), version: 1,
  };
  const prisma = {
    serverClaimMethod: {
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [{ method: 'dns', status: 'verified' }],
    },
    server: {
      findUnique: async () => current,
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        if (data.ownerAccountId === 'account-new') ownershipAttempts += 1;
        return { count: 0 };
      },
      update: async () => ({}),
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new ClaimService({ ensureExists: async () => current } as never, prisma as never);

  await assert.rejects(
    () => service.applyVerificationResult(snapshot, { status: 'verified', checkedAt: checkedAt.toISOString() }),
    /서버 소유권이 다른 계정에 이미 배정되었습니다/u,
  );
  assert.equal(ownershipAttempts, 1);
});

test('pending registrant access ends with the registration lease', async () => {
  const active = new ClaimService({
    ensureExists: async () => ownershipServer({
      ownerAccountId: 'account-old', registrantAccountId: 'account-new',
      registrationLeaseExpiresAt: new Date(Date.now() + 60_000), ownershipChallengeSuspendedAt: new Date(),
    }),
  } as never, {} as never);
  const expired = new ClaimService({
    ensureExists: async () => ownershipServer({
      ownerAccountId: 'account-old', registrantAccountId: 'account-new',
      registrationLeaseExpiresAt: new Date(Date.now() - 60_000), ownershipChallengeSuspendedAt: new Date(),
    }),
  } as never, {} as never);

  assert.equal(await active.isPendingRegistrant('server-1', 'account-new'), true);
  assert.equal(await expired.isPendingRegistrant('server-1', 'account-new'), false);
});

test('successful ownership verification promotes registrant to owner atomically', async () => {
  const updates: Array<Record<string, unknown>> = [];
  const verifiedMethod = {
    id: 'claim-method-1',
    serverId: 'server-1',
    accountId: 'account-registrant',
    method: 'dns',
    token: hashClaimToken('claim-proof'),
    issuedAt: new Date(),
    status: 'verified',
    verifiedAt: new Date(),
    lastCheckedAt: new Date(),
    note: 'dns_token_confirmed',
    version: 1,
  };
  const prisma = {
    serverOwnershipTransfer: { updateMany: async () => ({ count: 0 }) },
    serverClaimMethod: {
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [verifiedMethod],
    },
    server: {
      findUnique: async () => ownershipServer({
        registrantAccountId: 'account-registrant',
        registrationLeaseExpiresAt: new Date(Date.now() + 60_000),
      }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      },
      update: async () => ({}),
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new ClaimService(
    {
      ensureExists: async () => ({
        ownerAccountId: null,
        registrantAccountId: 'account-registrant',
        verificationGrade: 'Unverified',
      }),
    } as never,
    prisma as never,
  );

  await service.applyVerificationResult(verifiedMethod, {
    status: 'verified',
    checkedAt: new Date().toISOString(),
  });

  assert.deepEqual(updates, [
    { ownerAccountId: 'account-registrant', registrantAccountId: null, registrationLeaseExpiresAt: null },
    { listingStatus: 'active' },
  ]);
});

test('legacy verified plugin rows cannot preserve a public verification grade', async () => {
  const gradeUpdates: Array<Record<string, unknown>> = [];
  let listingUpdates = 0;
  const snapshot = {
    id: 'claim-method-dns',
    serverId: 'server-1',
    accountId: 'account-registrant',
    method: 'dns',
    token: hashClaimToken('proof'),
    issuedAt: new Date(),
    version: 1,
  };
  const prisma = {
    serverClaimMethod: {
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [
        { method: 'dns', status: 'failed' },
        { method: 'plugin', status: 'verified' },
      ],
    },
    server: {
      findUnique: async () => ownershipServer(),
      update: async ({ data }: { data: Record<string, unknown> }) => {
        gradeUpdates.push(data);
        return {};
      },
      updateMany: async () => {
        listingUpdates += 1;
        return { count: 1 };
      },
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new ClaimService(
    { ensureExists: async () => ({ ownerAccountId: null }) } as never,
    prisma as never,
  );

  await service.applyVerificationResult(snapshot, {
    status: 'failed',
    checkedAt: new Date().toISOString(),
  });

  assert.deepEqual(gradeUpdates, [{
    verificationGrade: 'Unverified',
    verifiedAt: null,
    ownershipVerificationFailures: 0,
    ownershipChallengeStartedAt: null,
    ownershipChallengeExpiresAt: null,
    ownershipLastFailureAt: null,
    ownershipChallengeSuspendedAt: null,
    listingStatus: undefined,
  }]);
  assert.equal(listingUpdates, 0);
});

test('stale claim verification result cannot promote an owner after proof rotation', async () => {
  let ownershipUpdates = 0;
  const snapshot = {
    id: 'claim-method-1',
    serverId: 'server-1',
    accountId: 'account-registrant',
    method: 'dns',
    token: hashClaimToken('proof-a'),
    issuedAt: new Date('2026-07-12T00:00:00.000Z'),
    version: 1,
  };
  const prisma = {
    serverClaimMethod: {
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
    },
    server: {
      findUnique: async () => ownershipServer(),
      updateMany: async () => {
        ownershipUpdates += 1;
        return { count: 1 };
      },
      update: async () => ({}),
    },
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => callback(prisma),
  };
  const service = new ClaimService(
    { ensureExists: async () => ({ ownerAccountId: null }) } as never,
    prisma as never,
  );

  const applied = await service.applyVerificationResult(snapshot, {
    status: 'verified',
    checkedAt: new Date().toISOString(),
  });

  assert.equal(applied, false);
  assert.equal(ownershipUpdates, 0);
});

test('pending claim tokens expire 24 hours after issuance and cannot be verified', async () => {
  const staleMethod = {
    id: 'claim-method-stale',
    serverId: 'server-1',
    accountId: 'account-1',
    method: 'dns',
    token: hashClaimToken('stale-token'),
    issuedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    status: 'pending',
    verifiedAt: null,
    lastCheckedAt: null,
    note: 'token_issued',
    version: 1,
  };
  const updates: Array<Record<string, unknown>> = [];
  const prisma = {
    serverClaimMethod: {
      findMany: async () => [staleMethod],
      findUnique: async () => ({ ...staleMethod, status: updates.length > 0 ? 'expired' : 'pending' }),
      updateMany: async ({ data }: { data: Record<string, unknown> }) => {
        updates.push(data);
        return { count: 1 };
      },
    },
    server: {
      findUnique: async () => ownershipServer(),
      update: async () => ({}),
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
  };
  const service = new ClaimService(
    { ensureExists: async () => ({ ownerAccountId: null }) } as never,
    prisma as never,
  );

  await assert.rejects(
    () => service.verifyMethod('server-1', 'dns', 'stale-token', 'account-1'),
    /만료되었습니다/,
  );
  assert.equal(updates.length, 1);
  assert.equal(updates[0]?.status, 'expired');
  assert.equal(updates[0]?.note, 'token_expired');
});

test('verified ownership proofs do not expire and remain available for scheduled rechecks', async () => {
  const verifiedMethod = {
    id: 'claim-method-verified',
    serverId: 'server-1',
    accountId: 'account-1',
    method: 'dns',
    token: hashClaimToken('persistent-proof'),
    tokenCiphertext: null,
    issuedAt: new Date(Date.now() - 48 * 60 * 60 * 1000),
    status: 'verified',
    verifiedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    lastCheckedAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    note: 'dns_token_confirmed',
    version: 1,
  };
  let expiryWrites = 0;
  const prisma = {
    serverClaimMethod: {
      findMany: async () => [verifiedMethod],
      updateMany: async () => {
        expiryWrites += 1;
        return { count: 1 };
      },
    },
    server: { update: async () => ({}) },
  };
  const server = ownershipServer({
    ownerAccountId: 'account-1',
    verificationGrade: 'VerifiedBasic',
  });
  const service = new ClaimService(
    { ensureExists: async () => server } as never,
    prisma as never,
  );

  const status = await service.getStatus('server-1');

  assert.equal(status.methods[0]?.status, 'verified');
  assert.equal(status.methods[0]?.expiresAt, undefined);
  assert.equal(expiryWrites, 0);
});
