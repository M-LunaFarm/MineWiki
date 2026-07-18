import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { selectServerRecommendations } from '../lib/server-recommendations.mjs';

const ranked = (id, current) => ({ id, name: id, rank: { current } });

test('recommendations preserve canonical ranks after excluding the current server', () => {
  const result = selectServerRecommendations({
    currentServerId: 'first',
    ranked: [ranked('first', 1), ranked('second', 2), ranked('third', 3)],
  });

  assert.deepEqual(result.map((server) => server.rank.current), [2, 3]);
});

test('recommendations deduplicate, cap results, and mark fallback servers unranked', () => {
  const result = selectServerRecommendations({
    currentServerId: 'current',
    ranked: [ranked('ranked', 1), ranked('current', 2)],
    fallback: [ranked('ranked', 99), ranked('fallback-a', 7), ranked('fallback-b', 8), ranked('fallback-c', 9), ranked('fallback-d', 10)],
  });

  assert.equal(result.length, 4);
  assert.deepEqual(result.map((server) => server.id), ['ranked', 'fallback-a', 'fallback-b', 'fallback-c']);
  assert.equal(result[0].rank.current, 1);
  assert.ok(result.slice(1).every((server) => server.rank === null));
});

test('recommendation cards never derive a rank from their array position', async () => {
  const source = await readFile(
    new URL('../components/servers/server-detail-showcase.tsx', import.meta.url),
    'utf8',
  );

  assert.doesNotMatch(source, /recommendations\.map\(\(server, idx\)/u);
  assert.doesNotMatch(source, /\{idx \+ 1\}/u);
  assert.match(source, /server\.rank\?\.current/u);
  assert.match(source, /순위 미집계/u);
});
