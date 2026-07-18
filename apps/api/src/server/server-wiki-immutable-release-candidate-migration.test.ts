import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('immutable release candidate migration preserves the exact reviewed snapshot and provenance', async () => {
  const migration = await readFile(
    new URL('../../../../prisma/migrations/20260719112000_server_wiki_immutable_release_candidates/migration.sql', import.meta.url),
    'utf8',
  );

  assert.match(migration, /CREATE TABLE `server_wiki_release_candidates`/u);
  assert.match(migration, /`manifest_snapshot` JSON NOT NULL/u);
  assert.match(migration, /`release_snapshot` JSON NOT NULL/u);
  assert.match(migration, /`source_publication_version` INT UNSIGNED NOT NULL/u);
  assert.match(migration, /`required_approvals` INT UNSIGNED NOT NULL DEFAULT 0/u);
  assert.match(migration, /UNIQUE INDEX `uq_server_wiki_release_candidate_token` \(`server_wiki_id`, `token`\)/u);
  assert.match(migration, /FOREIGN KEY \(`candidate_id`\) REFERENCES `server_wiki_release_candidates` \(`id`\) ON DELETE CASCADE/u);
  assert.match(migration, /FOREIGN KEY \(`candidate_id`\) REFERENCES `server_wiki_release_candidates` \(`id`\) ON DELETE RESTRICT/u);
});
