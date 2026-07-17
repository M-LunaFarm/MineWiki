import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('server list renders canonical vote rank only for the canonical ranking sort', async () => {
  const source = await readFile(new URL('../components/servers/server-list-explorer.tsx', import.meta.url), 'utf8');

  assert.match(source, /rank=\{sort === 'votes24h_desc' \? server\.rank\?\.current \?\? null : null\}/u);
  assert.doesNotMatch(source, /rank=\{index \+ 1\}/u);
  assert.match(source, /readonly rank: number \| null/u);
  assert.match(source, /\{rank \? <span/u);
  assert.equal(source.match(/<option value="votes24h_desc">24시간 투표순<\/option>/gu)?.length, 2);
  assert.doesNotMatch(source, /<option value="votes24h_desc">투표순<\/option>/u);
});
