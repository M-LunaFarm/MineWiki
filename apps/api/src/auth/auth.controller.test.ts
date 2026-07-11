import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { AuthController } from './auth.controller';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { ZodError } from 'zod';

test('me endpoint requires session guard', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, AuthController.prototype.me) as
    | unknown[]
    | undefined;
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(SessionGuard));
});

test('me endpoint returns session-derived access without probing an admin resource', async () => {
  const controller = new AuthController(
    {
      async getAccountView(accountId: string) {
        return { id: accountId, displayName: 'Operator' };
      },
    } as never,
    {} as never,
    {} as never,
  );
  const session = {
    sessionId: 'session-1',
    userId: '11111111-1111-4111-8111-111111111111',
    isElevated: true,
    groups: ['owner'],
    permissions: ['admin.audit.read'],
  } satisfies SessionPayload;

  assert.deepEqual(await controller.me(session), {
    id: session.userId,
    displayName: 'Operator',
    access: {
      isElevated: true,
      roles: ['owner'],
      permissions: ['admin.audit.read'],
    },
  });
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

test('unverified identity and manual account-link callbacks are not exposed', () => {
  const prototype = AuthController.prototype as unknown as Record<string, unknown>;
  assert.equal(prototype.discordCallback, undefined);
  assert.equal(prototype.naverCallback, undefined);
  assert.equal(prototype.createLinkRequest, undefined);
  assert.equal(prototype.confirmLink, undefined);
});

test('email auth endpoints reject malformed request bodies before calling the service', async () => {
  let serviceCalls = 0;
  const controller = new AuthController(
    new Proxy(
      {},
      {
        get() {
          return async () => {
            serviceCalls += 1;
          };
        },
      },
    ) as never,
    {} as never,
    {} as never,
  );

  const invalidCalls = [
    () => controller.registerEmail({}, { headers: {} } as never),
    () =>
      controller.registerEmail(
        {
          email: 'player@example.com',
          password: 'ValidPassword1!',
          displayName: 'Player',
        },
        { headers: {} } as never,
      ),
    () => controller.resendVerification({ email: 'not-an-email' }),
    () => controller.setupEmailLogin(
      { userId: '11111111-1111-4111-8111-111111111111' } as SessionPayload,
      { email: 'player@example.com' },
    ),
    () => controller.requestPasswordReset(null),
    () => controller.resetPassword({ token: '', newPassword: 'ValidPassword1!' }),
  ];

  for (const invoke of invalidCalls) {
    assert.throws(invoke, (error: unknown) => error instanceof ZodError);
  }
  assert.equal(serviceCalls, 0);
});

test('email auth request parsing trims canonical text fields', async () => {
  let registrationPayload: unknown;
  let resendEmail: string | undefined;
  const controller = new AuthController(
    {
      async registerEmail(payload: unknown) {
        registrationPayload = payload;
        return {};
      },
      async resendVerification(email: string) {
        resendEmail = email;
        return {};
      },
    } as never,
    {} as never,
    {} as never,
  );

  await controller.registerEmail({
    email: '  Player@Example.com  ',
    password: 'ValidPassword1!',
    displayName: '  Player  ',
    agreeTerms: true,
    agreePrivacy: true,
  }, { headers: {} } as never);
  await controller.resendVerification({ email: '  Player@Example.com  ' });

  assert.deepEqual(registrationPayload, {
    email: 'Player@Example.com',
    password: 'ValidPassword1!',
    displayName: 'Player',
    agreeTerms: true,
    agreePrivacy: true,
    context: { ipAddress: null, userAgent: null },
  });
  assert.equal(resendEmail, 'Player@Example.com');
});

test('changing a password revokes every other active session', async () => {
  const calls: string[] = [];
  const controller = new AuthController(
    {
      async changePassword(accountId: string) {
        calls.push(`password:${accountId}`);
      },
    } as never,
    {
      async revokeAllSessions(accountId: string, exceptSessionId: string) {
        calls.push(`revoke:${accountId}:${exceptSessionId}`);
      },
    } as never,
    {} as never,
  );
  const session = {
    sessionId: 'session-current',
    userId: '11111111-1111-4111-8111-111111111111',
    isElevated: false,
  } satisfies SessionPayload;

  const result = await controller.changePassword(session, {
    currentPassword: 'CurrentPW1!',
    newPassword: 'UpdatedPW1!',
  });

  assert.deepEqual(result, { success: true });
  assert.deepEqual(calls, [
    `password:${session.userId}`,
    `revoke:${session.userId}:${session.sessionId}`,
  ]);
});

test('password change rejects malformed and oversized request bodies', async () => {
  const controller = new AuthController({} as never, {} as never, {} as never);
  const session = {
    sessionId: 'session-current',
    userId: '11111111-1111-4111-8111-111111111111',
    isElevated: false,
  } satisfies SessionPayload;

  const invalidBodies = [
    {},
    { currentPassword: 'CurrentPW1!' },
    { currentPassword: 'CurrentPW1!', newPassword: 'UpdatedPW1!', elevated: true },
    { currentPassword: 'x'.repeat(129), newPassword: 'UpdatedPW1!' },
  ];
  for (const body of invalidBodies) {
    await assert.rejects(
      () => controller.changePassword(session, body),
      (error: unknown) => error instanceof ZodError,
    );
  }
});
