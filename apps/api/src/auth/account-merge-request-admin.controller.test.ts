import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import type { SessionPayload } from '../session/session.service';
import { AccountMergeRequestAdminController } from './account-merge-request-admin.controller';

function session(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: 'session',
    userId: 'account',
    tokenVersion: 1,
    isElevated: false,
    authenticatedAt: new Date().toISOString(),
    ...overrides,
  };
}

test('account merge decisions reject ordinary authenticated users', () => {
  const controller = new AccountMergeRequestAdminController({} as never);
  assert.throws(
    () => controller.approve('request', {}, session()),
    (error: unknown) => error instanceof ForbiddenException,
  );
});

test('dedicated account merge permission can operate the workflow', async () => {
  const calls: unknown[] = [];
  const service = {
    async list(status?: string) { calls.push(['list', status]); return []; },
    async approve(id: string, accountId: string, body: unknown) { calls.push(['approve', id, accountId, body]); return { status: 'completed' }; },
    async reject(id: string, accountId: string, body: unknown) { calls.push(['reject', id, accountId, body]); return { status: 'rejected' }; },
  };
  const controller = new AccountMergeRequestAdminController(service as never);
  const actor = session({ permissions: ['admin.account.merge'] });
  await controller.list(actor, 'pending');
  await controller.approve('one', { version: 1 }, actor);
  await controller.reject('two', { version: 2 }, actor);
  assert.deepEqual(calls, [
    ['list', 'pending'],
    ['approve', 'one', 'account', { version: 1 }],
    ['reject', 'two', 'account', { version: 2 }],
  ]);
});

test('account merge mutations have explicit operation throttles', () => {
  for (const method of ['approve', 'reject'] as const) {
    const handler = AccountMergeRequestAdminController.prototype[method];
    assert.ok(Reflect.getMetadata('THROTTLER:LIMITdefault', handler));
    assert.ok(Reflect.getMetadata('THROTTLER:TTLdefault', handler));
  }
});
