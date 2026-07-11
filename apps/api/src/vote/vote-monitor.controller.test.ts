import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { GUARDS_METADATA } from '@nestjs/common/constants';
import { VoteMonitorController } from './vote-monitor.controller';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';

const session = (permissions: string[] = []): SessionPayload => ({
  sessionId: 'session-1',
  userId: 'account-1',
  isElevated: false,
  permissions
});

test('queue monitoring requires an authenticated session', () => {
  const guards = Reflect.getMetadata(GUARDS_METADATA, VoteMonitorController) as
    | unknown[]
    | undefined;
  assert.ok(Array.isArray(guards));
  assert.ok(guards.includes(SessionGuard));
});

test('queue monitoring rejects regular users without querying queue state', async () => {
  let queried = false;
  const controller = new VoteMonitorController({
    async getJobCounts() {
      queried = true;
      return {};
    }
  } as never);

  await assert.rejects(() => controller.summary(session()), /운영 모니터링 권한이 필요합니다/);
  assert.equal(queried, false);
});

test('queue monitoring is available to administrators', async () => {
  const controller = new VoteMonitorController({
    async getJobCounts() {
      return { waiting: 2, failed: 1 };
    }
  } as never);

  assert.deepEqual(await controller.summary(session(['server.admin'])), {
    waiting: 2,
    failed: 1
  });
});
