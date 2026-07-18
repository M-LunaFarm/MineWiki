import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const history = await readFile(new URL('../components/wiki/wiki-history-list-client.tsx', import.meta.url), 'utf8');
const route = await readFile(new URL('../components/wiki/wiki-history-route-page.tsx', import.meta.url), 'utf8');

test('history route loads lifecycle events beside content revisions', () => {
  assert.match(route, /fetchWikiPageLifecycleEvents\(page\.id\)/u);
  assert.match(route, /initialLifecycle=\{lifecycle\}/u);
  assert.match(route, /fetchWikiPageAclHistoryEvents\(page\.id\)/u);
  assert.match(route, /initialAclHistory=\{aclHistory\}/u);
});

test('lifecycle cards do not expose revision diff or revert controls', () => {
  const lifecycleCard = history.slice(history.indexOf('function LifecycleCard'), history.indexOf('function HistoryCard'));
  assert.match(lifecycleCard, /문서 수명주기|문서 이동|문서 삭제|문서 복구/u);
  assert.match(lifecycleCard, /접근 권한이 없는 이전 경로 정보는 숨겼습니다/u);
  assert.doesNotMatch(lifecycleCard, /buildWikiDiffPath|WikiRevertButton|이전 판과 비교/u);
});

test('ACL history cards keep sensitive rule details behind the API visibility flag', () => {
  const aclCard = history.slice(history.indexOf('function AclHistoryCard'), history.indexOf('function HistoryCard'));
  assert.match(aclCard, /ACL 규칙 생성|ACL 규칙 삭제|ACL 규칙 순서 변경/u);
  assert.match(aclCard, /event\.detailsVisible/u);
  assert.match(aclCard, /ACL 관리 권한이 있는 사용자에게만 표시/u);
  assert.doesNotMatch(aclCard, /JSON\.stringify/u);
});
