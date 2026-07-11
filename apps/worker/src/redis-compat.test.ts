import { test } from 'node:test';
import assert from 'node:assert/strict';
import { assertSupportedQueueServer } from './redis-compat';

test('accepts supported Redis 7 server metadata', () => {
  assert.doesNotThrow(() =>
    assertSupportedQueueServer('# Server\r\nredis_version:7.4.2\r\nredis_mode:standalone\r\n'),
  );
});

test('rejects Dragonfly before BullMQ consumers start', () => {
  assert.throws(
    () => assertSupportedQueueServer('# Server\r\nredis_version:7.0.0\r\ndragonfly_version:1.30.3\r\n'),
    /Dragonfly is not supported/,
  );
});

test('rejects unsupported or unidentified Redis servers', () => {
  assert.throws(() => assertSupportedQueueServer('redis_version:6.2.14\r\n'), /Redis 7 or newer/);
  assert.throws(() => assertSupportedQueueServer('# Server\r\n'), /Unable to identify/);
});
