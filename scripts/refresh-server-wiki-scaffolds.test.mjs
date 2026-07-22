import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(
  new URL('./refresh-server-wiki-scaffolds.mjs', import.meta.url),
  'utf8',
);

test('server wiki scaffold refresh only touches untouched generated revisions', () => {
  assert.match(source, /revision\.revisionNo === 1/u);
  assert.match(source, /revision\.parentRevisionId === null/u);
  assert.match(source, /revision\.editSummary === expectedSummary/u);
  assert.match(source, /currentRevisionId !== candidate\.revision\.id/u);
});

test('server wiki scaffold refresh preserves canonical tenant boundaries and materializes indexes', () => {
  assert.match(source, /isCanonicalLink\(server, serverWiki\)/u);
  assert.match(source, /SELECT id FROM Server WHERE id = \? FOR UPDATE/u);
  assert.match(source, /wikiLinks\.replaceForRevision/u);
  assert.match(source, /parsed\.categoryLinks/u);
  assert.match(source, /wikiPageRenderCache\.deleteMany/u);
  assert.match(source, /server_wiki_scaffold_refresh/u);
});
