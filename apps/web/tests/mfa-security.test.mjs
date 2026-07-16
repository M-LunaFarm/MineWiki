import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('MFA client covers enrollment, step-up, recovery rotation, and disable with CSRF', async () => {
  const source = await readFile(new URL('../lib/auth-client.ts', import.meta.url), 'utf8');
  for (const endpoint of [
    '/v1/auth/mfa/totp/enrollment',
    '/v1/auth/mfa/totp/enrollment/confirm',
    '/v1/auth/mfa/step-up',
    '/v1/auth/mfa/recovery-codes/regenerate',
    '/v1/auth/mfa/totp',
    '/v1/auth/mfa/passkeys/registration/options',
    '/v1/auth/mfa/passkeys/registration/verify',
    '/v1/auth/mfa/passkeys/step-up/options',
    '/v1/auth/mfa/passkeys/step-up/verify',
  ]) {
    assert.match(source, new RegExp(endpoint.replaceAll('/', '\\/')));
  }
  assert.match(source, /await csrfHeaders\(\)/u);
  assert.match(source, /clearCsrfToken\(\)/u);
});

test('passkey management is step-up protected and explicitly excludes passwordless login', async () => {
  const panel = await readFile(
    new URL('../components/account/mfa-security-panel.tsx', import.meta.url),
    'utf8',
  );
  assert.match(panel, /startRegistration/u);
  assert.match(panel, /beginPasskeyRegistration/u);
  assert.match(panel, /finishPasskeyRegistration/u);
  assert.match(panel, /setProtectedAction\('register_passkey'\)/u);
  assert.match(panel, /setProtectedAction\('delete_passkey'\)/u);
  assert.match(panel, /비밀번호 없는 로그인에는 아직 사용하지 않습니다/u);
  assert.match(panel, /status\.passkeyCount\}\/10/u);
  assert.match(panel, /min-h-11/u);
});

test('MFA enrollment renders QR locally and exposes one-time recovery export controls', async () => {
  const source = await readFile(
    new URL('../components/account/mfa-security-panel.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /QRCode\.toDataURL\(enrollment\.otpauthUri/u);
  assert.doesNotMatch(source, /api\.qrserver|chart\.googleapis|quickchart/u);
  assert.match(source, /minewiki-recovery-codes\.txt/u);
  assert.match(source, /지금 한 번만 표시/u);
});

test('privileged confirmation binds the submitted code to an explicit purpose', async () => {
  const source = await readFile(
    new URL('../components/auth/mfa-step-up-dialog.tsx', import.meta.url),
    'utf8',
  );
  assert.match(source, /performMfaStepUp\(\{ method, purpose, code:/u);
  assert.match(source, /startAuthentication/u);
  assert.match(source, /beginPasskeyStepUp\(purpose\)/u);
  assert.match(source, /finishPasskeyStepUp/u);
  assert.match(source, /status\.mfaEnabled/u);
  assert.match(source, /해당 목적에만 5분/u);
  assert.match(source, /role="dialog"/u);
  assert.match(source, /aria-modal="true"/u);
});

test('privileged UI gates bind session expiry and sensitive surfaces to the matching purpose', async () => {
  const gate = await readFile(
    new URL('../components/auth/privileged-action-gate.tsx', import.meta.url),
    'utf8',
  );
  assert.match(gate, /stepUpPurpose === purpose/u);
  assert.match(gate, /expiryMs > now/u);
  assert.match(gate, /purpose=\{purpose\}/u);
  assert.match(gate, /if \(loading\)/u);
  assert.match(gate, /if \(!account\)/u);
  assert.match(gate, /\/login\?returnTo=/u);
  assert.ok(gate.indexOf('if (!account)') < gate.indexOf('다중 인증으로 계속'));

  const protectedSurfaces = [
    ['../components/servers/server-owner-controls.tsx', 'server_admin'],
    ['../components/wiki/server-wiki-layout-plans.tsx', 'server_admin'],
    ['../app/guilds/[guildId]/settings/page.tsx', 'guild_admin'],
  ];
  for (const [path, purpose] of protectedSurfaces) {
    const source = await readFile(new URL(path, import.meta.url), 'utf8');
    assert.match(source, new RegExp(`PrivilegedActionGate[\\s\\S]*purpose="${purpose}"`));
  }
});
