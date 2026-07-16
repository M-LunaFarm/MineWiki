import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

test('server wiki notices use a separate no-store presentation request', async () => {
  const api = await readFile(new URL('../lib/wiki-server-api.ts', import.meta.url), 'utf8');
  const article = await readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8');

  assert.match(api, /server-wikis\/\$\{encodeURIComponent\(slug\)\}\/presentation/u);
  assert.match(api, /cache: 'no-store'/u);
  assert.match(article, /presentation\.topNoticeHtml/u);
  assert.match(article, /presentation\.bottomNoticeHtml/u);
  assert.match(article, /aria-label="서버 위키 상단 안내"/u);
});

test('every server wiki submission path carries the accepted policy version', async () => {
  const editor = await readFile(new URL('../components/wiki/wiki-editor-client.tsx', import.meta.url), 'utf8');
  const api = await readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');

  assert.match(editor, /policyReady/u);
  assert.match(editor, /기여 정책 v\{presentation\.policy\.version\}을 확인했습니다/u);
  assert.ok((editor.match(/policyAcceptance/g) ?? []).length >= 5);
  assert.match(api, /saveWikiSection[\s\S]*policyAcceptance: input\.policyAcceptance/u);
  assert.match(api, /createWikiEditRequest[\s\S]*WikiPolicyAcceptance/u);
});

test('management UI guards conflicts, byte limits, and unsaved changes', async () => {
  const settings = await readFile(new URL('../components/wiki/server-wiki-settings.tsx', import.meta.url), 'utf8');

  assert.match(settings, /SERVER_WIKI_SETTINGS_CONFLICT/u);
  assert.match(settings, /beforeunload/u);
  assert.match(settings, /20 \* 1024/u);
  assert.match(settings, /expectedVersion: settings\.version/u);
  assert.match(settings, /PrivilegedActionGate/u);
});

test('manager access keeps content controls while hiding owner-only commercial and roster tabs', async () => {
  const settings = await readFile(new URL('../components/wiki/server-wiki-settings.tsx', import.meta.url), 'utf8');

  assert.match(settings, /const allowed: SettingsTab\[\] = \['content'\]/u);
  assert.match(settings, /access\?\.canManageLayout \? <Tab[\s\S]*레이아웃·요금제/u);
  assert.match(settings, /access\?\.canManageCollaborators \? <Tab[\s\S]*협업자/u);
  assert.match(settings, /access\?\.canManageLayout \? <TabPanel[\s\S]*ServerWikiLayoutPlansContent/u);
  assert.match(settings, /access\?\.canManageCollaborators \? <TabPanel[\s\S]*ServerWikiCollaboratorsContent/u);
  assert.match(settings, /<ContentSettingsForm serverId=\{serverId\} onAccessLoaded=\{setAccess\}/u);
});
