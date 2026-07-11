import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';

test('me endpoint requires session guard', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.me) as
    | unknown[]
    | undefined;
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(SessionGuard));
});

test('account detail endpoint requires session guard', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.getAccount) as
    | unknown[]
    | undefined;
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(SessionGuard));
});

test('account detail endpoint only returns the current account', async () => {
  let requestedAccountId: string | undefined;
  const controller = new AuthController(
    {
      async getAccountView(accountId: string) {
        requestedAccountId = accountId;
        return { id: accountId };
      },
    } as never,
    {} as never,
    {} as never,
  );
  const session = {
    sessionId: 'session-1',
    userId: '11111111-1111-4111-8111-111111111111',
    isElevated: false,
  } satisfies SessionPayload;

  assert.throws(
    () => controller.getAccount('22222222-2222-4222-8222-222222222222', session),
    /본인 계정만 조회할 수 있습니다/,
  );
  assert.equal(requestedAccountId, undefined);

  const account = await controller.getAccount(session.userId, session);
  assert.deepEqual(account, { id: session.userId });
  assert.equal(requestedAccountId, session.userId);
});
