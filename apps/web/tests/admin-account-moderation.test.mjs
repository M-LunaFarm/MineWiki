import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('account moderation client matches the protected backend routes and mutation shape', async () => {
  const source = await readFile(
    new URL('../lib/account-moderation-api.ts', import.meta.url),
    'utf8',
  );

  assert.match(source, /\/v1\/admin\/accounts\?\$\{params\.toString\(\)\}/u);
  assert.match(source, /\/v1\/admin\/accounts\/\$\{encodeURIComponent\(accountId\)\}`/u);
  assert.match(source, /\/v1\/admin\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/suspend/u);
  assert.match(source, /\/v1\/admin\/accounts\/\$\{encodeURIComponent\(accountId\)\}\/restore/u);
  assert.match(source, /readonly confirmation: string/u);
  assert.match(source, /readonly expectedStatus: 'active'/u);
  assert.match(source, /readonly expectedStatus: 'suspended'/u);
  assert.match(source, /await csrfHeaders\(\)/u);
  assert.match(source, /credentials: 'include'/u);
  assert.match(source, /cache: 'no-store'/u);
});

test('account security route is purpose-bound and requires the dedicated permission', async () => {
  const gate = await readFile(
    new URL('../components/admin/admin-access-gate.tsx', import.meta.url),
    'utf8',
  );
  const authClient = await readFile(new URL('../lib/auth-client.ts', import.meta.url), 'utf8');
  const mfaDialog = await readFile(
    new URL('../components/auth/mfa-step-up-dialog.tsx', import.meta.url),
    'utf8',
  );
  const route = await readFile(
    new URL('../app/admin/users/[accountId]/security/page.tsx', import.meta.url),
    'utf8',
  );

  assert.match(gate, /pathname\.startsWith\('\/admin\/users\/'\) && pathname\.endsWith\('\/security'\)[\s\S]*permissions\.includes\('admin\.account\.suspend'\)/u);
  assert.match(gate, /pathname\.startsWith\('\/admin\/users'\)\) return 'account_moderation'/u);
  assert.match(authClient, /\| 'account_moderation'/u);
  assert.match(mfaDialog, /account_moderation: '계정 보안 조치'/u);
  assert.match(route, /<AdminAccountSecurity accountId=\{accountId\}/u);
});

test('security UI requires a reason and exact account-id confirmation before either transition', async () => {
  const source = await readFile(
    new URL('../components/admin/admin-account-security.tsx', import.meta.url),
    'utf8',
  );

  assert.match(source, /minLength=\{5\}/u);
  assert.match(source, /maxLength=\{1000\}/u);
  assert.match(source, /confirmation === account\?\.confirmationValue/u);
  assert.match(source, /expectedStatus: 'active'/u);
  assert.match(source, /expectedStatus: 'suspended'/u);
  assert.match(source, /세션 \$\{result\.revokedSessionCount\}개/u);
  assert.match(source, /Wiki API 토큰 \$\{result\.revokedWikiApiTokenCount\}개/u);
  assert.match(source, /account\?\.accountIds\.includes\(currentAccount\.id\)/u);
  assert.match(source, /min-h-11/u);
  assert.match(source, /sm:flex-row/u);
});

test('admin directory exposes lifecycle filters, statuses, and separate role/security actions', async () => {
  const source = await readFile(
    new URL('../components/admin/admin-user-directory.tsx', import.meta.url),
    'utf8',
  );

  for (const status of ['active', 'suspended', 'deletion_pending', 'anonymized']) {
    assert.match(source, new RegExp(`value: '${status}'`));
  }
  assert.match(source, /fetchAdminAccounts\(\{/u);
  assert.match(source, /permissions\.includes\('admin\.account\.suspend'\)/u);
  assert.match(source, /\/admin\/users\/\$\{account\.canonicalAccountId\}\/roles/u);
  assert.match(source, /\/admin\/users\/\$\{account\.canonicalAccountId\}\/security/u);
  assert.match(source, /account\.suspensionReason/u);
  assert.match(source, /min-h-11/u);
});
