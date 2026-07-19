import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [client, api] = await Promise.all([
  readFile(new URL('../components/wiki/wiki-page-acl-client.tsx', import.meta.url), 'utf8'),
  readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8'),
]);

test('page ACL UI exposes the real inheritance stack without making inherited rules editable', () => {
  assert.match(api, /readonly layers: ReadonlyArray/u);
  assert.match(api, /readonly viewerTrace: ReadonlyArray/u);
  assert.match(client, /문서부터 사이트까지 내려가며 현재 사용자와 처음 일치하는 규칙 하나가 적용/u);
  assert.match(client, /문서 규칙이 있어도 주체가 일치하지 않으면 상위 범위를 계속 확인/u);
  assert.match(client, /layer\.editableHere \? <div className="flex items-center gap-1">/u);
  assert.match(client, /상속 · 읽기 전용/u);
  assert.match(client, /현재 사용자에게 적용/u);
});

test('non-managers keep the inherited rules and trace redacted', () => {
  assert.match(client, /data\.canManage \? <section className="surface-flat overflow-hidden">/u);
  assert.match(client, /상속 판정 경로는 권한이 있는 관리자에게만 표시/u);
});
