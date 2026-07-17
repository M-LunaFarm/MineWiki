import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('./backfill-wiki-links.mjs', import.meta.url), 'utf8');

test('wiki link backfill rebuilds every materialized relation type together', () => {
  assert.match(source, /parsed\.links, 'link'/u);
  assert.match(source, /parsed\.includes, 'include'/u);
  assert.match(source, /collectWikiFileNames\(parsed\.ast\)/u);
  assert.match(source, /parsed\.redirectTarget/u);
  assert.match(source, /'redirect'/u);
  assert.match(source, /\.\.\.links[\s\S]*\.\.\.includes[\s\S]*\.\.\.files[\s\S]*\.\.\.redirects/u);
});

test('wiki link backfill deletes old rows only after constructing a complete replacement', () => {
  assert.match(source, /const records = \[/u);
  assert.match(source, /deleteMany\(\{ where: \{ sourcePageId: page\.id \} \}\)/u);
  assert.match(source, /data: records\.map/u);
  assert.match(source, /skipDuplicates: true/u);
});
