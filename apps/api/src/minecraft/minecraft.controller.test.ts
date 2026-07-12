import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException } from '@nestjs/common';
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

test('Minecraft authorization accepts a recently authenticated session', async () => {
  let called = false;
  const service = {
    startAuthorization: async () => {
      called = true;
      return { authorizationUrl: 'https://example.com', state: 'state-value', codeVerifier: 'x'.repeat(43) };
    },
  } as unknown as MinecraftService;
  const controller = new MinecraftController(service);

  await controller.startOAuth({}, session(new Date().toISOString()));
  assert.equal(called, true);
});

test('Minecraft authorization and revoke reject an old session', async () => {
  const service = {
    startAuthorization: async () => assert.fail('service must not be called'),
    revokeIdentity: async () => assert.fail('service must not be called'),
  } as unknown as MinecraftService;
  const controller = new MinecraftController(service);
  const stale = session(new Date(Date.now() - 16 * 60 * 1000).toISOString());

  assert.throws(() => controller.startOAuth({}, stale), ForbiddenException);
  await assert.rejects(() => controller.revokeOwnIdentity(stale), ForbiddenException);
});
