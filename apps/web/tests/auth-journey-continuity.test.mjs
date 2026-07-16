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
  assert.match(source, /state=\{oauthPendingProvider === 'discord'/u);
  assert.match(source, /state=\{oauthPendingProvider === 'naver'/u);
  assert.match(source, /min-h-\[3\.75rem\]/u);
});

test('OAuth callback keeps the same provider-card language as the login screen', async () => {
  const source = await readFile(
    new URL('../app/auth/callback/[provider]/callback-client.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /<OAuthFlowStatus/u);
  assert.match(source, /provider=\$\{normalizedProvider\}/u);
  assert.doesNotMatch(source, /OAuthJourney/u);
  assert.doesNotMatch(source, /progressWidth/u);
  assert.match(source, /MineWiki 보안 연결/u);
});

test('first OAuth signup keeps the callback provider stage and login shell', async () => {
  const pageSource = await readFile(
    new URL('../app/auth/signup-consent/page.tsx', import.meta.url),
    'utf8',
  );
  const consentSource = await readFile(
    new URL('../components/auth/oauth-signup-consent-client.tsx', import.meta.url),
    'utf8',
  );

  assert.match(pageSource, /title="로그인"/u);
  assert.match(pageSource, /normalizeProvider/u);
  assert.match(consentSource, /<OAuthFlowStatus/u);
  assert.match(consentSource, /state="success"/u);
  assert.match(consentSource, /provider=\{provider\}/u);
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

test('account conflicts use the auth shell before the settings dashboard', async () => {
  const source = await readFile(
    new URL('../app/me/account-client.tsx', import.meta.url),
    'utf8',
  );

  const conflictGate = source.indexOf(
    'if (linkConflicts.length > 0 && !conflictInterstitialDismissed)',
  );
  const settingsDashboard = source.indexOf('return (\n    <div className="min-h-screen bg-[#121212]');

  assert.ok(conflictGate >= 0, 'account conflict interstitial should exist');
  assert.ok(settingsDashboard > conflictGate, 'conflict interstitial should render before settings');
  assert.match(source.slice(conflictGate, settingsDashboard), /<AuthShellLayout/u);
  assert.match(source, /나중에 처리하고 계정 설정으로 계속/u);
  assert.match(source, /계정은 자동 병합되지 않으며/u);
});
