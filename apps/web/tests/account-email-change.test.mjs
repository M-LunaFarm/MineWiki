import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const panel = fs.readFileSync(new URL('../components/account/account-email-change-panel.tsx', import.meta.url), 'utf8');
const confirm = fs.readFileSync(new URL('../app/me/email-change/confirm/confirm-client.tsx', import.meta.url), 'utf8');
const api = fs.readFileSync(new URL('../lib/auth-client.ts', import.meta.url), 'utf8');
const account = fs.readFileSync(new URL('../app/me/account-client.tsx', import.meta.url), 'utf8');

test('account center exposes verified email change and explicit logout confirmation', () => {
  assert.match(account, /<AccountEmailChangePanel/u);
  assert.match(panel, /state\.hasPassword/u);
  assert.match(panel, /nextResendAt/u);
  assert.match(panel, /24시간/u);
  assert.match(panel, /min-h-11/u);
  assert.match(confirm, /모든 기기의 세션을 종료/u);
  assert.match(confirm, /confirmAccountEmailChange/u);
  assert.match(api, /\/v1\/auth\/me\/email-change\/request/u);
  assert.match(api, /\/v1\/auth\/email-change\/confirm/u);
  assert.match(api, /body: \{ token \}, csrf: false/u);
});
