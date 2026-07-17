import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [settings, controls, detail] = await Promise.all([
  readFile(new URL('../components/servers/server-profile-settings.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/servers/server-owner-controls.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../components/servers/server-detail-showcase.tsx', import.meta.url), 'utf8'),
]);

test('server profile editing stays split from the existing owner operations console', () => {
  assert.match(controls, /<ServerProfileSettings/u);
  assert.match(controls, /initial=\{initialProfile\}/u);
  assert.match(detail, /initialProfile=\{detail\}/u);
});

test('profile and banner writes use CSRF-protected owner endpoints', () => {
  assert.match(settings, /\/v1\/servers\/\$\{serverId\}\/profile/u);
  assert.match(settings, /method: 'PATCH'/u);
  assert.match(settings, /\/v1\/servers\/\$\{serverId\}\/banner/u);
  assert.match(settings, /method: 'POST'/u);
  assert.match(settings, /csrfHeaders\(\)/u);
  assert.match(settings, /router\.refresh\(\)/u);
});

test('profile form exposes practical body, links, tags, and banner fields', () => {
  for (const label of ['서버 이름', '태그', '한 줄 소개', '상세 소개', '웹사이트', 'Discord 초대', '배너 이미지']) {
    assert.match(settings, new RegExp(label, 'u'));
  }
  assert.match(settings, /maxLength=\{20_000\}/u);
  assert.match(settings, /accept="image\/png,image\/jpeg,image\/webp"/u);
});
