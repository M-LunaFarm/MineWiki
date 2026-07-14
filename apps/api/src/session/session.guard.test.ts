import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, type ExecutionContext } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { OptionalSessionGuard } from './optional-session.guard';
import { SessionGuard } from './session.guard';

const requiredPolicy = {
  required: true,
  terms: { currentVersion: 'terms-v2', acceptedVersion: 'terms-v1', accepted: false },
  privacy: { currentVersion: 'privacy-v2', acceptedVersion: null, accepted: false },
};

test('required policy consent blocks authenticated mutations but keeps reads available', async () => {
  const guard = new SessionGuard(sessionService() as never);
  await assert.rejects(
    () => guard.canActivate(context('PATCH', '/v1/wiki/pages/1')),
    (error: unknown) => error instanceof ForbiddenException,
  );
  assert.equal(await guard.canActivate(context('GET', '/v1/wiki/pages/1')), true);
});

test('policy acceptance and logout remain available while consent is required', async () => {
  const guard = new SessionGuard(sessionService() as never);
  assert.equal(await guard.canActivate(context('POST', '/v1/auth/policies/accept')), true);
  assert.equal(await guard.canActivate(context('POST', '/v1/auth/logout')), true);
});

test('optional authenticated mutation paths enforce the same policy gate', async () => {
  const guard = new OptionalSessionGuard(sessionService() as never);
  await assert.rejects(
    () => guard.canActivate(context('PATCH', '/v1/guilds/1/settings')),
    (error: unknown) => error instanceof ForbiddenException,
  );
});

function sessionService() {
  const session = { sessionId: 'session-id', token: 'session-token' };
  return {
    async getSessionByToken() {
      return session;
    },
    async touchSession() {},
    toPayload() {
      return {
        sessionId: 'session-id',
        userId: 'account-id',
        isElevated: false,
        authenticatedAt: new Date().toISOString(),
        policyConsent: requiredPolicy,
      };
    },
  };
}

function context(method: string, url: string): ExecutionContext {
  const request = {
    method,
    url,
    headers: {
      cookie: 'mw_session=session-token',
      'sec-fetch-site': 'same-origin',
    },
  } as unknown as FastifyRequest;
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}
