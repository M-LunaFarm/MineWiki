import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('email login setup handles purpose-bound reauthentication without discarding the form', async () => {
  const account = await readFile(new URL('app/me/account-client.tsx', root), 'utf8');
  const client = await readFile(new URL('lib/auth-client.ts', root), 'utf8');
  const dialog = await readFile(new URL('components/auth/mfa-step-up-dialog.tsx', root), 'utf8');

  assert.match(account, /EMAIL_LOGIN_SETUP_REAUTH_REQUIRED/u);
  assert.match(account, /purpose="email_login_setup"/u);
  assert.match(client, /\| 'email_login_setup'/u);
  assert.match(dialog, /email_login_setup: '이메일 로그인 설정'/u);
});
