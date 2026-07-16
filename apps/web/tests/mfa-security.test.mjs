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
  ]) {
    assert.match(source, new RegExp(endpoint.replaceAll('/', '\\/')));
  }
  assert.match(source, /await csrfHeaders\(\)/u);
  assert.match(source, /clearCsrfToken\(\)/u);
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
