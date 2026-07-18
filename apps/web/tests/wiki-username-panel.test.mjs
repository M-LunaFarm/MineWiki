import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const panel = fs.readFileSync(new URL('../components/account/wiki-username-panel.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');
const account = fs.readFileSync(new URL('../app/me/account-client.tsx', import.meta.url), 'utf8');

test('account center exposes the guarded Wiki username lifecycle as a split component', () => {
  assert.match(account, /<WikiUsernamePanel hasPassword=\{hasPasswordLogin\}/u);
  assert.match(panel, /confirmation !== state\.username/u);
  assert.match(panel, /state\.cooldownDays/u);
  assert.match(panel, /OAuth 전용 계정은 다시 로그인한 뒤 15분/u);
  assert.match(panel, /min-h-11/u);
  assert.match(api, /\/v1\/wiki\/me\/username/u);
  assert.match(api, /await csrfHeaders\(\)/u);
});
