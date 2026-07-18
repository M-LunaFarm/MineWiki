import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('release approval migration binds each reviewer to one exact candidate token and tenant', async () => {
  const migration = await readFile(
    new URL('../../../../prisma/migrations/20260719100000_server_wiki_release_approvals/migration.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /CREATE TABLE `server_wiki_release_approvals`/u);
  assert.match(migration, /`server_wiki_id` BIGINT UNSIGNED NOT NULL/u);
  assert.match(migration, /`space_id` BIGINT UNSIGNED NOT NULL/u);
  assert.match(migration, /`candidate_token` CHAR\(64\) NOT NULL/u);
  assert.match(migration, /`reviewer_profile_id` BIGINT UNSIGNED NOT NULL/u);
  assert.match(migration, /UNIQUE INDEX `uq_server_wiki_release_approval` \(`server_wiki_id`, `candidate_token`, `reviewer_profile_id`\)/u);
  assert.match(migration, /FOREIGN KEY \(`server_wiki_id`\) REFERENCES `server_wikis` \(`id`\) ON DELETE CASCADE/u);
});
