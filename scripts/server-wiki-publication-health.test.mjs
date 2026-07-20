import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  describeServerWikiPublicationCoverage,
  readServerWikiPublicationCoverage,
} from './server-wiki-publication-health.mjs';

test('normalizes MariaDB aggregate values without exposing tenant identifiers', () => {
  assert.deepEqual(readServerWikiPublicationCoverage({
    active_canonical: 3n,
    published: '1',
    never_released: 2,
  }), {
    activeCanonical: 3,
    published: 1,
    neverReleased: 2,
    previouslyReleased: 1,
  });
});

test('describes publication coverage as aggregate operational evidence', () => {
  const detail = describeServerWikiPublicationCoverage({
    activeCanonical: 3,
    published: 1,
    neverReleased: 2,
    previouslyReleased: 1,
  });
  assert.equal(detail, '3 active owner-managed canonical server wikis; 1 published; 2 never released');
  assert.doesNotMatch(detail, /server[_ -]?id|wiki[_ -]?id/iu);
});

test('handles an empty production tenant set explicitly', () => {
  assert.equal(
    describeServerWikiPublicationCoverage(readServerWikiPublicationCoverage()),
    'no active owner-managed canonical server wikis',
  );
});

test('production validation covers lifecycle, release tenant boundaries, and aggregate coverage', async () => {
  const source = await readFile(new URL('./validate-data.mjs', import.meta.url), 'utf8');
  assert.match(source, /active canonical ServerWiki publication lifecycle is coherent/u);
  assert.match(source, /release_row\.server_wiki_id <> sw\.id/u);
  assert.match(source, /valid_item\.space_id = sw\.space_id/u);
  assert.match(source, /COUNT\(valid_item\.id\) <> COUNT\(all_item\.id\)/u);
  assert.match(source, /s\.ownerAccountId IS NOT NULL/u);
  assert.match(source, /owners must complete readiness and publish an immutable release/u);
});
