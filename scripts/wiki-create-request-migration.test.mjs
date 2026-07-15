import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const migration = readFileSync(
  resolve(import.meta.dirname, '../prisma/migrations/20260715234000_wiki_create_edit_requests/migration.sql'),
  'utf8',
);

test('new-page edit request storage enforces edit and create target shapes', () => {
  assert.match(migration, /CONSTRAINT `chk_wiki_edit_requests_target_shape` CHECK/u);
  assert.match(migration, /`request_kind` = 'edit' AND `page_id` IS NOT NULL AND `base_revision_id` IS NOT NULL/u);
  assert.match(migration, /`request_kind` = 'create' AND `base_revision_id` IS NULL/u);
  for (const column of [
    'target_namespace_id',
    'target_namespace_code',
    'target_space_id',
    'target_title',
    'target_slug',
    'target_display_title',
    'target_page_type',
  ]) {
    assert.match(migration, new RegExp('`' + column + '` IS NOT NULL', 'u'));
  }
});

test('new-page edit request target indexes support serialized collision checks and review queues', () => {
  assert.match(migration, /idx_wiki_edit_requests_target` \(`target_namespace_id`, `target_slug`, `status`, `created_at`\)/u);
  assert.match(migration, /idx_wiki_edit_requests_target_space` \(`target_space_id`, `status`, `created_at`\)/u);
});
