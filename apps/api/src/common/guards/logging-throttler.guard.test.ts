import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trackerForRequest } from './logging-throttler.guard';

test('request bodies cannot select their own global rate-limit tracker', async () => {
  const trackers = await Promise.all(Array.from({ length: 35 }, (_, index) =>
    trackerForRequest({
      headers: { cookie: 'mw_session=fixed-session' },
      ip: '203.0.113.10',
      body: { payload: { server_id: `rotating-${index}` } },
    } as never, async () => 'canonical-account'),
  ));
  assert.equal(new Set(trackers).size, 1);
  assert.equal(trackers[0], 'account:canonical-account');
});

test('anonymous plugin-shaped bodies remain keyed by trusted client address', async () => {
  const first = await trackerForRequest({
    headers: {},
    ip: '198.51.100.20',
    body: { payload: { pluginServerId: 'attacker-choice-a' } },
  } as never);
  const second = await trackerForRequest({
    headers: {},
    ip: '198.51.100.20',
    body: { payload: { pluginServerId: 'attacker-choice-b' } },
  } as never);
  assert.equal(first, second);
  assert.equal(first, 'ip:198.51.100.20');
});

test('different sessions for one canonical account share one tracker', async () => {
  const resolve = async (token: string) => token.startsWith('valid-') ? 'account-42' : null;
  const first = await trackerForRequest({
    headers: { cookie: 'mw_session=valid-one' },
    ip: '198.51.100.30',
  } as never, resolve);
  const second = await trackerForRequest({
    headers: { cookie: 'mw_session=valid-two' },
    ip: '198.51.100.31',
  } as never, resolve);
  assert.equal(first, 'account:account-42');
  assert.equal(second, first);
});

test('rotating invalid session cookies cannot create new buckets', async () => {
  const trackers = await Promise.all(Array.from({ length: 20 }, (_, index) =>
    trackerForRequest({
      headers: { cookie: `mw_session=invalid-${index}` },
      ip: '203.0.113.77',
    } as never, async () => null),
  ));
  assert.equal(new Set(trackers).size, 1);
  assert.equal(trackers[0], 'ip:203.0.113.77');
});
