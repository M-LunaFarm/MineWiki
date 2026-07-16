import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const editor = readFileSync(resolve(import.meta.dirname, '../components/wiki/wiki-editor-client.tsx'), 'utf8');
const queue = readFileSync(resolve(import.meta.dirname, '../components/wiki/wiki-edit-request-queue-client.tsx'), 'utf8');
const api = readFileSync(resolve(import.meta.dirname, '../lib/wiki-api.ts'), 'utf8');

test('missing-document editor exposes the reviewed creation mutation', () => {
  assert.match(editor, /createWikiPageRequest\(\{ namespace, title, contentRaw, editSummary, isMinor, captchaToken:/u);
  assert.match(editor, /새 문서 검토 요청/u);
  assert.match(api, /mutateWikiBrowser<WikiEditRequestSummary>\('\/v1\/wiki\/edit-requests', 'POST', input\)/u);
});

test('new-page queue items use a request identity route without a synthetic page id', () => {
  assert.match(api, /readonly detailPath: string/u);
  assert.match(queue, /href=\{item\.detailPath\}/u);
  assert.doesNotMatch(queue, /item\.pageId === null/u);
});
