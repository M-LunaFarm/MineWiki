import assert from 'node:assert/strict';
import test from 'node:test';
import { matchesJsonSubset } from './smoke-assertions.mjs';

test('matches required service identity while allowing extra health details', () => {
  assert.equal(
    matchesJsonSubset(
      { status: 'ok', service: 'minewiki-api', uptime: 42 },
      { status: 'ok', service: 'minewiki-api' },
    ),
    true,
  );
});

test('rejects a healthy response from the wrong service', () => {
  assert.equal(
    matchesJsonSubset(
      { status: 'ok', service: 'legacy-api' },
      { status: 'ok', service: 'minewiki-api' },
    ),
    false,
  );
});
