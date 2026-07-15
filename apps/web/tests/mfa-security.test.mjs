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
