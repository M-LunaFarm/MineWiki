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
        status: 'pending',
        verifiedAt: null,
        token: `sha256:${'b'.repeat(64)}`,
        tokenCiphertext: null,
      }),
      update: async (args: unknown) => {
        updates.push(args);
        return {};
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
