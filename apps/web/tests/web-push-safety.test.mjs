import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const source = await readFile(new URL('../public/sw.js', import.meta.url), 'utf8');

test('service worker renders generic notifications and uses a fixed same-origin destination', () => {
  assert.match(source, /MineWiki에 새 알림이 있습니다/);
  assert.match(source, /const NOTIFICATIONS_PATH = '\/wiki\/notifications'/);
  assert.doesNotMatch(source, /payload\.(title|body|message|href|url)/);
  assert.match(source, /new URL\(NOTIFICATIONS_PATH, self\.location\.origin\)/);
});

test('service worker accepts only bounded numeric notification tags', () => {
  assert.match(source, /\^minewiki-notification-\[0-9\]\+\$/);
});
