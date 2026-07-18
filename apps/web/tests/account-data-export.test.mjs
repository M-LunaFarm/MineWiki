import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const root = new URL('../', import.meta.url);

test('account settings mounts self-service export before destructive account termination', async () => {
  const source = await readFile(new URL('app/me/account-client.tsx', root), 'utf8');
  const exportIndex = source.indexOf('<AccountDataExportPanel');
  const terminationIndex = source.indexOf('<AccountTerminationPanel');
  assert.ok(exportIndex >= 0);
  assert.ok(terminationIndex > exportIndex);
});

test('account export client sends CSRF-protected credentials and downloads a blob', async () => {
  const client = await readFile(new URL('lib/auth-client.ts', root), 'utf8');
  assert.match(client, /\/v1\/auth\/account-data-export/u);
  assert.match(client, /credentials: 'include'/u);
  assert.match(client, /csrfHeaders\(\)/u);
  assert.match(client, /response\.blob\(\)/u);
});

test('account export offers purpose-bound MFA and documents excluded secrets', async () => {
  const panel = await readFile(new URL('components/account/account-data-export-panel.tsx', root), 'utf8');
  const dialog = await readFile(new URL('components/auth/mfa-step-up-dialog.tsx', root), 'utf8');
  assert.match(panel, /purpose="account_export"/u);
  assert.match(panel, /ACCOUNT_EXPORT_REAUTH_REQUIRED/u);
  assert.match(panel, /OAuth 토큰/u);
  assert.match(panel, /MFA 비밀키/u);
  assert.match(dialog, /account_export: '계정 데이터 내보내기'/u);
});
