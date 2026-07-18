import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(
  new URL('../components/servers/server-review-section.tsx', import.meta.url),
  'utf8',
);

test('signed-in review authors retain a server-backed receipt for staff-only feedback', () => {
  assert.match(source, /\/reviews\/mine/);
  assert.match(source, /credentials:\s*'include'/);
  assert.match(source, /운영진에게만 보낸 내 리뷰/);
  assert.match(source, /viewerReceipts/);
});
