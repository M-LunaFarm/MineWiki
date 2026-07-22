import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

test('bot gates login and scheduling on database and queue readiness', () => {
  const source = readFileSync(resolve(__dirname, 'index.ts'), 'utf8');
  const bootstrap = source.indexOf('const bootstrapBot = async () =>');
  const databaseReady = source.indexOf('await prisma.$connect()', bootstrap);
  const queueReady = source.indexOf('await digestQueue.waitUntilReady()', bootstrap);
  const queueCompatible = source.indexOf('assertSupportedQueueServer', queueReady);
  const login = source.indexOf('await client.login(token)', bootstrap);
  const commands = source.indexOf('await registerCommands(rest, clientId)', bootstrap);
  const initialDigest = source.indexOf('await processDueDigests(subscriptions, digestQueue)', bootstrap);
  const scheduler = source.indexOf('scheduler = setInterval', bootstrap);

  assert.ok(bootstrap >= 0);
  assert.ok(databaseReady > bootstrap);
  assert.ok(queueReady > databaseReady);
  assert.ok(queueCompatible > queueReady);
  assert.ok(login > queueCompatible);
  assert.ok(commands > login);
  assert.ok(initialDigest > commands);
  assert.ok(scheduler > initialDigest);
  assert.match(source, /consecutiveSchedulerFailures >= 3/);
  assert.match(source, /digest-scheduler-unhealthy/);
  assert.match(source, /Discord bot bootstrap failed/);
});
