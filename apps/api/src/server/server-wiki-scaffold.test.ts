import assert from 'node:assert/strict';
import test from 'node:test';
import { buildServerWikiMainPage, buildServerWikiStarterPages } from './server-wiki-scaffold';

const server = {
  name: '루나팜',
  joinHost: 'lunaf.kr',
  joinPort: 25565,
  edition: 'java',
  supportedVersions: ['1.20.1', '1.21'],
  tags: ['마인팜', '경제'],
  shortDescription: '마인팜 서버',
  longDescription: '농장을 키우며 경제 콘텐츠를 즐기는 서버입니다.',
  websiteUrl: 'https://lunaf.kr',
  discordUrl: 'https://discord.gg/example',
} as const;

test('server wiki scaffold builds a factual, navigable root document', () => {
  const content = buildServerWikiMainPage(server);

  for (const heading of [
    '서버 소개',
    '빠른 접속 정보',
    '처음 방문자를 위한 순서',
    '주요 콘텐츠',
    '공식 채널',
    '문서 이용 안내',
  ]) {
    assert.match(content, new RegExp(`== ${heading} ==`, 'u'));
  }
  assert.match(content, /lunaf\.kr:25565/u);
  assert.match(content, /Java Edition/u);
  assert.match(content, /\[\[시작하기\]\].*\[\[규칙\]\].*\[\[FAQ\]\]/su);
  assert.match(content, /https:\/\/lunaf\.kr/u);
  assert.match(content, /https:\/\/discord\.gg\/example/u);
});

test('server wiki scaffold exposes missing owner content instead of inventing facts', () => {
  const incomplete = {
    ...server,
    supportedVersions: [],
    tags: [],
    longDescription: '',
    shortDescription: '',
    websiteUrl: null,
    discordUrl: null,
  };
  const content = buildServerWikiMainPage(incomplete);
  const rules = buildServerWikiStarterPages(incomplete).find((page) => page.path === '규칙');

  assert.match(content, /서버 소개를 아직 작성하지 않았습니다/u);
  assert.match(content, /지원 버전: 운영자가 아직 등록하지 않았습니다/u);
  assert.match(content, /주요 콘텐츠와 플레이 방식을 아직 등록하지 않았습니다/u);
  assert.match(content, /공식 홈페이지와 Discord 링크가 아직 없습니다/u);
  assert.match(rules?.contentRaw ?? '', /공식 서버 규칙을 아직 작성하지 않았습니다/u);
  assert.match(rules?.contentRaw ?? '', /체크리스트는 규칙 자체가 아니며/u);
  assert.doesNotMatch(rules?.contentRaw ?? '', /다른 이용자를 존중/u);
});

test('starter pages provide concrete onboarding and troubleshooting paths', () => {
  const pages = buildServerWikiStarterPages(server);

  assert.deepEqual(pages.map((page) => page.path), ['시작하기', '규칙', 'FAQ']);
  assert.match(pages[0]?.contentRaw ?? '', /접속 전 확인/u);
  assert.match(pages[0]?.contentRaw ?? '', /서버 추가 순서/u);
  assert.match(pages[0]?.contentRaw ?? '', /접속되지 않을 때/u);
  assert.match(pages[2]?.contentRaw ?? '', /어떤 버전으로 접속하나요/u);
  assert.match(pages[2]?.contentRaw ?? '', /어디로 문의하나요/u);
});
