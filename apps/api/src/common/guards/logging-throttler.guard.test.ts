import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackerForRequest } from './logging-throttler.guard';

test('request bodies cannot select their own global rate-limit tracker', () => {
  const trackers = Array.from({ length: 35 }, (_, index) =>
    trackerForRequest({
      headers: { cookie: 'mw_session=fixed-session' },
      ip: '203.0.113.10',
      body: { payload: { server_id: `rotating-${index}` } },
    } as never),
  );
  assert.equal(new Set(trackers).size, 1);
  assert.match(trackers[0] ?? '', /^session:[a-f0-9]{64}$/u);
});

test('anonymous plugin-shaped bodies remain keyed by trusted client address', () => {
  const first = trackerForRequest({
    headers: {},
    ip: '198.51.100.20',
    body: { payload: { pluginServerId: 'attacker-choice-a' } },
  } as never);
  const second = trackerForRequest({
    headers: {},
    ip: '198.51.100.20',
    body: { payload: { pluginServerId: 'attacker-choice-b' } },
  } as never);
  assert.equal(first, second);
  assert.equal(first, 'ip:198.51.100.20');
});
