import assert from 'node:assert/strict';
import test from 'node:test';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { AccountDeletionController } from './account-deletion.controller';
import { AccountDeletionAdminController } from './account-deletion-admin.controller';
import { AccountDeletionInternalController } from './account-deletion-internal.controller';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { deriveAccountDeletionServiceToken } from '@minewiki/auth';

test('account termination request requires an authenticated session while cancel uses its one-time token', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, AccountDeletionController.prototype.request) as unknown[] | undefined;
  const cancelGuards = Reflect.getMetadata(GUARDS_METADATA, AccountDeletionController.prototype.cancel) as unknown[] | undefined;
  assert.ok(guards?.includes(SessionGuard));
  assert.equal(cancelGuards, undefined);
});

test('account termination admin processing rejects ordinary users', () => {
  const controller = new AccountDeletionAdminController({} as never);
  const session = { sessionId: 's', userId: 'user', isElevated: false, authenticatedAt: new Date().toISOString(), groups: ['member'], permissions: [] } satisfies SessionPayload;
  assert.throws(() => controller.list(session), (error: unknown) => error instanceof ForbiddenException);
});

test('recent elevation alone never grants account termination administration', () => {
  const controller = new AccountDeletionAdminController({} as never);
  const session = { sessionId: 's', userId: 'user', isElevated: true, authenticatedAt: new Date().toISOString(), groups: ['member'], permissions: [] } satisfies SessionPayload;
  assert.throws(() => controller.list(session), (error: unknown) => error instanceof ForbiddenException);
});

test('account termination admin forwards the authenticated administrator identity', async () => {
  let received: unknown;
  const controller = new AccountDeletionAdminController({
    async process(requestId: string, accountId: string, note?: string) { received = { requestId, accountId, note }; return {}; }
  } as never);
  const session = { sessionId: 's', userId: 'admin', isElevated: false, authenticatedAt: new Date().toISOString(), groups: ['admin'], permissions: [] } satisfies SessionPayload;
  await controller.process('request-1', { note: 'reviewed' }, session);
  assert.deepEqual(received, { requestId: 'request-1', accountId: 'admin', note: 'reviewed' });
});

test('account termination worker endpoint rejects a missing or mismatched internal token', () => {
  const controller = new AccountDeletionInternalController(
    {} as never,
    { get: () => 'application-encryption-key' } as never,
  );
  assert.throws(() => controller.processDue(undefined), (error: unknown) => error instanceof UnauthorizedException);
  assert.throws(() => controller.processDue('Bearer wrong-secret'), (error: unknown) => error instanceof UnauthorizedException);
});

test('account termination worker endpoint uses the service identity and caps limit in the service', async () => {
  let received: unknown;
  const controller = new AccountDeletionInternalController(
    { async processDue(actor: string, limit: number) { received = { actor, limit }; return { processed: 0, blocked: 0, failed: 0 }; } } as never,
    { get: () => 'application-encryption-key' } as never,
  );
  await controller.processDue(`Bearer ${deriveAccountDeletionServiceToken('application-encryption-key')}`, '75');
  assert.deepEqual(received, { actor: 'internal:account-deletion-worker', limit: 75 });
});
