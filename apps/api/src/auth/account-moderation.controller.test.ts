import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'reflect-metadata';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AccountModerationController } from './account-moderation.controller';
import { SessionGuard } from '../session/session.guard';
import { StepUpGuard, STEP_UP_PURPOSE_METADATA } from '../session/step-up.guard';
import type { SessionPayload } from '../session/session.service';

const actorId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';

function session(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: 'session-admin',
    userId: actorId,
    tokenVersion: 2,
    isElevated: false,
    authenticatedAt: new Date().toISOString(),
    authLevel: 'aal2',
    stepUpAt: new Date().toISOString(),
    stepUpExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    stepUpMethod: 'totp',
    stepUpPurpose: 'account_moderation',
    groups: ['admin'],
    permissions: ['admin.account.suspend'],
    ...overrides,
  };
}

test('account moderation endpoints require session auth and account_moderation step-up', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, AccountModerationController) as unknown[] | undefined;
  assert.ok(guards?.includes(SessionGuard));
  assert.ok(guards?.includes(StepUpGuard));
  assert.equal(
    Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, AccountModerationController),
    'account_moderation',
  );
});

test('owner or admin group membership does not replace the dedicated suspension permission', () => {
  const controller = new AccountModerationController({} as never);
  assert.throws(
    () => controller.list(session({ groups: ['owner'], permissions: [] })),
    ForbiddenException,
  );
});

test('admin account list parses bounded filters and forwards them', async () => {
  let received: unknown;
  const controller = new AccountModerationController({
    async list(input: unknown) {
      received = input;
      return { accounts: [] };
    },
  } as never);

  await controller.list(session(), ' target ', 'suspended', '25');

  assert.deepEqual(received, { q: 'target', status: 'suspended', limit: 25 });
});

test('suspend and restore require route-specific expected status and forward actor identity', async () => {
  const calls: unknown[] = [];
  const controller = new AccountModerationController({
    async suspend(...args: unknown[]) { calls.push(['suspend', ...args]); return {}; },
    async restore(...args: unknown[]) { calls.push(['restore', ...args]); return {}; },
  } as never);
  const actor = session();

  await controller.suspend(targetId, {
    reason: '긴급 계정 보안 사고 대응',
    confirmation: targetId,
    expectedStatus: 'active',
  }, actor);
  await controller.restore(targetId, {
    reason: '보안 검토와 복구 절차 완료',
    confirmation: targetId,
    expectedStatus: 'suspended',
  }, actor);

  assert.deepEqual(calls.map((call) => (call as unknown[]).slice(0, 3)), [
    ['suspend', actorId, targetId],
    ['restore', actorId, targetId],
  ]);
  assert.throws(() => controller.suspend(targetId, {
    reason: '긴급 계정 보안 사고 대응',
    confirmation: targetId,
    expectedStatus: 'suspended',
  }, actor));
  assert.throws(() => controller.restore(targetId, {
    reason: '보안 검토와 복구 절차 완료',
    confirmation: targetId,
    expectedStatus: 'active',
  }, actor));
});
