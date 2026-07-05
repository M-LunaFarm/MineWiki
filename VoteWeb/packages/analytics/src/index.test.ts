import { test } from 'node:test';
import assert from 'node:assert/strict';
import { registerAnalyticsListener, trackEvent } from './index';

test('invokes registered listeners with event payload', async () => {
  const events: string[] = [];
  const dispose = registerAnalyticsListener((event) => {
    events.push(`${event.name}:${(event.payload as { provider?: string }).provider ?? ''}`);
  });

  await trackEvent('login.click', { provider: 'discord' });
  dispose();
  await trackEvent('login.click', { provider: 'email' });

  assert.equal(events.length, 1);
  assert.equal(events[0], 'login.click:discord');
});
