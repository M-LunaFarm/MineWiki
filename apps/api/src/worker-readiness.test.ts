import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { OBSERVED_WORKER_QUEUES } from '@minewiki/schemas';
import { checkWorkerReadiness } from './worker-readiness';

test('worker readiness rejects missing, malformed, and future heartbeats', async () => {
  assert.equal((await checkWorkerReadiness(redis(null) as never)).message, 'worker_heartbeat_missing');
  assert.equal((await checkWorkerReadiness(redis('{broken') as never)).message, 'worker_heartbeat_invalid');
  const future = heartbeat({ updatedAt: '2026-07-17T12:01:00.000Z' });
  const checked = await checkWorkerReadiness(redis(future) as never, new Date('2026-07-17T12:00:00.000Z'));
  assert.equal(checked.message, 'worker_heartbeat_from_future');
});

test('retained failures are informational while an old pending job degrades its queue', async () => {
  const healthy = await checkWorkerReadiness(
    redis(heartbeat({ failed: 500 })) as never,
    new Date('2026-07-17T12:00:00.000Z'),
  );
  assert.equal(healthy.status, 'ok');
  assert.equal(healthy.failedJobs, 3_000);

  const stale = await checkWorkerReadiness(
    redis(heartbeat({ oldestPendingAt: '2026-07-17T08:00:00.000Z' })) as never,
    new Date('2026-07-17T12:00:00.000Z'),
  );
  assert.equal(stale.status, 'degraded');
  assert.deepEqual(stale.staleQueues, [...OBSERVED_WORKER_QUEUES]);
});

function redis(value: string | null) {
  return { get: async () => value };
}

function heartbeat(overrides: {
  readonly updatedAt?: string;
  readonly failed?: number;
  readonly oldestPendingAt?: string | null;
}) {
  return JSON.stringify({
    version: 1,
    instanceId: randomUUID(),
    pid: 123,
    workerCount: 6,
    startedAt: '2026-07-17T11:00:00.000Z',
    updatedAt: overrides.updatedAt ?? '2026-07-17T12:00:00.000Z',
    queues: Object.fromEntries(OBSERVED_WORKER_QUEUES.map((queueName) => [queueName, {
      waiting: overrides.oldestPendingAt ? 1 : 0,
      active: 0,
      delayed: 0,
      failed: overrides.failed ?? 0,
      oldestPendingAt: overrides.oldestPendingAt ?? null,
    }])),
  });
}
