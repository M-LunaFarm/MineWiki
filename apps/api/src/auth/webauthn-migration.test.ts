import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL(
  '../../../../prisma/migrations/20260717150000_webauthn_passkeys/migration.sql',
  import.meta.url,
);

test('WebAuthn migration keeps every explicit MySQL identifier within 64 bytes', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  const identifiers = [...sql.matchAll(/(?:INDEX|CONSTRAINT)\s+`([^`]+)`/gu)]
    .map((match) => match[1]!);

  assert.ok(identifiers.length > 0);
  for (const identifier of identifiers) {
    assert.ok(
      Buffer.byteLength(identifier, 'utf8') <= 64,
      `MySQL identifier exceeds 64 bytes: ${identifier}`,
    );
  }
  assert.match(sql, /INDEX `webauthn_challenge_lookup_idx`/u);
});
