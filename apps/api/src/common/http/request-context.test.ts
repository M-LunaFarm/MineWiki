import assert from 'node:assert/strict';
import test from 'node:test';
import { getCurrentRequestIp, runWithHttpRequestContext } from './request-context';

test('HTTP request context isolates concurrent client addresses', async () => {
  const gate = Promise.withResolvers<void>();
  const first = runWithHttpRequestContext('192.0.2.10', async () => {
    await gate.promise;
    return getCurrentRequestIp();
  });
  const second = runWithHttpRequestContext('2001:db8::10', async () => {
    gate.resolve();
    await Promise.resolve();
    return getCurrentRequestIp();
  });

  assert.deepEqual(await Promise.all([first, second]), ['192.0.2.10', '2001:db8::10']);
  assert.equal(getCurrentRequestIp(), null);
});
