import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const root = new URL('../', import.meta.url);

test('owner transfer panel requires dedicated MFA, typed confirmation, CSRF, and CAS cancellation', async () => {
  const source = await readFile(new URL('components/servers/server-ownership-transfer-panel.tsx', root), 'utf8');
  assert.match(source, /purpose="server_ownership_transfer"/u);
  assert.match(source, /confirmation !== serverName/u);
  assert.match(source, /csrfHeaders\(\)/u);
  assert.match(source, /expectedVersion: current\.version/u);
  assert.match(source, /cache: 'no-store'/u);
  assert.match(source, /결제 이력이 있는 서버/u);
});

test('recipient inbox requires impact acknowledgement and authoritative reload after response', async () => {
  const source = await readFile(new URL('components/account/server-ownership-transfer-inbox.tsx', root), 'utf8');
  assert.match(source, /purpose="server_ownership_transfer"/u);
  assert.match(source, /confirmation !== item\.serverName/u);
  assert.match(source, /expectedVersion: item\.version/u);
  assert.match(source, /await load\(\)/u);
  assert.match(source, /aria-expanded/u);
  assert.match(source, /min-h-11/u);
});

test('transfer surfaces are mounted in owner controls and account inbox', async () => {
  const owner = await readFile(new URL('components/servers/server-owner-controls.tsx', root), 'utf8');
  const account = await readFile(new URL('app/me/account-client.tsx', root), 'utf8');
  assert.match(owner, /<ServerOwnershipTransferPanel serverId=\{serverId\} serverName=\{initialProfile\.name\}/u);
  assert.match(account, /<ServerOwnershipTransferInbox \/>/u);
});
