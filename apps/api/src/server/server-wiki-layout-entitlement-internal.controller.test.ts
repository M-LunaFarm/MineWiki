import assert from 'node:assert/strict';
import test from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import { deriveBillingLifecycleServiceToken } from '@minewiki/auth';
import { ServerWikiLayoutEntitlementInternalController } from './server-wiki-layout-entitlement-internal.controller';

test('billing lifecycle endpoint rejects missing and mismatched worker tokens', () => {
  const controller = new ServerWikiLayoutEntitlementInternalController(
    { processDue: async () => ({}) } as never,
    { get: () => 'application-encryption-key' } as never,
  );

  assert.throws(() => controller.processDue(undefined), UnauthorizedException);
  assert.throws(() => controller.processDue('Bearer wrong-token'), UnauthorizedException);
});

test('billing lifecycle endpoint accepts only the purpose-bound token and forwards a bounded limit', async () => {
  const limits: Array<number | undefined> = [];
  const controller = new ServerWikiLayoutEntitlementInternalController(
    { processDue: async (limit: number | undefined) => {
      limits.push(limit);
      return { examined: 0, expired: 0, downgraded: 0, skipped: 0, failed: 0 };
    } } as never,
    { get: () => 'application-encryption-key' } as never,
  );
  const token = deriveBillingLifecycleServiceToken('application-encryption-key');

  await controller.processDue(`Bearer ${token}`, '25');
  await controller.processDue(`Bearer ${token}`);

  assert.deepEqual(limits, [25, undefined]);
});
