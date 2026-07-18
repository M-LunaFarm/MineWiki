import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException } from '@nestjs/common';
import { SUPPORTED_CLAIM_METHODS } from '@minewiki/schemas/claim-methods';
import { ClaimController } from './claim.controller';

test('claim start and verify expose exactly the shared supported methods', async () => {
  const starts: unknown[] = [];
  const verifications: unknown[] = [];
  const service = {
    issueTokens: async (...args: unknown[]) => {
      starts.push(args);
      return [];
    },
    verifyMethod: async (...args: unknown[]) => {
      verifications.push(args);
      return { serverId: 'server-1', grade: 'Unverified', methods: [] };
    },
  };
  const controller = new ClaimController(service as never);
  const session = { userId: 'account-1' } as never;

  for (const method of SUPPORTED_CLAIM_METHODS) {
    await controller.start('server-1', { methods: [method] }, session);
    await controller.verify('server-1', { method, proof: 'proof' }, session);
  }

  assert.deepEqual(starts.map((call) => (call as unknown[])[2]), [['dns'], ['motd']]);
  assert.deepEqual(verifications.map((call) => (call as unknown[])[1]), ['dns', 'motd']);
  await assert.rejects(
    () => controller.start('server-1', { methods: ['plugin'] } as never, session),
    BadRequestException,
  );
  await assert.rejects(
    () => controller.verify('server-1', { method: 'plugin', proof: 'proof' } as never, session),
    BadRequestException,
  );
});
