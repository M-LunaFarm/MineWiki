import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const panel = await readFile(new URL('../components/account/server-wiki-invitations-panel.tsx', import.meta.url), 'utf8');
const account = await readFile(new URL('../app/me/account-client.tsx', import.meta.url), 'utf8');
const notifications = await readFile(new URL('../components/wiki/wiki-notifications-client.tsx', import.meta.url), 'utf8');

test('account page exposes the authenticated server wiki invitation inbox anchor', () => {
  assert.match(account, /<ServerWikiInvitationsPanel \/>/u);
  assert.match(panel, /id="server-wiki-invitations"/u);
  assert.match(panel, /\/v1\/me\/server-wiki-collaborator-invitations/u);
  assert.match(panel, /credentials: 'include'/u);
  assert.match(panel, /cache: 'no-store'/u);
});

test('invitee explicitly accepts or declines with version CAS and CSRF', () => {
  assert.match(panel, /\$\{action\}/u);
  assert.match(panel, /body: JSON\.stringify\(\{ expectedVersion: item\.version \}\)/u);
  assert.match(panel, /\.\.\.\(await csrfHeaders\(\)\)/u);
  assert.match(panel, /action: 'accept' \| 'decline'/u);
  assert.match(panel, /response\.status === 404 \|\| response\.status === 409/u);
  assert.match(panel, /await load\(\)/u);
});

test('invitation inbox keeps explicit status, time, live-region, and touch-target semantics', () => {
  assert.match(panel, /aria-busy=/u);
  assert.match(panel, /role="status"/u);
  assert.match(panel, /role="alert"/u);
  assert.match(panel, /<time dateTime=\{item\.expiresAt\}>/u);
  assert.ok((panel.match(/min-h-11/g) ?? []).length >= 4);
  assert.match(panel, /수락하기 전에는 권한이 생기지/u);
});

test('notification inbox recognizes invitation events and uses a safe unknown fallback', () => {
  assert.match(notifications, /server_wiki_collaborator_invited/u);
  assert.match(notifications, /server_wiki_collaborator_invitation_accepted/u);
  assert.match(notifications, /서버 위키 협업 초대가 도착했습니다/u);
  assert.match(notifications, /새 위키 알림이 도착했습니다/u);
});
