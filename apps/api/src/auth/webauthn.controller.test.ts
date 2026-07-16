import assert from 'node:assert/strict';
import { test } from 'node:test';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ZodError } from 'zod';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WebAuthnController } from './webauthn.controller';

const session: SessionPayload = {
  sessionId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userId: '11111111-1111-4111-8111-111111111111',
  tokenVersion: 3,
  isElevated: false,
  authenticatedAt: new Date().toISOString(),
  authLevel: 'aal2',
  stepUpAt: new Date(Date.now() - 10_000).toISOString(),
  stepUpExpiresAt: new Date(Date.now() + 250_000).toISOString(),
  stepUpMethod: 'webauthn',
  stepUpPurpose: 'mfa_manage',
};

test('all passkey endpoints inherit authenticated CSRF-aware session protection', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, WebAuthnController) as unknown[] | undefined;
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(SessionGuard));
});

test('controller bounds and strictly parses WebAuthn responses before service calls', async () => {
  let calls = 0;
  const controller = new WebAuthnController(new Proxy({}, {
    get() {
      return async () => { calls += 1; };
    },
  }) as never);

  assert.throws(() => controller.finishRegistration({
    ceremonyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Laptop',
    unexpected: true,
    response: registrationResponse(),
  }, session), (error: unknown) => error instanceof ZodError);
  assert.throws(() => controller.finishRegistration({
    ceremonyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    name: 'Laptop',
    response: {
      ...registrationResponse(),
      response: {
        ...registrationResponse().response,
        attestationObject: 'a'.repeat(262_145),
      },
    },
  }, session), (error: unknown) => error instanceof ZodError);
  assert.throws(() => controller.beginStepUp({ purpose: 'passwordless_login' }, session),
    (error: unknown) => error instanceof ZodError);
  assert.equal(calls, 0);
});

test('verified step-up sets the rotated cookie and reports WebAuthn as the method', async () => {
  let receivedPurpose: string | undefined;
  const controller = new WebAuthnController({
    async finishStepUp(_session: SessionPayload, input: { purpose: string }) {
      receivedPurpose = input.purpose;
      return {
        purpose: input.purpose,
        session: {
          sessionId: session.sessionId,
          cookie: 'mw_session=rotated; Secure',
          expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
          stepUpExpiresAt: new Date(Date.now() + 300_000).toISOString(),
          policyConsent: { required: false },
        },
      };
    },
  } as never);
  const headers = new Map<string, string>();
  const result = await controller.finishStepUp({
    ceremonyId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    purpose: 'wiki_admin',
    response: authenticationResponse(),
  }, session, {
    header(name: string, value: string) { headers.set(name, value); },
  } as never);

  assert.equal(receivedPurpose, 'wiki_admin');
  assert.equal(headers.get('Set-Cookie'), 'mw_session=rotated; Secure');
  assert.equal(result.method, 'webauthn');
  assert.equal(result.authLevel, 'aal2');
});

test('delete endpoint delegates only the parsed path owner operation and rotates the cookie', async () => {
  let deletedId: string | undefined;
  const controller = new WebAuthnController({
    async deletePasskey(_session: SessionPayload, passkeyId: string) {
      deletedId = passkeyId;
      return {
        session: {
          cookie: 'mw_session=after-delete',
        },
      };
    },
  } as never);
  const headers = new Map<string, string>();
  const result = await controller.deletePasskey(
    '33333333-3333-4333-8333-333333333333',
    session,
    { header(name: string, value: string) { headers.set(name, value); } } as never,
  );
  assert.equal(deletedId, '33333333-3333-4333-8333-333333333333');
  assert.equal(headers.get('Set-Cookie'), 'mw_session=after-delete');
  assert.deepEqual(result, { deleted: true });
});

function registrationResponse() {
  return {
    id: 'credential-id',
    rawId: 'credential-id',
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'Y2xpZW50',
      attestationObject: 'YXR0ZXN0YXRpb24',
      transports: ['internal'],
    },
  };
}

function authenticationResponse() {
  return {
    id: 'credential-id',
    rawId: 'credential-id',
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'Y2xpZW50',
      authenticatorData: 'YXV0aA',
      signature: 'c2lnbmF0dXJl',
    },
  };
}
