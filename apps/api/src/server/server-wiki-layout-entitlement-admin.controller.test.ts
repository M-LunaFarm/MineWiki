import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ForbiddenException } from '@nestjs/common';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { ZodError } from 'zod';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { STEP_UP_PURPOSE_METADATA, StepUpGuard } from '../session/step-up.guard';
import { ServerWikiLayoutEntitlementAdminController } from './server-wiki-layout-entitlement-admin.controller';

const serverId = '11111111-1111-4111-8111-111111111111';
const adminSession: SessionPayload = {
  sessionId: 'session-1',
  userId: '22222222-2222-4222-8222-222222222222',
  tokenVersion: 1,
  isElevated: true,
  authenticatedAt: '2026-07-17T00:00:00.000Z',
  groups: ['admin'],
  permissions: ['server.admin'],
};

test('entitlement admin controller runs SessionGuard before purpose-bound server_admin step-up', () => {
  assert.equal(
    Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, ServerWikiLayoutEntitlementAdminController),
    'server_admin',
  );
  const guards = Reflect.getMetadata(GUARDS_METADATA, ServerWikiLayoutEntitlementAdminController) ?? [];
  assert.ok(guards.indexOf(SessionGuard) >= 0);
  assert.ok(guards.indexOf(StepUpGuard) > guards.indexOf(SessionGuard));
});

test('entitlement admin endpoints have bounded operation-specific throttles', () => {
  const expected = { list: 30, grant: 8, extend: 12, revoke: 8 } as const;
  for (const [method, limit] of Object.entries(expected)) {
    const handler = ServerWikiLayoutEntitlementAdminController.prototype[
      method as keyof typeof ServerWikiLayoutEntitlementAdminController.prototype
    ];
    assert.equal(Reflect.getMetadata('THROTTLER:LIMITdefault', handler), limit);
    assert.equal(Reflect.getMetadata('THROTTLER:TTLdefault', handler), 60);
  }
});

test('only global owner and admin groups can use entitlement administration', () => {
  let called = false;
  const controller = new ServerWikiLayoutEntitlementAdminController({
    async list() {
      called = true;
    },
  } as never);
  const serverPermissionOnly: SessionPayload = {
    ...adminSession,
    groups: ['server_admin'],
  };

  assert.throws(
    () => controller.list(serverId, serverPermissionOnly),
    ForbiddenException,
  );
  assert.equal(called, false);
});

test('controller validates, trims, and forwards the complete lifecycle payloads', async () => {
  const calls: unknown[][] = [];
  const controller = new ServerWikiLayoutEntitlementAdminController({
    async list(...args: unknown[]) {
      calls.push(['list', ...args]);
      return { items: [] };
    },
    async grant(...args: unknown[]) {
      calls.push(['grant', ...args]);
      return { id: '41' };
    },
    async extend(...args: unknown[]) {
      calls.push(['extend', ...args]);
      return { id: '41' };
    },
    async revoke(...args: unknown[]) {
      calls.push(['revoke', ...args]);
      return { id: '41' };
    },
  } as never);

  await controller.list(serverId, adminSession, '25', '99');
  await controller.grant(serverId, {
    layoutKey: 'handbook',
    startsAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2027-07-17T00:00:00.000Z',
    source: ' manual ',
    externalRef: ' invoice-41 ',
    reason: '  annual premium layout grant  ',
  }, adminSession);
  await controller.extend(serverId, '41', {
    expiresAt: '2028-07-17T00:00:00.000Z',
    reason: '  annual renewal approved  ',
  }, adminSession);
  await controller.revoke(serverId, '41', {
    reason: '  billing contract ended  ',
  }, adminSession);

  assert.deepEqual(calls, [
    ['list', serverId, { limit: 25, before: '99' }],
    ['grant', serverId, {
      layoutKey: 'handbook',
      startsAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2027-07-17T00:00:00.000Z',
      source: 'manual',
      externalRef: 'invoice-41',
      reason: 'annual premium layout grant',
    }, adminSession.userId],
    ['extend', serverId, '41', {
      expiresAt: '2028-07-17T00:00:00.000Z',
      reason: 'annual renewal approved',
    }, adminSession.userId],
    ['revoke', serverId, '41', {
      reason: 'billing contract ended',
    }, adminSession.userId],
  ]);
});

test('controller rejects unbounded, non-premium, malformed, and unknown grant fields', () => {
  const controller = new ServerWikiLayoutEntitlementAdminController({} as never);
  const valid = {
    layoutKey: 'brand',
    startsAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2027-07-17T00:00:00.000Z',
    source: 'manual',
    reason: 'approved premium layout grant',
  };
  for (const body of [
    { ...valid, layoutKey: 'docs' },
    { ...valid, expiresAt: valid.startsAt },
    { ...valid, source: 'UPPERCASE' },
    { ...valid, externalRef: 'contains spaces' },
    { ...valid, reason: 'no' },
    { ...valid, unexpected: true },
  ]) {
    assert.throws(() => controller.grant(serverId, body, adminSession), ZodError);
  }
});

test('controller bounds history pagination and requires reasons for lifecycle writes', () => {
  const controller = new ServerWikiLayoutEntitlementAdminController({} as never);
  assert.throws(() => controller.list(serverId, adminSession, '101'), ZodError);
  assert.throws(() => controller.list(serverId, adminSession, '10', '0'), ZodError);
  assert.throws(
    () => controller.extend(serverId, '41', { expiresAt: '2028-07-17T00:00:00.000Z' }, adminSession),
    ZodError,
  );
  assert.throws(() => controller.revoke(serverId, '41', {}, adminSession), ZodError);
});
