import assert from 'node:assert/strict';
import test from 'node:test';

import {
  MAX_WIKI_UPLOAD_FILES,
  mergeWikiUploadSelection,
  runWikiUploadQueue,
  successfulWikiUploadMarkup,
  wikiUploadMetadataError,
} from '../lib/wiki-upload-queue.mjs';

const file = (name, overrides = {}) => ({
  name, size: 1024, lastModified: 1, type: 'image/png', ...overrides,
});

test('non-self-created uploads require attribution before any queue request starts', async () => {
  assert.match(wikiUploadMetadataError({ queuedCount: 2, license: 'cc-by-4.0', sourceUrl: '' }), /출처 URL/u);
  assert.equal(wikiUploadMetadataError({ queuedCount: 2, license: 'cc-by-4.0', sourceUrl: 'https://example.com/source' }), null);
  assert.equal(wikiUploadMetadataError({ queuedCount: 1, license: 'self-created', sourceUrl: '' }), null);
  assert.match(wikiUploadMetadataError({ queuedCount: 0, license: 'self-created', sourceUrl: '' }), /이미지와 라이선스/u);
});

test('selection deduplicates files and enforces count, type, and aggregate size before upload', () => {
  const first = file('first.png');
  const selected = [first, first, file('bad.svg', { type: 'image/svg+xml' })];
  const merged = mergeWikiUploadSelection([], selected);
  assert.equal(merged.items.length, 1);
  assert.equal(merged.rejected.length, 2);

  const eleven = mergeWikiUploadSelection([], Array.from({ length: 11 }, (_, index) => file(`${index}.png`, { lastModified: index })));
  assert.equal(eleven.items.length, MAX_WIKI_UPLOAD_FILES);
  assert.match(eleven.rejected[0], /최대 10개/u);

  const oversized = mergeWikiUploadSelection([], [file('huge.png', { size: 20 * 1024 * 1024 + 1 })]);
  assert.equal(oversized.items.length, 0);
  assert.match(oversized.rejected[0], /20MiB/u);
});

test('queue uploads serially, preserves partial success, and reports each failure', async () => {
  const initial = mergeWikiUploadSelection([], [file('one.png'), file('two.png'), file('three.png')]).items;
  const state = new Map(initial.map((item) => [item.id, item]));
  let active = 0;
  let peak = 0;
  await runWikiUploadQueue(initial, async (item) => {
    active += 1;
    peak = Math.max(peak, active);
    await Promise.resolve();
    active -= 1;
    if (item.file.name === 'two.png') throw new Error('logical name conflict');
    return { filename: `${item.file.name}.webp`, wikiDocumentPath: `/file/${item.file.name}` };
  }, (id, patch) => state.set(id, { ...state.get(id), ...patch }));

  assert.equal(peak, 1);
  assert.deepEqual([...state.values()].map((item) => item.status), ['success', 'failed', 'success']);
  assert.match([...state.values()][1].error, /conflict/u);
  assert.equal(successfulWikiUploadMarkup([...state.values()]), '[[파일:one.png.webp]]\n[[파일:three.png.webp]]');
});

test('cancel stops before the next queued request and retries do not resend successes', async () => {
  const initial = mergeWikiUploadSelection([], [file('one.png'), file('two.png')]).items;
  const state = new Map(initial.map((item) => [item.id, item]));
  let keepGoing = true;
  const sent = [];
  await runWikiUploadQueue(initial, async (item) => {
    sent.push(item.file.name);
    keepGoing = false;
    return { filename: item.file.name, wikiDocumentPath: null };
  }, (id, patch) => state.set(id, { ...state.get(id), ...patch }), () => keepGoing);
  assert.deepEqual(sent, ['one.png']);

  const retryable = [...state.values()].map((item) => item.status === 'success' ? item : { ...item, status: 'queued' });
  await runWikiUploadQueue(retryable, async (item) => {
    sent.push(item.file.name);
    return { filename: item.file.name, wikiDocumentPath: null };
  }, () => undefined);
  assert.deepEqual(sent, ['one.png', 'two.png']);
});
