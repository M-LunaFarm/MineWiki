import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const gate = await readFile(new URL('../components/admin/admin-access-gate.tsx', import.meta.url), 'utf8');
const consoleSource = await readFile(new URL('../components/admin/server-wiki-entitlement-console.tsx', import.meta.url), 'utf8');
const adminHome = await readFile(new URL('../app/admin/page.tsx', import.meta.url), 'utf8');

test('billing administration is global-admin gated and purpose-bound to server_admin', () => {
  assert.match(gate, /pathname\.startsWith\('\/admin\/billing'\).*'server_admin'/u);
  assert.match(adminHome, /href: '\/admin\/billing'/u);
});

test('entitlement console exposes bounded grant, extension, revocation, and history states', () => {
  assert.match(consoleSource, /wiki-layout-entitlements/u);
  assert.match(consoleSource, /layoutKey.*startsAt.*expiresAt.*source/su);
  assert.match(consoleSource, /\/extend/u);
  assert.match(consoleSource, /\/revoke/u);
  assert.match(consoleSource, /외부 참조/u);
  assert.match(consoleSource, /마지막 활성 권한이면 공개 위키가 Docs로 전환/u);
  assert.match(consoleSource, /nextCursor/u);
  assert.match(consoleSource, /role="alert"/u);
});
