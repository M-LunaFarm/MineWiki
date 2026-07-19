import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException } from '@nestjs/common';
import { ServerVerificationController } from './server-verification.controller';
import type { SessionPayload } from '../session/session.service';

const session: SessionPayload = {
  sessionId: 'session-1',
  userId: 'account-1',
  tokenVersion: 1,
  isElevated: false,
  authenticatedAt: new Date().toISOString(),
  groups: [],
  permissions: [],
};

test('verification recheck delegates a real proof to the claim verifier', async () => {
  const calls: unknown[][] = [];
  const expected = { serverId: '11111111-1111-4111-8111-111111111111', methods: [] };
  const controller = new ServerVerificationController({
    verifyMethod: async (...args: unknown[]) => {
      calls.push(args);
      return expected;
    },
  } as never);

  const result = await controller.recheck(expected.serverId, {
    method: 'dns',
    proof: ' proof-token ',
  }, session);

  assert.equal(result, expected);
  assert.deepEqual(calls, [[expected.serverId, 'dns', 'proof-token', session.userId]]);
});

test('verification recheck rejects client-asserted pass or failure flags', async () => {
  const controller = new ServerVerificationController({
    verifyMethod: async () => {
      throw new Error('must not run');
    },
  } as never);

  await assert.rejects(
    controller.recheck('11111111-1111-4111-8111-111111111111', { passed: true }, session),
    BadRequestException,
  );
});
