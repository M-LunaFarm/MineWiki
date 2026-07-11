import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ConfigService } from '@minewiki/config';
import { AppService } from './app.service';

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
