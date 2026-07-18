import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const consoleSource = await readFile(new URL('../components/admin/account-merge-console.tsx', import.meta.url), 'utf8');
const accessGate = await readFile(new URL('../components/admin/admin-access-gate.tsx', import.meta.url), 'utf8');
const authClient = await readFile(new URL('../lib/auth-client.ts', import.meta.url), 'utf8');
const adminHome = await readFile(new URL('../app/admin/page.tsx', import.meta.url), 'utf8');

test('account merge operations have a dedicated step-up protected admin route', () => {
  assert.match(accessGate, /pathname\.startsWith\('\/admin\/account-merges'\)/u);
  assert.match(accessGate, /admin\.account\.merge/u);
  assert.match(accessGate, /account_merge_admin/u);
  assert.match(authClient, /'account_merge_admin'/u);
  assert.match(adminHome, /href: '\/admin\/account-merges'/u);
});

test('review console requires conflict evidence, reason, target and optimistic version', () => {
  assert.match(consoleSource, /\/v1\/admin\/account-merge-requests/u);
  assert.match(consoleSource, /evidenceConfirmed: true/u);
  assert.match(consoleSource, /targetCanonicalAccountId: targetAccountId/u);
  assert.match(consoleSource, /version: decision\.item\.version/u);
  assert.match(consoleSource, /minLength=\{8\}/u);
  assert.match(consoleSource, /기존 세션을 모두 종료/u);
});
