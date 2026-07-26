const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const source = fs.readFileSync(path.join(__dirname, '../src/main.ts'), 'utf8');

test('API applies transport and browser security headers at the application boundary', () => {
  assert.match(source, /strict-transport-security/u);
  assert.match(source, /x-content-type-options/u);
  assert.match(source, /x-frame-options/u);
  assert.match(source, /referrer-policy/u);
  assert.match(source, /permissions-policy/u);
});

