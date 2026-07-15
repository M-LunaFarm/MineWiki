import assert from 'node:assert/strict';
import test from 'node:test';

import {
  OAUTH_LINK_INTENT_KEY,
  closeOAuthWindowOrNavigate,
  consumeOAuthLinkIntent,
  createOAuthLinkIntent,
  storeOAuthLinkIntent,
} from '../lib/oauth-link-intent.mjs';

function memoryStorage(initialValue = null) {
  let value = initialValue;
  return {
    getItem(key) {
      return key === OAUTH_LINK_INTENT_KEY ? value : null;
    },
    removeItem(key) {
      if (key === OAUTH_LINK_INTENT_KEY) value = null;
    },
    current() {
      return value;
    },
  };
}

test('same-window OAuth link intent requires an exact provider and state match', () => {
  const now = Date.parse('2026-07-16T00:00:00.000Z');
  const raw = createOAuthLinkIntent({
    provider: 'discord',
    state: 'state-value-123',
    expiresAt: '2026-07-16T00:05:00.000Z',
  }, now);
  const storage = memoryStorage(raw);

  assert.equal(consumeOAuthLinkIntent(storage, { provider: 'naver', state: 'state-value-123' }, now), false);
  assert.equal(consumeOAuthLinkIntent(storage, { provider: 'discord', state: 'wrong-state' }, now), false);
  assert.notEqual(storage.current(), null);
  assert.equal(consumeOAuthLinkIntent(storage, { provider: 'discord', state: 'state-value-123' }, now), true);
  assert.equal(storage.current(), null);
  assert.equal(consumeOAuthLinkIntent(storage, { provider: 'discord', state: 'state-value-123' }, now), false);
});

test('expired or malformed OAuth link intents fail closed and are removed', () => {
  const now = Date.parse('2026-07-16T00:10:00.000Z');
  const expired = memoryStorage(JSON.stringify({
    provider: 'discord',
    state: 'state-value-123',
    expiresAt: '2026-07-16T00:05:00.000Z',
  }));
  const malformed = memoryStorage('{not-json');

  assert.equal(consumeOAuthLinkIntent(expired, { provider: 'discord', state: 'state-value-123' }, now), false);
  assert.equal(expired.current(), null);
  assert.equal(consumeOAuthLinkIntent(malformed, { provider: 'discord', state: 'state-value-123' }, now), false);
  assert.equal(malformed.current(), null);
});

test('intent creation rejects unsupported, short, and already-expired requests', () => {
  const now = Date.parse('2026-07-16T00:10:00.000Z');
  assert.throws(() => createOAuthLinkIntent({ provider: 'github', state: 'state-value-123', expiresAt: '2026-07-16T00:15:00.000Z' }, now));
  assert.throws(() => createOAuthLinkIntent({ provider: 'discord', state: 'short', expiresAt: '2026-07-16T00:15:00.000Z' }, now));
  assert.throws(() => createOAuthLinkIntent({ provider: 'discord', state: 'state-value-123', expiresAt: '2026-07-16T00:05:00.000Z' }, now));
});

test('unavailable session storage does not block the OAuth redirect path', () => {
  const stored = storeOAuthLinkIntent({
    setItem() {
      throw new Error('storage denied');
    },
  }, {
    provider: 'discord',
    state: 'state-value-123',
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });

  assert.equal(stored, false);
});

test('a no-op or rejected window close returns the user to account settings', () => {
  const navigations = [];
  const openWindow = {
    closed: false,
    close() {},
    setTimeout(callback) { callback(); },
  };
  closeOAuthWindowOrNavigate(openWindow, (path) => navigations.push(path));

  const rejectedWindow = {
    closed: false,
    close() { throw new Error('not script opened'); },
    setTimeout(callback) { callback(); },
  };
  closeOAuthWindowOrNavigate(rejectedWindow, (path) => navigations.push(path));

  assert.deepEqual(navigations, ['/me', '/me']);
});

test('a successfully closed OAuth popup does not navigate its document', () => {
  const navigations = [];
  const popup = {
    closed: false,
    close() { this.closed = true; },
    setTimeout(callback) { callback(); },
  };
  closeOAuthWindowOrNavigate(popup, (path) => navigations.push(path));
  assert.deepEqual(navigations, []);
});
