import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reflector } from '@nestjs/core';
import { StepUpGuard } from './step-up.guard';

function context(payload: Record<string, unknown> | undefined, purpose?: string) {
  class Controller {}
  const handler = () => undefined;
  if (purpose) Reflect.defineMetadata('minewiki:step-up-purpose', purpose, handler);
  return {
    getHandler: () => handler,
    getClass: () => Controller,
    switchToHttp: () => ({ getRequest: () => ({ sessionPayload: payload }) }),
  } as never;
}

test('step-up guard requires matching fresh AAL2 and never grants authority itself', () => {
  const guard = new StepUpGuard(new Reflector());
  const base = {
    sessionId: 'session-1',
    userId: 'account-1',
    tokenVersion: 2,
    isElevated: false,
    authenticatedAt: new Date().toISOString(),
    authLevel: 'aal2',
    stepUpAt: new Date().toISOString(),
    stepUpExpiresAt: new Date(Date.now() + 60_000).toISOString(),
    stepUpPurpose: 'wiki_admin',
    stepUpMethod: 'totp',
    permissions: [],
    groups: [],
  };
  assert.equal(guard.canActivate(context(base, 'wiki_admin')), true);
  assert.throws(() => guard.canActivate(context(base, 'role_admin')));
  assert.throws(() => guard.canActivate(context({ ...base, authLevel: 'aal1' }, 'wiki_admin')));
  assert.throws(() => guard.canActivate(context({ ...base, stepUpExpiresAt: new Date(0).toISOString() }, 'wiki_admin')));
  assert.throws(() => guard.canActivate(context({ ...base, stepUpAt: null }, 'wiki_admin')));
  assert.throws(() => guard.canActivate(context({ ...base, stepUpMethod: null }, 'wiki_admin')));
  assert.throws(() => guard.canActivate(context({
    ...base,
    stepUpExpiresAt: new Date(Date.now() + 10 * 60_000).toISOString(),
  }, 'wiki_admin')));
});

test('step-up guard rejects a missing session for a protected endpoint', () => {
  const guard = new StepUpGuard(new Reflector());
  assert.throws(() => guard.canActivate(context(undefined, 'wiki_admin')));
});

test('step-up guard fails closed when endpoint purpose metadata is missing', () => {
  const guard = new StepUpGuard(new Reflector());
  assert.throws(() => guard.canActivate(context(undefined)));
});
