import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const [page, api] = await Promise.all([
  readFile(
    new URL('../components/support/support-redesign-page.tsx', import.meta.url),
    'utf8',
  ),
  readFile(new URL('../lib/support-api.ts', import.meta.url), 'utf8'),
]);

test('support ticket search is server-backed and continuation pages append without duplicates', () => {
  assert.match(page, /setTicketSearchKeyword\(searchKeyword\.trim\(\)\)/u);
  assert.match(page, /search:\s*ticketSearchKeyword \|\| undefined/u);
  assert.match(page, /cursor:\s*nextCursor/u);
  assert.match(page, /new Set\(current\.map\(\(ticket\) => ticket\.id\)\)/u);
  assert.match(page, /문의 더 불러오기/u);
});

test('support list client forwards bounded pagination inputs', () => {
  assert.match(api, /params\.set\('search', options\.search\)/u);
  assert.match(api, /params\.set\('cursor', options\.cursor\)/u);
  assert.match(api, /params\.set\('limit', String\(options\.limit\)\)/u);
});
