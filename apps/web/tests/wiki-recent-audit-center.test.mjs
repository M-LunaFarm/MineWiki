import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const root = new URL('../', import.meta.url);

test('recent changes show contributor, byte delta and ACL-approved diff actions', async () => {
  const client = await readFile(new URL('components/wiki/wiki-recent-changes-client.tsx', root), 'utf8');
  assert.match(client, /change\.actorName/u);
  assert.match(client, /formatSizeDelta\(change\.sizeDelta\)/u);
  assert.match(client, /change\.canViewDiff && change\.previousPublicRevisionId/u);
  assert.match(client, /change\.changeType === 'delete' \? change\.title/u);
});

test('server wiki exposes a tenant-scoped recent change workspace', async () => {
  const page = await readFile(new URL('components/wiki/server-wiki-recent-page.tsx', root), 'utf8');
  const header = await readFile(new URL('components/wiki/server-wiki-header.tsx', root), 'utf8');
  const api = await readFile(new URL('lib/wiki-api.ts', root), 'utf8');
  assert.match(page, /spaceId: page\.serverWiki\.spaceId/u);
  assert.match(page, /namespace: 'server'/u);
  assert.match(header, /\$\{rootPath\}\/_changes/u);
  assert.match(api, /params\.set\('spaceId', input\.spaceId\)/u);
});
