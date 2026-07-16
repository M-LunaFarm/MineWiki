import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  buildWikiEditorDraftKey,
  readWikiEditorDraft,
  removeWikiEditorDraft,
  writeWikiEditorDraft
} from '../lib/wiki-editor-draft.mjs';

function memoryStorage() {
  const values = new Map();
  return {
    getItem: (key) => values.get(key) ?? null,
    setItem: (key, value) => values.set(key, value),
    removeItem: (key) => values.delete(key),
    has: (key) => values.has(key)
  };
}

test('wiki editor drafts are scoped to account, route, and section', () => {
  const storage = memoryStorage();
  const context = { accountId: '10', routePath: '/wiki/대문', sectionAnchor: '소개' };
  const key = buildWikiEditorDraftKey(context);

  assert.equal(writeWikiEditorDraft(storage, key, context, {
    baseRevisionId: '20', contentRaw: '초안', editSummary: '설명', isMinor: true
  }, 1_000), true);
  assert.deepEqual(readWikiEditorDraft(storage, key, context, 2_000), {
    version: 1, accountId: '10', routePath: '/wiki/대문', sectionAnchor: '소개', baseRevisionId: '20',
    contentRaw: '초안', editSummary: '설명', isMinor: true, savedAt: 1_000
  });
  assert.equal(readWikiEditorDraft(storage, key, { ...context, accountId: '11' }, 2_000), null);
  assert.equal(storage.has(key), false);
});

test('wiki editor drafts reject stale, malformed, oversized, and unavailable storage safely', () => {
  const context = { accountId: '10', routePath: '/wiki/대문', sectionAnchor: '' };
  const key = buildWikiEditorDraftKey(context);
  const storage = memoryStorage();
  assert.equal(writeWikiEditorDraft(storage, key, context, { contentRaw: '초안', editSummary: '', isMinor: false }, 1_000), true);
  assert.equal(readWikiEditorDraft(storage, key, context, 31 * 24 * 60 * 60 * 1000), null);
  assert.equal(writeWikiEditorDraft(storage, key, context, { contentRaw: '가'.repeat(400_000), editSummary: '', isMinor: false }), false);
  assert.equal(removeWikiEditorDraft({ removeItem() { throw new Error('denied'); } }, key), false);
  assert.equal(readWikiEditorDraft({ getItem() { throw new Error('denied'); } }, key, context), null);
});

test('wiki editor restores drafts explicitly, autosaves changes, and guards navigation', async () => {
  const editor = await readFile(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8');
  assert.match(editor, /readWikiEditorDraft\(window\.localStorage/u);
  assert.match(editor, /writeWikiEditorDraft\(window\.localStorage/u);
  assert.match(editor, /removeWikiEditorDraft\(window\.localStorage/u);
  assert.match(editor, /beforeunload/u);
  assert.match(editor, /confirmEditorNavigation/u);
  assert.match(editor, /저장하지 않은 편집 내용이 있습니다/u);
  assert.match(editor, /초안 복원/u);
  assert.match(editor, /초안 삭제/u);
  assert.match(editor, /aria-live="polite"/u);
});
