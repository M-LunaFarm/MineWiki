import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const history = await readFile(new URL('../components/wiki/wiki-history-list-client.tsx', import.meta.url), 'utf8');
const route = await readFile(new URL('../components/wiki/wiki-history-route-page.tsx', import.meta.url), 'utf8');

test('history route loads lifecycle events beside content revisions', () => {
  assert.match(route, /fetchWikiPageLifecycleEvents\(page\.id\)/u);
  assert.match(route, /initialLifecycle=\{lifecycle\}/u);
});

test('lifecycle cards do not expose revision diff or revert controls', () => {
  const lifecycleCard = history.slice(history.indexOf('function LifecycleCard'), history.indexOf('function HistoryCard'));
  assert.match(lifecycleCard, /문서 수명주기|문서 이동|문서 삭제|문서 복구/u);
  assert.match(lifecycleCard, /접근 권한이 없는 이전 경로 정보는 숨겼습니다/u);
  assert.doesNotMatch(lifecycleCard, /buildWikiDiffPath|WikiRevertButton|이전 판과 비교/u);
});
