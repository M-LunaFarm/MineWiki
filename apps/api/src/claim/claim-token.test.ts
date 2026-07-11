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
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = 'claim-token-test-key';
  const serverService = {
    ensureExists: async () => ({ ownerAccountId: null }),
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
      update: async () => ({}),
    },
    $transaction: async (operations: Array<Promise<unknown>>) => Promise.all(operations),
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
  } finally {
    if (previousKey === undefined) {
      delete process.env.APP_ENCRYPTION_KEY;
    } else {
      process.env.APP_ENCRYPTION_KEY = previousKey;
    }
  }
});

test('plugin claim tokens cannot be issued without an authenticated plugin proof', async () => {
  const service = new ClaimService(
    { ensureExists: async () => ({ ownerAccountId: null }) } as never,
    {} as never,
  );

  await assert.rejects(
    () => service.issueTokens('server-1', 'account-1', ['plugin']),
    /Plugin ownership verification is unavailable/,
  );
});
