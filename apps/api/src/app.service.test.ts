import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@minewiki/config';
import { AppService } from './app.service';
import { randomUUID } from 'node:crypto';

test('readiness reports a healthy database independently from liveness', async () => {
  const service = new AppService(
    { $queryRawUnsafe: async () => [{ healthy: 1 }] } as never,
    new ConfigService({} as NodeJS.ProcessEnv),
  );

  const health = service.getHealth();
  const readiness = await service.getReadiness();

  assert.equal(health.status, 'ok');
  assert.equal(readiness.status, 'ok');
  assert.equal(readiness.checks.database.status, 'ok');
  assert.equal(readiness.checks.redis.status, 'disabled');
});

test('readiness fails closed when the database cannot answer', async () => {
  const service = new AppService(
    {
      $queryRawUnsafe: async () => {
        throw new Error('database unavailable');
      },
    } as never,
    new ConfigService({} as NodeJS.ProcessEnv),
  );

  const readiness = await service.getReadiness();

  assert.equal(readiness.status, 'error');
  assert.equal(readiness.checks.database.status, 'error');
  assert.equal(readiness.checks.database.message, 'dependency_unavailable');
});

test('readiness fails closed for a Redis-compatible ping with an unsupported queue backend', async () => {
  const service = new AppService(
    { $queryRawUnsafe: async () => [{ healthy: 1 }] } as never,
    new ConfigService({} as NodeJS.ProcessEnv),
  );
  Object.assign(service, {
    redis: {
      status: 'ready',
      ping: async () => 'PONG',
      info: async () => 'redis_version:7.0.0\r\ndragonfly_version:1.30.3\r\n',
    },
  });

  const readiness = await service.getReadiness();

  assert.equal(readiness.status, 'error');
  assert.equal(readiness.checks.redis.status, 'error');
  assert.equal(readiness.checks.redis.message, 'dependency_unavailable');
});

test('readiness exposes retained queue failures as information without degrading a live worker', async () => {
  const service = new AppService(
    { $queryRawUnsafe: async () => [{ healthy: 1 }] } as never,
    new ConfigService({} as NodeJS.ProcessEnv),
  );
  Object.assign(service, { redis: redisWithHeartbeat({ failed: 2 }) });

  const readiness = await service.getReadiness();

  assert.equal(readiness.status, 'ok');
  assert.equal(readiness.checks.worker.status, 'ok');
  assert.equal(readiness.checks.worker.failedJobs, 12);
  assert.equal(readiness.checks.worker.message, undefined);
});

test('an overdue waiting job degrades worker health without withdrawing the foreground API', async () => {
  const service = new AppService(
    { $queryRawUnsafe: async () => [{ healthy: 1 }] } as never,
    new ConfigService({} as NodeJS.ProcessEnv),
  );
  Object.assign(service, {
    redis: redisWithHeartbeat({ oldestPendingAt: new Date(Date.now() - 3 * 60 * 60_000).toISOString() }),
  });

  const readiness = await service.getReadiness();

  assert.equal(readiness.status, 'ok');
  assert.equal(readiness.checks.worker.status, 'degraded');
  assert.equal(readiness.checks.worker.message, 'worker_queue_stale');
  assert.ok(readiness.checks.worker.staleQueues?.includes('rank-aggregation'));
});

test('a stale worker heartbeat is explicit while API readiness remains dependency-scoped', async () => {
  const service = new AppService(
    { $queryRawUnsafe: async () => [{ healthy: 1 }] } as never,
    new ConfigService({} as NodeJS.ProcessEnv),
  );
  Object.assign(service, {
    redis: redisWithHeartbeat({ updatedAt: new Date(Date.now() - 60_000).toISOString() }),
  });

  const readiness = await service.getReadiness();

  assert.equal(readiness.status, 'ok');
  assert.equal(readiness.checks.worker.status, 'error');
  assert.equal(readiness.checks.worker.message, 'worker_heartbeat_stale');
});

function redisWithHeartbeat(overrides: {
  readonly failed?: number;
  readonly updatedAt?: string;
  readonly oldestPendingAt?: string;
}) {
  const queues = Object.fromEntries([
    'server-ping', 'rank-aggregation', 'claim-check', 'vote-dispatch', 'discord-digest', 'discord-verify-sync',
  ].map((queueName) => [queueName, {
    waiting: overrides.oldestPendingAt ? 1 : 0,
    active: 0,
    delayed: 0,
    failed: overrides.failed ?? 0,
    oldestPendingAt: overrides.oldestPendingAt ?? null,
  }]));
  return {
    status: 'ready',
    ping: async () => 'PONG',
    info: async () => 'redis_version:7.4.5\r\n',
    get: async () => JSON.stringify({
      version: 1,
      instanceId: randomUUID(),
      pid: 123,
      workerCount: 6,
      startedAt: new Date(Date.now() - 120_000).toISOString(),
      updatedAt: overrides.updatedAt ?? new Date().toISOString(),
      queues,
    }),
  };
}
