import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const settingsSource = await readFile(new URL('../components/wiki/server-wiki-settings.tsx', import.meta.url), 'utf8');
const collaboratorsSource = await readFile(new URL('../components/wiki/server-wiki-collaborators.tsx', import.meta.url), 'utf8');

test('server wiki settings exposes an accessible collaborator tab inside the existing admin gate', () => {
  assert.match(settingsSource, /purpose="server_admin"/u);
  assert.match(settingsSource, /role="tablist"/u);
  assert.match(settingsSource, /role="tab"/u);
  assert.match(settingsSource, /aria-controls=/u);
  assert.match(settingsSource, /aria-selected=/u);
  assert.match(settingsSource, /role="tabpanel"/u);
  assert.match(settingsSource, /ArrowRight/u);
  assert.match(settingsSource, />\s*협업자\s*</u);
  assert.match(settingsSource, /<ServerWikiCollaboratorsContent serverId=\{serverId\}/u);
});

test('collaborator requests follow the roster and mutation source contract', () => {
  assert.match(collaboratorsSource, /\/v1\/servers\/\$\{encodeURIComponent\(serverId\)\}\/wiki-collaborators/u);
  assert.match(collaboratorsSource, /credentials: 'include'[\s\S]*cache: 'no-store'/u);
  assert.match(collaboratorsSource, /method: 'POST'[\s\S]*body: \{ username, role: addRole, reason \}/u);
  assert.match(collaboratorsSource, /method: 'PATCH'[\s\S]*body: \{ role, expectedRole: item\.role, reason \}/u);
  assert.match(collaboratorsSource, /method: 'DELETE'[\s\S]*body: \{ expectedRole: item\.role, reason \}/u);
  assert.match(collaboratorsSource, /\.\.\.\(await csrfHeaders\(\)\)/u);
  assert.match(collaboratorsSource, /const refreshed = await loadCollaborators/u);
  assert.match(collaboratorsSource, /response\.status === 409/u);
  assert.match(collaboratorsSource, /pendingInvitations/u);
  assert.match(collaboratorsSource, /\/invitations\/\$\{encodeURIComponent\(item\.id\)\}\/resend/u);
  assert.match(collaboratorsSource, /body: \{ expectedVersion: item\.version, reason \}/u);
  assert.match(collaboratorsSource, /수락 전에는 권한이 부여되지 않습니다/u);
});

test('collaborator controls require exact usernames, audited reasons, and explicit revocation', () => {
  assert.match(collaboratorsSource, /autoComplete="off"/u);
  assert.match(collaboratorsSource, /자동 완성이나 계정 검색은 제공하지 않습니다/u);
  assert.match(collaboratorsSource, /const REASON_MIN_LENGTH = 5/u);
  assert.match(collaboratorsSource, /const REASON_MAX_LENGTH = 500/u);
  assert.match(collaboratorsSource, /minLength=\{REASON_MIN_LENGTH\}/u);
  assert.match(collaboratorsSource, /maxLength=\{REASON_MAX_LENGTH\}/u);
  assert.match(collaboratorsSource, /manager:[\s\S]*label: '관리자'/u);
  assert.match(collaboratorsSource, /editor:[\s\S]*label: '편집자'/u);
  assert.match(collaboratorsSource, /reviewer:[\s\S]*label: '검토자'/u);
  assert.match(collaboratorsSource, /권한 회수 확인/u);
  assert.match(collaboratorsSource, /초대 보내기/u);
  assert.match(collaboratorsSource, /aria-controls=\{`invite-actions-/u);
  assert.ok((collaboratorsSource.match(/min-h-11/g) ?? []).length >= 10, 'interactive controls should keep a 44px minimum height');
});
