import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
  serverRankingRequestFromFilters,
  shouldLoadUnrankedServerPreview,
  unrankedServerBrowseHref,
} from '../lib/server-ranking-preview.mjs';

const filters = {
  search: '  Luna  ', edition: 'java', grade: 'Verified', online: 'online',
  sort: 'votes24h_desc', tags: ['survival'], page: 3,
};

test('unranked preview preserves every discovery filter but uses the latest first page', () => {
  assert.deepEqual(serverRankingRequestFromFilters(filters, { sort: 'latest', page: 1, pageSize: 6 }), {
    edition: 'java', grade: 'Verified', online: true, tag: 'survival', search: 'Luna',
    sort: 'latest', page: 1, pageSize: 6,
  });
  assert.equal(unrankedServerBrowseHref(filters), '/servers?search=Luna&edition=java&grade=Verified&online=true&tag=survival&sort=latest');
});

test('preview is limited to an empty canonical vote epoch with known unranked servers', () => {
  assert.equal(shouldLoadUnrankedServerPreview({ rankStatus: 'empty', total: 0, unrankedCount: 10 }, 'votes24h_desc'), true);
  assert.equal(shouldLoadUnrankedServerPreview({ rankStatus: 'ready', total: 0, unrankedCount: 10 }, 'votes24h_desc'), false);
  assert.equal(shouldLoadUnrankedServerPreview({ rankStatus: 'empty', total: 1, unrankedCount: 10 }, 'votes24h_desc'), false);
  assert.equal(shouldLoadUnrankedServerPreview({ rankStatus: 'empty', total: 0, unrankedCount: 10 }, 'latest'), false);
});

test('server directory renders unranked cards without fabricated ranks and exposes named filters', async () => {
  const source = await readFile(new URL('../components/servers/server-list-explorer.tsx', import.meta.url), 'utf8');
  assert.match(source, /initialUnrankedPreview/u);
  assert.match(source, /unrankedPreview\.map\(\(server\) => <ServerCard key=\{server\.id\} server=\{server\} rank=\{null\}/u);
  assert.match(source, /<Link href=\{unrankedBrowseHref\}[^>]*>등록된 서버 전체 보기<\/Link>/u);
  assert.doesNotMatch(source, /onClick=\{\(\) => setSort\('latest'\)\}/u);
  assert.match(source, /aria-label="서버 검색"/u);
  assert.equal(source.match(/aria-label="검증 상태"/gu)?.length, 2);
});
