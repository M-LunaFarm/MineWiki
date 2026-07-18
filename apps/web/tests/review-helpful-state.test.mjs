import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const source = await readFile(
  new URL('../components/reviews/review-list.tsx', import.meta.url),
  'utf8',
);

test('review helpful controls use the authenticated server response as their source of truth', () => {
  assert.match(source, /review\.viewerHelpful/u);
  assert.match(source, /viewerHelpful:\s*helpful/u);
  assert.doesNotMatch(source, /minewiki_helpful_votes|localStorage/u);
});
