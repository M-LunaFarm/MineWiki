import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('worker gates consumers and schedulers on database and Redis readiness', () => {
  const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
  const bootstrapStart = source.indexOf('async function bootstrapWorker()');
  const databaseReady = source.indexOf('await prisma.$connect()', bootstrapStart);
  const redisReady = source.indexOf('await connection.ping()', bootstrapStart);
  const redisCompatible = source.indexOf('assertSupportedQueueServer', redisReady);
  const workerStart = source.indexOf('worker.run()', bootstrapStart);
  const schedulerStart = source.indexOf("scheduleInterval('server-ping'", bootstrapStart);

  assert.ok(bootstrapStart >= 0);
  assert.ok(databaseReady > bootstrapStart);
  assert.ok(redisReady > databaseReady);
  assert.ok(redisCompatible > redisReady);
  assert.ok(workerStart > redisCompatible);
  assert.ok(schedulerStart > workerStart);
  assert.match(source, /autorun:\s*false/);
  assert.match(source, /Worker bootstrap failed/);
});
