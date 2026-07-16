import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('OAuth handoff preserves the login form instead of replacing it with a second layout', async () => {
  const source = await readFile(
    new URL('../components/auth/auth-forms.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /if \(oauthPendingProvider\) \{[\s\S]*min-h-\[420px\]/u);
  assert.match(source, /aria-busy=\{oauthPendingProvider !== null\}/u);
  assert.match(source, /보안 로그인으로 연결 중/u);
  assert.match(source, /pending=\{oauthPendingProvider === 'discord'\}/u);
  assert.match(source, /pending=\{oauthPendingProvider === 'naver'\}/u);
});

test('OAuth signup consent stays separate from email signup consent copy', async () => {
  const loginSource = await readFile(
    new URL('../components/auth/auth-forms.tsx', import.meta.url),
    'utf8',
  );
  const oauthConsentSource = await readFile(
    new URL('../components/auth/oauth-signup-consent-client.tsx', import.meta.url),
    'utf8',
  );

  assert.match(loginSource, /이메일 신규 가입 필수 동의/u);
  assert.doesNotMatch(loginSource, /간편 로그인·신규 가입 필수 동의/u);
  assert.match(oauthConsentSource, /처음 만드는 MineWiki 계정입니다/u);
});
