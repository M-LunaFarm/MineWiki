const { test } = require('node:test');
const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { resolve } = require('node:path');

test('api bootstrap enables Nest shutdown hooks before listening', () => {
  const source = readFileSync(resolve(__dirname, '../src/main.ts'), 'utf8');
  const hookIndex = source.indexOf('app.enableShutdownHooks()');
  const listenIndex = source.indexOf('await app.listen(');

  assert.ok(hookIndex >= 0, 'shutdown hooks must be enabled');
  assert.ok(listenIndex > hookIndex, 'shutdown hooks must be enabled before the server listens');
});
