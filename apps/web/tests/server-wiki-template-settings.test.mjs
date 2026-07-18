import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const settings = await readFile(new URL('../components/wiki/server-wiki-settings.tsx', import.meta.url), 'utf8');
const templates = await readFile(new URL('../components/wiki/server-wiki-template-settings.tsx', import.meta.url), 'utf8');

test('server wiki settings exposes a dedicated template lifecycle tab', () => {
  assert.match(settings, /type SettingsTab = 'content' \| 'structure' \| 'templates'/u);
  assert.match(settings, /<ServerWikiTemplateSettings serverId=\{serverId\}/u);
  assert.match(settings, />\s*문서 양식\s*<\/Tab>/u);
});

test('template management is versioned, CSRF protected, previewable, and archival', () => {
  assert.match(templates, /method: selected \? 'PATCH' : 'POST'/u);
  assert.match(templates, /expectedVersion: selected\.version/u);
  assert.match(templates, /method: 'DELETE'.*headers: await csrfHeaders\(\)/su);
  assert.match(templates, /previewWikiMarkup\(form\.contentRaw/u);
  assert.match(templates, /if \(!response\.ok\) throw new Error\(body\.message/u);
});
