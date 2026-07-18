import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const migrationUrl = new URL('../../../../prisma/migrations/20260719020000_anonymous_wiki_edit_requests/migration.sql', import.meta.url);

test('anonymous edit request migration enforces an exclusive user or IP submitter', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /MODIFY `created_by` BIGINT UNSIGNED NULL/u);
  assert.match(sql, /ADD CONSTRAINT `chk_wiki_edit_request_submitter`/u);
  assert.match(sql, /`submitter_type` = 'user'[\s\S]*`created_by` IS NOT NULL[\s\S]*`submitter_ip_hash` IS NULL/u);
  assert.match(sql, /`submitter_type` = 'ip'[\s\S]*`created_by` IS NULL[\s\S]*`submitter_ip_hash` IS NOT NULL/u);
});
