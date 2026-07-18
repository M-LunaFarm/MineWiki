import assert from 'node:assert/strict';
import { test } from 'node:test';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { ServerWikiReleaseReviewQueueController } from './server-wiki-release-review-queue.controller';

const session = { userId: 'account-1' } as SessionPayload;

test('release review queue requires a session and forwards only canonical session identity', async () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, ServerWikiReleaseReviewQueueController) ?? [];
  assert.ok(guards.includes(SessionGuard));
  const calls: unknown[][] = [];
  const controller = new ServerWikiReleaseReviewQueueController({
    async list(...args: unknown[]) { calls.push(['list', ...args]); return { items: [] }; },
    async summary(...args: unknown[]) { calls.push(['summary', ...args]); return { count: 0 }; },
    async get(...args: unknown[]) { calls.push(['get', ...args]); return { candidateId: '7' }; },
  } as never);
  await controller.list(session, '9', '20');
  await controller.summary(session);
  await controller.get(session, '7');
  assert.deepEqual(calls, [
    ['list', session.userId, '9', '20'],
    ['summary', session.userId],
    ['get', session.userId, '7'],
  ]);
});
