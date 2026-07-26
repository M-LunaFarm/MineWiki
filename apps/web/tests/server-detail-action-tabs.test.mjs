import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [hero, registration, theme] = await Promise.all([
  readFile(new URL('../components/servers/server-hero-live.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../app/servers/register/page.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../app/globals.css', import.meta.url), 'utf8'),
]);

test('server detail hero exposes the Lazyweb action hierarchy as accessible tabs', () => {
  assert.match(hero, /role="tablist"/u);
  assert.match(hero, /role="tab"/u);
  assert.match(hero, /role="tabpanel"/u);
  assert.match(hero, /aria-selected=\{activeActionTab === tab\.id\}/u);

  for (const label of ['접속', '신뢰', '참여']) {
    assert.match(hero, new RegExp(`label: '${label}'`, 'u'));
  }
});

test('action panels keep join, verification and participation controls functional', () => {
  assert.match(hero, /address=\{joinAddress\}/u);
  assert.match(hero, /주소 복사/u);
  assert.match(hero, /운영자 인증하기/u);
  assert.match(hero, /\/claim\?serverId=/u);
  assert.match(hero, /<VoteModal/u);
  assert.match(hero, /href="#server-reviews"/u);
  assert.match(hero, /initialVoteOpen \? 'participate' : 'join'/u);
});

test('registration light theme explicitly covers the next-step and version surfaces', () => {
  assert.match(registration, /server-registration-next-chip/u);
  assert.match(registration, /server-registration-draft-notice/u);
  assert.match(registration, /server-registration-version-picker/u);
  assert.match(registration, /server-registration-version-token/u);
  assert.match(theme, /html\[data-theme='light'\] \.server-registration-next-chip/u);
  assert.match(theme, /html\[data-theme='light'\] \.server-registration-draft-notice/u);
  assert.match(theme, /html\[data-theme='light'\] \.server-registration-version-picker/u);
  assert.match(theme, /html\[data-theme='light'\] \.server-registration-version-token/u);
});
