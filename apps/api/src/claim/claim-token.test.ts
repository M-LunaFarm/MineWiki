import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ClaimService, hashClaimToken, matchesClaimToken } from './claim.service';

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

test('token issuance stores only a hash and reveals the token once', async () => {
  let storedToken = '';
  const serverService = {
    ensureExists: async () => ({ ownerAccountId: null }),
  };
  const prisma = {
    serverClaimMethod: {
      upsert: async ({ create }: { create: Record<string, unknown> }) => {
        storedToken = String(create.token);
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
  const service = new ClaimService(serverService as never, prisma as never);

  const [issued] = await service.issueTokens('server-1', 'account-1', ['plugin']);

  assert.ok(issued?.token);
  assert.match(storedToken, /^sha256:[a-f0-9]{64}$/);
  assert.notEqual(storedToken, issued.token);
  assert.equal(matchesClaimToken(storedToken, issued.token), true);
});
