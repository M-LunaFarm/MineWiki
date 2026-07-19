import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { WORKER_HEARTBEAT_KEY, workerHeartbeatSchema } from '@minewiki/schemas';
import { publishWorkerHeartbeat } from './worker-heartbeat';

test('worker heartbeat is versioned, bounded by TTL, and contains no connection details', async () => {
  const writes: unknown[][] = [];
  const redis = { set: async (...args: unknown[]) => { writes.push(args); return 'OK'; } };
  const queues = [{
    name: 'server-ping',
    getJobCounts: async () => ({ waiting: 1, active: 0, delayed: 0, failed: 2 }),
    getJobs: async ([status]: string[]) => status === 'failed'
      ? [
          { finishedOn: now.getTime() - 1_000 },
          { finishedOn: now.getTime() - 16 * 60_000 },
        ]
      : [{ timestamp: now.getTime() - 1_000 }],
  }];
  const now = new Date('2026-07-17T12:00:00.000Z');
  const identity = {
    instanceId: randomUUID(),
    pid: 123,
    workerCount: 6,
    startedAt: '2026-07-17T11:59:00.000Z',
  };

  await publishWorkerHeartbeat(redis as never, identity, queues as never, now);

  assert.equal(writes.length, 1);
  const [key, raw, expiryMode, ttl] = writes[0] ?? [];
  assert.equal(key, WORKER_HEARTBEAT_KEY);
  assert.equal(expiryMode, 'EX');
  assert.equal(typeof ttl, 'number');
  const parsed = workerHeartbeatSchema.parse(JSON.parse(String(raw)));
  assert.equal(parsed.updatedAt, now.toISOString());
  assert.equal(parsed.queues['server-ping']?.failed, 2);
  assert.equal(parsed.queues['server-ping']?.recentFailed, 1);
  assert.equal(parsed.queues['server-ping']?.latestFailedAt, '2026-07-17T11:59:59.000Z');
  assert.equal(parsed.queues['server-ping']?.oldestPendingAt, '2026-07-17T11:59:59.000Z');
  assert.equal(JSON.stringify(parsed).includes('redis'), false);
});
