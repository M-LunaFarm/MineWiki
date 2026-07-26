import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const page = await readFile(new URL('../app/recent/page.tsx', import.meta.url), 'utf8');
const client = await readFile(new URL('../components/wiki/wiki-recent-changes-client.tsx', import.meta.url), 'utf8');

test('recent changes shares the wiki reader hierarchy and theme-aware surfaces', () => {
  assert.match(page, /wiki-list-page/u);
  assert.match(page, /Wiki activity/u);
  assert.match(page, /surface-flat grid/u);
  assert.doesNotMatch(page, /bg-\[#111821\]/u);
  assert.match(client, /surface-flat divide-y/u);
  assert.match(client, /wiki-recent-change-row/u);
  assert.doesNotMatch(client, /bg-\[#111821\]/u);
});
