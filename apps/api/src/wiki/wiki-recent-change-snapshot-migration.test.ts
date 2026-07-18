import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../../../prisma/migrations/20260719043000_recent_change_audit_snapshots/migration.sql',
  import.meta.url,
);

test('recent change audit migration adds tenant and immutable revision snapshots fail closed', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /previous_public_revision_id/u);
  assert.match(sql, /space_id/u);
  assert.match(sql, /local_path/u);
  assert.match(sql, /size_delta/u);
  assert.match(sql, /event_audience[^;]+DEFAULT 'restricted'/su);
  assert.match(sql, /idx_recent_changes_space_id/u);
  assert.doesNotMatch(sql, /SET `event_audience` = 'public'/u);
});

test('every production recent-change writer persists tenant snapshot fields', async () => {
  const files = [
    './wiki-edit.service.ts',
    './wiki-admin.service.ts',
    './wiki-moderation.service.ts',
    './wiki-page-swap.service.ts',
    './wiki-username.service.ts',
    '../server/server.service.ts',
  ];
  for (const relative of files) {
    const source = await readFile(new URL(relative, import.meta.url), 'utf8');
    assert.match(source, /spaceId/u, `${relative} must persist a space snapshot`);
    assert.match(source, /localPath/u, `${relative} must persist a path snapshot`);
    assert.match(source, /eventAudience/u, `${relative} must persist an audience snapshot`);
  }
});
