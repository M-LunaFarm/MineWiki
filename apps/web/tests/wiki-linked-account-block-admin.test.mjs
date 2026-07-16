import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

const apiClient = readFileSync(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');
const admin = readFileSync(new URL('../components/wiki/wiki-user-admin.tsx', import.meta.url), 'utf8');

test('wiki block administration exposes canonical linked-profile scope', () => {
  assert.match(apiClient, /canonicalAccountId: string \| null/u);
  assert.match(apiClient, /linkedProfileIds: string\[\]/u);
  assert.match(apiClient, /linkedProfileCount: number/u);
  assert.match(admin, /연결 프로필 \{user\.linkedProfileCount\}개/u);
  assert.match(admin, /동일 계정 그룹 전체에 적용됩니다/u);
  assert.match(admin, /Wiki 프로필 \{pending\.user\.linkedProfileCount\}개에 함께 적용됩니다/u);
});
