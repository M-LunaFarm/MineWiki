import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const routeSource = await readFile(new URL('../components/wiki/wiki-edit-route-page.tsx', import.meta.url), 'utf8');
const editorSource = await readFile(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8');
const errorSource = await readFile(new URL('../components/wiki/wiki-editor-load-error.tsx', import.meta.url), 'utf8');

test('the edit route only treats a confirmed 404 as a new document', () => {
  assert.match(routeSource, /try\s*{[\s\S]*await fetchWikiPageByPath\(routePath\)/);
  assert.match(routeSource, /catch\s*{[\s\S]*<WikiEditorLoadError/);
  assert.doesNotMatch(routeSource, /fetchWikiPageByPath\(routePath\)\.catch\(\(\) => null\)/);
});

test('revision failures keep every mutation path closed until the source reload succeeds', () => {
  assert.match(editorSource, /const \[sourceReady, setSourceReady\] = useState\(false\)/);
  assert.match(editorSource, /setSourceReady\(false\);[\s\S]*setSourceLoadError\(null\)/);
  assert.match(editorSource, /setSourceLoadError\(error instanceof Error/);
  assert.match(editorSource, /account && sourceReady && contentRaw\.trim\(\)/);
  assert.match(editorSource, /if \(sourceLoadError\)[\s\S]*<WikiEditorLoadError/);
  assert.match(editorSource, /onRetry=\{\(\) => setSourceReloadKey/);
});

test('loading and failure states are announced and offer touch-sized recovery controls', () => {
  assert.match(editorSource, /role="status"/);
  assert.match(errorSource, /role="alert"/);
  assert.match(errorSource, /alertRef\.current\?\.focus\(\)/);
  assert.match(errorSource, /min-h-11 w-full/);
});
