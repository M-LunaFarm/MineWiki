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
    async pages(...args: unknown[]) { calls.push(['pages', ...args]); return { items: [] }; },
    async diff(...args: unknown[]) { calls.push(['diff', ...args]); return { hunks: [] }; },
    async get(...args: unknown[]) { calls.push(['get', ...args]); return { candidateId: '7' }; },
  } as never);
  await controller.list(session, '9', '20');
  await controller.summary(session);
  await controller.pages(session, '7', 'added,updated', 'cursor-1', '50');
  await controller.diff(session, '7', '11');
  await controller.get(session, '7');
  assert.deepEqual(calls, [
    ['list', session.userId, '9', '20'],
    ['summary', session.userId],
    ['pages', session.userId, '7', 'added,updated', 'cursor-1', '50'],
    ['diff', session.userId, '7', '11'],
    ['get', session.userId, '7'],
  ]);
});
