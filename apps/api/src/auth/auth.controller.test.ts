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
    tokenVersion: 1,
    isElevated: true,
    authenticatedAt: new Date().toISOString(),
    authLevel: 'aal1',
    groups: ['owner'],
    permissions: ['admin.audit.read'],
  } satisfies SessionPayload;

  assert.deepEqual(await controller.me(session), {
    id: session.userId,
    displayName: 'Operator',
    access: {
      isElevated: false,
      authLevel: 'aal1',
      stepUpExpiresAt: null,
      stepUpPurpose: null,
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

test('existing OAuth login can start without repeated policy consent', async () => {
  const calls: unknown[][] = [];
  const responseHeaders = new Map<string, string>();
  const controller = new AuthController(
    {} as never,
    {} as never,
    {
      async start(...args: unknown[]) {
        calls.push(args);
        return { authorizationUrl: 'https://provider.example', state: 'state-value', expiresAt: new Date().toISOString() };
      },
    } as never,
  );

  await controller.startOAuth(
    {
      provider: 'discord',
      redirectUri: 'https://minewiki.kr/auth/callback/discord',
      returnTo: '/me',
      agreeTerms: false,
      agreePrivacy: false,
    },
    { headers: {} } as never,
    {
      header(name: string, value: string) {
        responseHeaders.set(name, value);
      },
    } as never,
  );

  assert.deepEqual(calls[0]?.slice(0, 7), [
    'discord',
    'https://minewiki.kr/auth/callback/discord',
    '/me',
    'login',
    undefined,
    false,
    false,
  ]);
  assert.match(String(calls[0]?.[7]), /^[a-f0-9]{64}$/u);
  assert.match(responseHeaders.get('Set-Cookie') ?? '', /^__Host-mw_oauth_browser=/u);
  assert.match(responseHeaders.get('Set-Cookie') ?? '', /HttpOnly/u);
  assert.match(responseHeaders.get('Set-Cookie') ?? '', /Secure/u);
  assert.match(responseHeaders.get('Set-Cookie') ?? '', /SameSite=Lax/u);
});

test('policy reconsent requires explicit agreement and persists request context', async () => {
  const calls: unknown[] = [];
  const controller = new AuthController(
    {} as never,
    {
      async acceptCurrentPolicies(...args: unknown[]) {
        calls.push(args);
        return { required: false };
      },
    } as never,
    {} as never,
  );
  const session = {
    sessionId: 'session-current',
    userId: '11111111-1111-4111-8111-111111111111',
    isElevated: false,
  } satisfies SessionPayload;

  assert.throws(
    () => controller.acceptPolicies(session, { agreeTerms: true }, { headers: {} } as never),
    (error: unknown) => error instanceof ZodError,
  );
  const result = await controller.acceptPolicies(
    session,
    { agreeTerms: true, agreePrivacy: true },
    { headers: { 'user-agent': 'PolicyTest/1.0' } } as never,
  );
  assert.deepEqual(result, { required: false });
  assert.deepEqual(calls, [[session.userId, { ipAddress: null, userAgent: 'PolicyTest/1.0' }]]);
});

test('OAuth completion rejects a browser without its binding cookie before provider exchange', async () => {
  let completeCalls = 0;
  const controller = new AuthController(
    {} as never,
    {} as never,
    {
      async complete() {
        completeCalls += 1;
      },
    } as never,
  );

  await assert.rejects(
    controller.completeOAuth(
      { provider: 'discord', code: 'code', state: 'state-value' },
      {} as never,
      { headers: {} } as never,
    ),
    /OAuth 브라우저 확인 정보가 없습니다/
  );
  assert.equal(completeCalls, 0);
});

test('new OAuth identity continues to first-signup consent without repeating provider auth', async () => {
  const browserBinding = 'a'.repeat(43);
  let pendingCreated = false;
  let setCookie = '';
  const controller = new AuthController(
    {
      async hasOAuthAccount() { return false; },
    } as never,
    {} as never,
    {
      async complete() {
        return {
          provider: 'discord', providerUserId: 'new-discord-user', email: 'new@example.com',
          displayName: 'New user', returnTo: '/servers', mode: 'login', agreeTerms: false,
          agreePrivacy: false, credential: { accessToken: 'provider-token' }
        };
      },
      async createPendingSignup(_profile: unknown, ticketHash: string, receivedBinding: string) {
        assert.match(ticketHash, /^[a-f0-9]{64}$/u);
        assert.equal(receivedBinding, browserBinding);
        pendingCreated = true;
      }
    } as never,
  );

  const result = await controller.completeOAuth(
    { provider: 'discord', code: 'oauth-code', state: 'oauth-state-value', redirectUri: 'https://minewiki.kr/auth/callback/discord' },
    { header(_name: string, value: string) { setCookie = value; } } as never,
    { headers: { cookie: `__Host-mw_oauth_browser=${browserBinding}` } } as never,
  );

  assert.deepEqual(result, { consentRequired: true, provider: 'discord', returnTo: '/servers' });
  assert.equal(pendingCreated, true);
  assert.match(setCookie, /^__Host-mw_oauth_signup=/u);
  assert.match(setCookie, /HttpOnly/u);
  assert.match(setCookie, /SameSite=Strict/u);
});

test('first-signup consent consumes the browser-bound ticket and issues a session', async () => {
  const browserBinding = 'a'.repeat(43);
  const signupToken = 'c'.repeat(43);
  let credentialStored = false;
  let setCookies: string[] = [];
  const controller = new AuthController(
    {
      async handleDiscordCallback() {
        return {
          account: { id: '11111111-1111-4111-8111-111111111111' },
          cookie: 'mw_session=session-value; Path=/; HttpOnly',
          sessionId: 'session-id',
          expiresAt: '2030-01-01T00:00:00.000Z'
        };
      }
    } as never,
    {} as never,
    {
      async consumePendingSignup(receivedToken: string, receivedBinding: string) {
        assert.equal(receivedToken, signupToken);
        assert.equal(receivedBinding, browserBinding);
        return {
          provider: 'discord', providerUserId: 'new-discord-user', email: 'new@example.com',
          displayName: 'New user', returnTo: '/servers', mode: 'login', agreeTerms: true,
          agreePrivacy: true, credential: { accessToken: 'provider-token' }
        };
      },
      async storeCredential() { credentialStored = true; }
    } as never,
  );

  const result = await controller.acceptOAuthSignupConsent(
    { agreeTerms: true, agreePrivacy: true },
    { header(_name: string, value: string[]) { setCookies = value; } } as never,
    { headers: { cookie: `__Host-mw_oauth_browser=${browserBinding}; __Host-mw_oauth_signup=${signupToken}` } } as never,
  );

  assert.equal(result.consentRequired, false);
  assert.equal(result.returnTo, '/servers');
  assert.equal(credentialStored, true);
  assert.equal(setCookies.length, 2);
  assert.match(setCookies[1] ?? '', /Max-Age=0/u);
});

test('changing a password revokes every other active session', async () => {
  const calls: string[] = [];
  const controller = new AuthController(
    {
      async changePassword(accountId: string, _currentPassword: string, _newPassword: string, sessionId: string) {
        calls.push(`password:${accountId}:${sessionId}`);
      },
    } as never,
    {
      async revokeAllSessions() {
        throw new Error('session revocation must be part of the password transaction');
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
    `password:${session.userId}:${session.sessionId}`,
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
