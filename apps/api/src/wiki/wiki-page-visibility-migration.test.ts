import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const migrationUrl = new URL(
  '../../../../prisma/migrations/20260719223000_page_visibility_auto_hidden/migration.sql',
  import.meta.url
);

test('page visibility migration records only legacy auto-hidden pages as provenance', async () => {
  const sql = await readFile(migrationUrl, 'utf8');

  assert.match(sql, /ADD COLUMN `visibility_auto_hidden` BOOLEAN NOT NULL DEFAULT FALSE/u);
  assert.match(sql, /WHERE `status` = 'hidden'\s+AND `current_revision_id` IS NULL/u);
  assert.doesNotMatch(sql, /WHERE `status` = 'deleted'/u);
});
