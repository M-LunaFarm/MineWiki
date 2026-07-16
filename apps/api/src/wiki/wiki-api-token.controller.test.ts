import assert from 'node:assert/strict';
import test from 'node:test';
import type { SessionPayload } from '../session/session.service';
import { WikiApiTokenController } from './wiki-api-token.controller';
import type { WikiApiTokenService } from './wiki-api-token.service';

const session: SessionPayload = {
  sessionId: 'session-id',
  userId: 'account-id',
  tokenVersion: 1,
  isElevated: false,
  authenticatedAt: new Date().toISOString(),
};

test('Wiki API token management delegates list, create, and revoke to the token service', async () => {
  const calls: Array<{ method: string; args: unknown[] }> = [];
  const service = {
    async list(...args: unknown[]) {
      calls.push({ method: 'list', args });
      return [];
    },
    async create(...args: unknown[]) {
      calls.push({ method: 'create', args });
      return { id: 'created-token' };
    },
    async listSpaces(...args: unknown[]) {
      calls.push({ method: 'listSpaces', args });
      return [{ id: '9', name: '서버 Wiki', path: '/server/test', type: 'server_wiki' }];
    },
    async revoke(...args: unknown[]) {
      calls.push({ method: 'revoke', args });
      return { revoked: true as const };
    },
  } as unknown as WikiApiTokenService;
  const controller = new WikiApiTokenController(service);
  const body = { name: 'CI', scopes: ['wiki:read'], expiresInDays: 30 };

  assert.deepEqual(await controller.list(session), []);
  assert.deepEqual(await controller.listSpaces(session), [{ id: '9', name: '서버 Wiki', path: '/server/test', type: 'server_wiki' }]);
  assert.deepEqual(await controller.create(body, session), { id: 'created-token' });
  assert.deepEqual(await controller.revoke('token-id', session), { revoked: true });
  assert.deepEqual(calls, [
    { method: 'list', args: ['account-id'] },
    { method: 'listSpaces', args: [session] },
    { method: 'create', args: [session, body] },
    { method: 'revoke', args: [session, 'token-id'] },
  ]);
});
