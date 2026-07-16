import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('file reference backfill replaces only derived file links for current revisions', async () => {
  const source = await readFile(new URL('./backfill-wiki-file-links.mjs', import.meta.url), 'utf8');
  assert.match(source, /status: \{ not: 'deleted' \}/u);
  assert.match(source, /visibility: 'public'/u);
  assert.match(source, /deleteMany\(\{ where: \{ sourcePageId: page\.id, linkType: 'file' \} \}\)/u);
  assert.doesNotMatch(source, /deleteMany\(\{ where: \{ sourcePageId: page\.id \} \}\)/u);
  assert.match(source, /collectWikiFileNames\(parseMarkup\(revision\.contentRaw\)\.ast\)/u);
});
