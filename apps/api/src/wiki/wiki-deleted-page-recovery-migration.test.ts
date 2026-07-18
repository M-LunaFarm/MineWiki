import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('deleted-page recovery migration records the selected source revision', async () => {
  const migration = await readFile(
    new URL('../../../../prisma/migrations/20260719030000_deleted_page_revision_recovery/migration.sql', import.meta.url),
    'utf8'
  );

  assert.match(migration, /ADD COLUMN `source_revision_id` BIGINT UNSIGNED NULL/u);
  assert.match(migration, /idx_page_lifecycle_source_revision/u);
});
