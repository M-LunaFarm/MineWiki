import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('wiki page tools expose the leaf document swap flow only in safe namespaces', async () => {
  const [tools, form, api] = await Promise.all([
    readFile(new URL('../components/wiki/wiki-page-tools.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../components/wiki/wiki-page-swap-form.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8'),
  ]);

  assert.match(tools, /pageType === 'article'/u);
  assert.match(tools, /!\['user', 'file', 'server'\]\.includes\(namespace\)/u);
  assert.match(form, /fetchWikiSwapCandidates/u);
  assert.match(form, /expectedSourceRevisionId: props\.currentRevisionId/u);
  assert.match(form, /expectedTargetRevisionId: selected\.currentRevisionId/u);
  assert.match(form, /sourceConfirmation === props\.title/u);
  assert.match(form, /targetConfirmation === selected\.title/u);
  assert.match(form, /reason\.trim\(\)\.length >= 5/u);
  assert.match(form, /min-h-11 w-full/u);
  assert.match(api, /\/swap-candidates/u);
  assert.match(api, /mutateWikiPage\(input\.pageId, 'swap'/u);
});
