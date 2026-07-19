import test from 'node:test';
import assert from 'node:assert/strict';
import { UnauthorizedException } from '@nestjs/common';
import { derivePaddleWebhookInboxServiceToken } from '@minewiki/auth';
import { PaddleWebhookInternalController } from './paddle-webhook-internal.controller';

test('Paddle inbox internal endpoint requires its dedicated derived token', async () => {
  const key = 'application-encryption-key';
  let receivedLimit: number | undefined;
  const controller = new PaddleWebhookInternalController(
    { async processDue(limit?: number) { receivedLimit = limit; return { processed: 0 }; } } as never,
    { get() { return key; } } as never,
  );

  assert.throws(() => controller.processDue(undefined), UnauthorizedException);
  assert.throws(() => controller.processDue('Bearer wrong-token'), UnauthorizedException);
  const token = derivePaddleWebhookInboxServiceToken(key);
  assert.deepEqual(await controller.processDue(`Bearer ${token}`, '40'), { processed: 0 });
  assert.equal(receivedLimit, 40);
});
