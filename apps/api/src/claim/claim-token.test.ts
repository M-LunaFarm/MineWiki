import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaimService, hashClaimToken, matchesClaimToken } from './claim.service';
import { decryptAppSecret } from '../common/secret-codec';

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
    serverClaimMethod: {
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [verifiedMethod],
    },
    server: {
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

  assert.deepEqual(gradeUpdates, [{ verificationGrade: 'Unverified', verifiedAt: null }]);
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
