import { test } from 'node:test';
import assert from 'node:assert/strict';
import { encryptSecret } from '@minewiki/security';
import { createClaimVerifier, resolveVerificationProof } from './claim-verifier';

test('worker decrypts the automatic verification proof without using its hash', () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = 'claim-worker-test-key';
  try {
    const proof = 'plain-claim-proof';
    const ciphertext = encryptSecret(proof, process.env.APP_ENCRYPTION_KEY);
    assert.equal(resolveVerificationProof(`sha256:${'a'.repeat(64)}`, ciphertext), proof);
    assert.equal(resolveVerificationProof(`sha256:${'a'.repeat(64)}`, null), null);
    assert.equal(resolveVerificationProof('legacy-plain-proof', null), 'legacy-plain-proof');
  } finally {
    if (previousKey === undefined) {
      delete process.env.APP_ENCRYPTION_KEY;
    } else {
      process.env.APP_ENCRYPTION_KEY = previousKey;
    }
  }
});

test('hash-only claim records remain pending instead of being falsely failed', async () => {
  const updates: unknown[] = [];
  const prisma = {
    serverClaimMethod: {
      findUnique: async () => ({
        id: 'claim-method-1',
        serverId: '11111111-1111-4111-8111-111111111111',
        method: 'dns',
        version: 1,
        status: 'pending',
        issuedAt: new Date(),
        verifiedAt: null,
        token: `sha256:${'b'.repeat(64)}`,
        tokenCiphertext: null,
      }),
      updateMany: async (args: unknown) => {
        updates.push(args);
        return { count: 1 };
      },
    },
  };
  const verifier = createClaimVerifier(prisma as never);

  const result = await verifier.verify({
    serverId: '11111111-1111-4111-8111-111111111111',
    method: 'dns',
    initiatedAt: '2026-07-11T00:00:00.000Z',
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.note, 'verification_proof_unavailable');
  assert.equal(updates.length, 1);
  assert.equal(JSON.stringify(updates).includes('"status"'), false);
});

test('stale pending proof expires without performing an external check', async () => {
  const fixedNow = new Date('2026-07-12T12:00:00.000Z');
  let checkCalls = 0;
  let serverUpdates = 0;
  const record = {
    id: 'claim-method-1',
    serverId: 'server-1',
    accountId: 'account-1',
    method: 'dns',
    version: 1,
    token: 'legacy-proof',
    tokenCiphertext: null,
    issuedAt: new Date(fixedNow.getTime() - 25 * 60 * 60 * 1000),
    status: 'pending',
    verifiedAt: null,
  };
  const prisma = {
    serverClaimMethod: {
      findUnique: async () => record,
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [{ method: 'dns', status: 'expired' }],
    },
    server: {
      update: async () => {
        serverUpdates += 1;
        return {};
      },
    },
  };
  const verifier = createClaimVerifier(prisma as never, {
    now: () => fixedNow,
    runVerificationCheck: async () => {
      checkCalls += 1;
      throw new Error('must not run');
    },
  });

  const result = await verifier.verify({
    serverId: 'server-1',
    method: 'dns',
    initiatedAt: fixedNow.toISOString(),
  });

  assert.equal(result.status, 'expired');
  assert.equal(result.note, 'token_expired');
  assert.equal(checkCalls, 0);
  assert.equal(serverUpdates, 1);
});

test('proof rotation during verification discards the stale result', async () => {
  const fixedNow = new Date('2026-07-12T12:00:00.000Z');
  let serverUpdates = 0;
  const record = {
    id: 'claim-method-1',
    serverId: 'server-1',
    accountId: 'account-1',
    method: 'dns',
    version: 1,
    token: 'proof-a',
    tokenCiphertext: null,
    issuedAt: new Date(fixedNow.getTime() - 60_000),
    status: 'pending',
    verifiedAt: null,
  };
  const prisma = {
    serverClaimMethod: {
      findUnique: async () => record,
      updateMany: async () => ({ count: 0 }),
      findMany: async () => [],
    },
    server: {
      update: async () => {
        serverUpdates += 1;
        return {};
      },
    },
  };
  const verifier = createClaimVerifier(prisma as never, {
    now: () => fixedNow,
    runVerificationCheck: async () => ({
      status: 'verified',
      checkedAt: fixedNow.toISOString(),
      note: 'dns_token_confirmed',
    }),
  });

  const result = await verifier.verify({
    serverId: 'server-1',
    method: 'dns',
    initiatedAt: fixedNow.toISOString(),
  });

  assert.equal(result.status, 'pending');
  assert.equal(result.note, 'claim_generation_changed');
  assert.equal(serverUpdates, 0);
});

test('successful verification activates only a pending listing', async () => {
  const fixedNow = new Date('2026-07-12T12:00:00.000Z');
  const listingUpdates: unknown[] = [];
  const record = {
    id: 'claim-method-1',
    serverId: 'server-1',
    accountId: 'account-1',
    method: 'dns',
    version: 1,
    token: 'proof-a',
    tokenCiphertext: null,
    issuedAt: new Date(fixedNow.getTime() - 60_000),
    status: 'pending',
    verifiedAt: null,
  };
  const prisma = {
    serverClaimMethod: {
      findUnique: async () => record,
      updateMany: async () => ({ count: 1 }),
      findMany: async () => [{ method: 'dns', status: 'verified' }],
    },
    server: {
      update: async () => ({}),
      updateMany: async (query: unknown) => {
        listingUpdates.push(query);
        return { count: 1 };
      },
    },
  };

  const result = await createClaimVerifier(prisma as never, {
    now: () => fixedNow,
    runVerificationCheck: async () => ({
      status: 'verified',
      checkedAt: fixedNow.toISOString(),
      note: 'dns_token_confirmed',
    }),
  }).verify({
    serverId: 'server-1',
    method: 'dns',
    initiatedAt: fixedNow.toISOString(),
  });

  assert.equal(result.status, 'verified');
  assert.deepEqual(listingUpdates, [{
    where: { id: 'server-1', listingStatus: 'pending' },
    data: { listingStatus: 'active' },
  }]);
});
