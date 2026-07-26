import assert from 'node:assert/strict';
import test from 'node:test';
import { MinecraftController } from './minecraft.controller';
import type { MinecraftService } from './minecraft.service';
import type { SessionPayload } from '../session/session.service';

function session(authenticatedAt: string): SessionPayload {
  return {
    sessionId: 'session-id',
    userId: '00000000-0000-4000-8000-000000000001',
    isElevated: false,
    authenticatedAt,
  };
}

test('Minecraft authorization accepts an authenticated session regardless of login age', async () => {
  let called = false;
  const service = {
    startAuthorization: async () => {
      called = true;
      return { authorizationUrl: 'https://example.com', state: 'state-value' };
    },
  } as unknown as MinecraftService;
  const controller = new MinecraftController(service);

  await controller.startOAuth({}, session(new Date(0).toISOString()));
  assert.equal(called, true);
});

test('Minecraft primary selection and revoke accept an authenticated session regardless of login age', async () => {
  const calls: string[] = [];
  const service = {
    setPrimaryIdentity: async () => {
      calls.push('primary');
      return {};
    },
    revokeIdentity: async (_userId: string, minecraftUuid?: string) => {
      calls.push(minecraftUuid ? 'revoke-selected' : 'revoke-own');
    },
  } as unknown as MinecraftService;
  const controller = new MinecraftController(service);
  const stale = session(new Date(Date.now() - 16 * 60 * 1000).toISOString());

  await controller.setPrimaryIdentity('00000000-0000-4000-8000-000000000002', stale);
  await controller.revokeOwnIdentity(stale);
  await controller.revokeSelectedIdentity(
    '00000000-0000-4000-8000-000000000002',
    stale,
  );
  assert.deepEqual(calls, ['primary', 'revoke-own', 'revoke-selected']);
});
