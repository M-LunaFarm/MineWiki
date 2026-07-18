import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const article = await readFile(new URL('../components/wiki/server-wiki-article-view.tsx', import.meta.url), 'utf8');
const overview = await readFile(new URL('../components/wiki/server-wiki-directory-overview.tsx', import.meta.url), 'utf8');
const api = await readFile(new URL('../lib/wiki-api.ts', import.meta.url), 'utf8');

test('server wiki renders live directory data on the root document across every paid layout', () => {
  assert.match(article, /const isWikiHome = currentIndex === 0/u);
  assert.match(article, /const directoryOverview = isWikiHome \? wiki\.directoryOverview : null/u);
  assert.match(article, /<ServerWikiDirectoryOverview name=\{wiki\.name\} address=\{address\} overview=\{directoryOverview\} \/>/u);
  assert.doesNotMatch(article, /directoryOverview[^\n]+isHandbook/u);
  assert.match(article, /address && !isHandbook && !directoryOverview/u);
});

test('server wiki overview distinguishes live ranking from immutable documentation and handles empty ranking state', () => {
  assert.match(overview, /현재 서버 개요/u);
  assert.match(overview, /현재 서버 디렉터리 정보를 표시합니다/u);
  assert.match(overview, /게시된 문서 릴리스에 고정/u);
  assert.match(overview, /overview\.rank \? `\$\{overview\.rank\.current/u);
  assert.match(overview, /'집계 대기'/u);
  assert.match(overview, /overview\.live\.isOnline === true/u);
  assert.match(overview, /상태 확인 중/u);
  assert.doesNotMatch(overview, /dangerouslySetInnerHTML/u);
});

test('server wiki overview provides ranking, review, vote and safe official channel journeys', () => {
  assert.match(overview, /서버 상세·리뷰/u);
  assert.match(overview, /\?vote=1/u);
  assert.match(overview, /공식 웹사이트/u);
  assert.match(overview, /Discord/u);
  assert.match(overview, /target="_blank" rel="noopener noreferrer"/u);
  assert.match(overview, /<CopyAddressButton address=\{address\}/u);
  assert.match(api, /readonly directoryOverview:/u);
  assert.match(api, /readonly verificationGrade: 'Verified' \| 'Unverified'/u);
  assert.match(api, /readonly reviewsCount: number/u);
  assert.match(api, /readonly updatedAt: string \| null/u);
});
