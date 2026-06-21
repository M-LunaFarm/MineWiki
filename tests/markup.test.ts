import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseMarkup, renderDocument } from '../src/wiki/markup.js';
import { wikiLinkKey, wikiUrl } from '../src/wiki/namespaces.js';
import {
  aclHistoryPage,
  adminBackupManifestPage,
  adminAuditHubPage,
  adminEditFiltersPage,
  adminFilesPage,
  adminIdentityPage,
  adminImportsPage,
  adminJobsPage,
  adminPage,
  adminPublicationPage,
  adminReleasePage,
  adminReportsPage,
  adminSearchPage,
  adminSubwikiRequestPage,
  adminSubwikisPage,
  adminWorkPage,
  announcementsPage,
  articlePage,
  authPage,
  categoryPage,
  contributorTasksPage,
  dataListPage,
  developHubPage,
  discussionPage,
  documentTemplateFormPage,
  editConflictPage,
  editPage,
  emailVerificationSentPage,
  fileDetailPage,
  fileUploadPage,
  invalidEmailVerificationPage,
  invalidPasswordResetPage,
  layout,
  logoutConfirmPage,
  messagePage,
  modOperatorDashboardPage,
  modIndexPage,
  modVerificationPage,
  newDocumentPage,
  newDocumentFormPage,
  newModWikiPage,
  newSubwikiDocumentPage,
  openBetaPage,
  operatorHomePage,
  permissionInfoPage,
  projectBoardsPage,
  rawPage,
  reviewDetailPage,
  qualityPage,
  releaseNotesPage,
  recentChangesPage,
  revisionDiffPage,
  revisionHistoryPage,
  revisionSearchPage,
  searchPage,
  serviceStatusPage,
  myServersPage,
  serverClaimPage,
  serverHubPage,
  serverWikiRequestPage,
  serverWikiRequestSubmittedPage,
  serverOperatorDashboardPage,
  spaceHomePage,
  userDashboardPage,
  watchlistPage,
  passwordResetSentPage
} from '../src/ui.js';

test('parses BWM links categories components and renders safe HTML', () => {
  const parsed = parseMarkup(`{{문서 상태
|기준=Java Edition 1.21
|상태=검증 필요
}}

{{몹 정보
|이름=엔더맨
|영문=Enderman
|분류=중립적 몹
|체력=40
}}

'''엔더맨'''은 [[엔드]]에서 흔하다.<script>alert(1)</script>

== 관련 문서 ==
* [[엔더 진주]]

[[분류:중립적 몹]]`);

  assert.deepEqual(parsed.links, ['엔드', '엔더 진주']);
  assert.deepEqual(parsed.categories, ['중립적 몹']);
  assert.equal(parsed.components.some((component) => component.name === 'mob_info'), true);
  const html = renderDocument(parsed.ast);
  assert.equal(html.includes('<script>'), false);
  assert.equal(html.includes('infobox-mob_info'), true);
});

test('renders missing internal links with red-link class', () => {
  const parsed = parseMarkup('[[없는 문서|빨간 링크]]');
  const html = renderDocument(parsed.ast, { missingLinks: new Set([wikiLinkKey('없는 문서')]) });
  assert.equal(html.includes('class="wiki-link missing"'), true);
  assert.equal(html.includes('title="문서 없음"'), true);
  assert.equal(html.includes('빨간 링크'), true);
});

test('renders develop wiki components', () => {
  const parsed = parseMarkup(`{{개발 문서 상태
|대상=Java Edition
|버전=1.21.x
|검증=필요
|출처=공식 문서
|확인일=2026.05.24. 00:00
}}

{{코드 예제
|제목=Join event
|언어=java
|코드=event.getPlayer().sendMessage("Welcome");
}}

{{프로토콜 필드 표
|열=필드,타입,설명
|행1=entityId,VarInt,엔티티 ID
}}

[[분류:개발]]`);
  const html = renderDocument(parsed.ast);
  assert.equal(parsed.components.some((component) => component.name === 'develop_status'), true);
  assert.equal(html.includes('개발 문서 상태'), true);
  assert.equal(html.includes('data-lang="java"'), true);
  assert.equal(html.includes('프로토콜 필드 표'), true);
});

test('renders data table component with stable key', () => {
  const parsed = parseMarkup(`{{데이터 표
|키=mob-drops
|제목=드롭 데이터
|열=아이템,확률,비고
|행1=썩은 살점,항상,기본
}}`);
  const html = renderDocument(parsed.ast);
  assert.equal(parsed.components.some((component) => component.name === 'data_table'), true);
  assert.equal(html.includes('data-table-key="mob-drops"'), true);
  assert.equal(html.includes('드롭 데이터'), true);
  assert.equal(html.includes('썩은 살점'), true);
});

test('front page components reject unsafe local hrefs', () => {
  const parsed = parseMarkup(`{{대문 카드
|제목=위험 링크
|대상=//evil.example/path
|설명=테스트
|링크1=몹
}}`);
  const rendered = renderDocument(parsed.ast);
  assert.equal(rendered.includes('href="//evil.example/path"'), false);
  assert.equal(rendered.includes('/search?q=%EB%AA%B9'), true);
  assert.equal(rendered.includes('/wiki/%EB%AA%B9'), false);
  const notice = renderDocument(
    parseMarkup(`{{서버 운영자 안내
|제목=서버 운영자라면?
|설명=규칙과 공지를 관리하세요.
|버튼1=서버 위키 만들기
|링크1=/servers/new
|버튼2=위험
|링크2=javascript:alert(1)
}}`).ast
  );
  assert.equal(notice.includes('href="/servers/new"'), true);
  assert.equal(notice.includes('javascript:alert(1)'), false);

  const articleHtml = articlePage(
    {
      namespace_code: 'main',
      namespace_name: '문서',
      title: '대문',
      display_title: '대문',
      html: '<section class="front-wiki-component"><p><a class="wiki-link" href="/wiki/%EB%AA%B9">몹</a></p></section>',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: '[]',
      components_json: JSON.stringify([{ name: 'front_card', props: { 링크1: '몹' } }])
    },
    null
  );
  assert.equal(articleHtml.includes('/search?q=%EB%AA%B9'), true);
  assert.equal(articleHtml.includes('/wiki/%EB%AA%B9'), false);
});

test('renders Korean wiki style inline syntax, folding blocks, and pipe tables', () => {
  const parsed = parseMarkup(`{{{#!folding 자세히
> 인용문
}}}

~~삭제~~ __밑줄__ ^^위^^ ,,아래,, {{{#red 색}}} {{{+2 크게}}} [[https://example.com|외부]]

----

|| 이름 || 값 ||
|| 엔드 || [[엔드]] ||

[[분류:문법]]`);
  const html = renderDocument(parsed.ast);
  assert.equal(html.includes('wiki-fold'), true);
  assert.equal(html.includes('<blockquote class="wiki-quote">인용문</blockquote>'), true);
  assert.equal(html.includes('<s>삭제</s>'), true);
  assert.equal(html.includes('<u>밑줄</u>'), true);
  assert.equal(html.includes('<sup>위</sup>'), true);
  assert.equal(html.includes('<sub>아래</sub>'), true);
  assert.equal(html.includes('style="color:red"') || html.includes('style="color: red"'), true);
  assert.equal(html.includes('class="wiki-size"'), true);
  assert.equal(html.includes('<hr />') || html.includes('<hr>'), true);
  assert.equal(html.includes('class="component-table wiki-table"'), true);
  assert.equal(html.includes('class="table-scroll"'), true);
  assert.equal(parsed.links.includes('엔드'), true);
});

test('dark inline wiki colors get a readable fallback class', () => {
  const html = renderDocument(parseMarkup('본문 {{{#000 검정}}} {{{#navy 남색}}} {{{#222 어두운 회색}}} {{{#f66 밝은 빨강}}} {{{#rgb(0,0,0) RGB검정}}}').ast);
  assert.equal(html.includes('class="wiki-color wiki-color-dark-unsafe"'), true);
  assert.equal(html.includes('style="color:#000"') || html.includes('style="color: #000"'), true);
  assert.equal(html.includes('style="color:navy"') || html.includes('style="color: navy"'), true);
  assert.equal(html.includes('style="color:#222"') || html.includes('style="color: #222"'), true);
  assert.equal(html.includes('style="color:rgb(0, 0, 0)"') || html.includes('style="color: rgb(0, 0, 0)"'), true);
  assert.equal(html.includes('class="wiki-color" style="color: #f66"') || html.includes('class="wiki-color" style="color:#f66"'), true);
});

test('article page marks missing links from repository metadata', () => {
  const html = articlePage(
    {
      namespace_code: 'main',
      namespace_name: '문서',
      title: '테스트',
      display_title: '테스트',
      html: '<p><a class="wiki-link" href="/wiki/%EC%97%86%EB%8A%94_%EB%AC%B8%EC%84%9C">없는 문서</a></p>',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: JSON.stringify([{ namespace_code: 'main', title: '없는 문서' }])
    },
    null
  );
  assert.equal(html.includes('class="wiki-link missing"'), true);
  assert.equal(html.includes('title="문서 없음"'), true);
});

test('article sidebar sanitizes custom target URLs', () => {
  const html = articlePage(
    {
      namespace_code: 'server',
      namespace_name: '서버',
      title: '테스트',
      display_title: '테스트',
      html: '<p>본문</p>',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: '[]',
      sidebarItems: [
        { id: 1, label: '위험', target_url: 'javascript:alert(1)' },
        { id: 2, label: '로컬', target_url: '/server/%ED%85%8C%EC%8A%A4%ED%8A%B8/%EA%B7%9C%EC%B9%99' },
        { id: 3, label: '외부', target_url: 'https://example.com/docs' }
      ]
    },
    null
  );
  assert.equal(html.includes('javascript:alert(1)'), false);
  assert.equal(html.includes('href="/server/%ED%85%8C%EC%8A%A4%ED%8A%B8/%EA%B7%9C%EC%B9%99"'), true);
  assert.equal(html.includes('href="https://example.com/docs"'), true);
});

test('subwiki sidebars and article TOC preserve parent child hierarchy', () => {
  const html = articlePage(
    {
      namespace_code: 'server',
      namespace_name: '서버',
      title: '테스트서버/규칙',
      display_title: '규칙',
      html: '<h2 id="overview">개요</h2><h3 id="rules">규칙</h3><h4 id="ban">제재</h4>',
      categories_json: '[]',
      toc_json: JSON.stringify([
        { level: 2, id: 'overview', text: '개요' },
        { level: 3, id: 'rules', text: '규칙' },
        { level: 4, id: 'ban', text: '제재' }
      ]),
      missing_links_json: '[]',
      sidebarItems: [
        { id: 10, label: '서버 소개', target_title: '테스트서버/대문' },
        { id: 11, parent_id: 10, label: '규칙', target_title: '테스트서버/규칙' },
        { id: 12, parent_id: 11, label: '제재 기준', target_title: '테스트서버/제재' }
      ]
    },
    null
  );
  assert.equal(html.includes('aria-label="문서 트리"'), true);
  assert.equal(html.includes('sidebar-tree-root-details'), true);
  assert.equal(html.includes('sidebar-tree-level-0'), true);
  assert.equal(html.includes('sidebar-tree-level-1'), true);
  assert.equal(html.includes('sidebar-tree-level-2'), true);
  assert.equal(html.includes('sidebar-tree-item has-children'), true);
  const treeStart = html.indexOf('sidebar-tree-root');
  assert.equal(html.indexOf('서버 소개', treeStart) < html.indexOf('규칙', treeStart), true);
  assert.equal(html.indexOf('규칙', treeStart) < html.indexOf('제재 기준', treeStart), true);
  assert.equal(html.includes('aria-label="문서 목차"'), true);
  assert.equal(html.includes('article-toc-tree'), true);
  assert.equal(html.includes('article-toc-level-2'), true);
  assert.equal(html.includes('article-toc-children'), true);
  assert.equal(html.includes('class="sidebar-tree-marker" aria-hidden="true"'), true);
  assert.equal(html.includes('class="sidebar-tree-label">제재 기준</span>'), true);
  assert.equal(html.includes('class="toc-l3 article-toc-link" href="#rules"'), true);
  assert.equal(html.includes('class="toc-l4 article-toc-link" href="#ban"'), true);
  assert.equal(html.includes('<span class="article-toc-number" aria-hidden="true">1.</span>'), true);
  assert.equal(html.includes('<span class="article-toc-number" aria-hidden="true">1.1.</span>'), true);
  assert.equal(html.includes('<span class="article-toc-number" aria-hidden="true">1.1.1.</span>'), true);
  assert.equal(html.includes('class="article-toc-label">제재</span>'), true);
  const tocStart = html.indexOf('article-toc-tree');
  assert.equal(html.indexOf('개요', tocStart) < html.indexOf('규칙', tocStart), true);
  assert.equal(html.indexOf('규칙', tocStart) < html.indexOf('제재', tocStart), true);
});

test('space hub pages use specific wiki cards instead of repeated placeholders', () => {
  const help = spaceHomePage('help', null);
  assert.equal(help.includes('wiki-hub-page'), true);
  assert.equal(help.includes('/help/%EC%B2%98%EC%9D%8C_%ED%8E%B8%EC%A7%91%ED%95%98%EA%B8%B0'), true);
  assert.equal(help.includes('문서 생성, 요약 작성, 검토 흐름'), true);
  assert.equal(help.includes('편집, 신고, 서버 인증, GitBook 이전 도움말을 제공합니다.</p></div>'), false);
  assert.equal(help.includes('class="active-space" href="/wiki"'), true);

  const special = spaceHomePage('special', null);
  assert.equal(special.includes('<h1>특수 문서</h1>'), true);
  assert.equal(special.includes('<span class="intent-context">특수</span>'), true);
  assert.equal(special.includes('href="/special/page-requests">작성 요청</a>'), true);
  assert.equal(special.includes('href="/special/needs_check"'), true);
  assert.equal(special.includes('href="/special/needed-pages"'), true);
  assert.equal(special.includes('문서 작성 요청'), true);
  assert.equal(special.includes('href="/special/revision-search"'), true);
  assert.equal(special.includes('href="/status"'), true);
  assert.equal(special.includes('class="active-space" href="/wiki"'), true);
  assert.equal(special.includes('프로젝트'), false);
  assert.equal(special.includes('href="/admin/files"'), false);

  const adminSpecial = spaceHomePage('special', { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] });
  assert.equal(adminSpecial.includes('href="/watchlist"'), true);
  assert.equal(adminSpecial.includes('href="/admin/search"'), true);
  assert.equal(adminSpecial.includes('href="/admin/files"'), true);
  const developerSpecial = spaceHomePage('special', { id: 3, username: 'dev', display_name: '개발자', groups: ['developer'], permissions: [] });
  assert.equal(developerSpecial.includes('href="/admin/search"'), true);
  assert.equal(developerSpecial.includes('href="/admin/files"'), true);

  const templateHome = spaceHomePage('template', null);
  assert.equal(templateHome.includes('<h1>틀</h1>'), true);
  assert.equal(templateHome.includes('href="/templates/new"'), true);
  assert.equal(templateHome.includes('위키 문법'), true);
  assert.equal(templateHome.includes('표시할 항목이 없습니다'), false);

  const fileHome = spaceHomePage('file', null);
  assert.equal(fileHome.includes('<h1>파일</h1>'), true);
  assert.equal(fileHome.includes('href="/file/upload"'), true);
  assert.equal(fileHome.includes('문서에 사용할 스크린샷'), true);
  assert.equal(fileHome.includes('파일 라이선스 정책'), true);
  assert.equal(fileHome.includes('href="/admin/files"'), false);
  assert.equal(fileHome.includes('표시할 항목이 없습니다'), false);

  const adminFileHome = spaceHomePage('file', { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] });
  assert.equal(adminFileHome.includes('href="/admin/files"'), true);
  const developerFileHome = spaceHomePage('file', { id: 3, username: 'dev', display_name: '개발자', groups: ['developer'], permissions: [] });
  assert.equal(developerFileHome.includes('href="/admin/files"'), true);

  const uploadHtml = fileUploadPage({ id: 2, username: 'uploader', display_name: '업로더', groups: ['autoconfirmed'], permissions: [] } as any, true);
  assert.equal(uploadHtml.includes('enctype="multipart/form-data"'), true);
  assert.equal(uploadHtml.includes('accept="image/png,image/jpeg,image/webp,image/gif"'), true);
  assert.equal(uploadHtml.includes('name="license"'), true);
  assert.equal(uploadHtml.includes('name="sourceUrl"'), true);
  assert.equal(uploadHtml.includes('파일 업로드</button>'), true);
  assert.equal(uploadHtml.includes('/api/files'), false);
  assert.equal(uploadHtml.includes('href="/admin/files"'), false);
  assert.equal(uploadHtml.includes('업로드 파일 목록'), true);
  const lockedUploadHtml = fileUploadPage(null, false, '로그인 후 이용하세요.');
  assert.equal(lockedUploadHtml.includes('로그인 필요'), true);
  assert.equal(lockedUploadHtml.includes('/login?next=%2Ffile%2Fupload'), true);
  assert.equal(lockedUploadHtml.includes('로그인 후 이용하세요.'), true);
  assert.equal(lockedUploadHtml.includes('href="/admin/files"'), false);
  assert.equal(lockedUploadHtml.includes('업로드 권한 확인'), true);
  const adminUploadHtml = fileUploadPage({ id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] } as any, true);
  assert.equal(adminUploadHtml.includes('href="/admin/files"'), true);
  const developerUploadHtml = fileUploadPage({ id: 3, username: 'dev', display_name: '개발자', groups: ['developer'], permissions: [] } as any, true);
  assert.equal(developerUploadHtml.includes('href="/admin/files"'), true);

  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("app.get('/modpack', async (_request, reply) => reply.redirect('/mods'));"), true);
  assert.equal(serverTs.includes("app.get('/file', async"), true);
  assert.equal(serverTs.includes("app.get('/file/upload'"), true);
  assert.equal(serverTs.includes("app.post('/file/upload'"), true);
  assert.equal(serverTs.includes("app.get('/files/new'"), true);
  assert.equal(serverTs.includes('async function uploadFileAction'), true);
  assert.equal(serverTs.includes("app.get('/template', async"), true);
});

test('subwiki root pages use wiki landing titles and navigation', () => {
  const html = articlePage(
    {
      namespace_code: 'mod',
      namespace_name: '모드',
      title: 'Create',
      display_title: 'Create',
      html: '<p>Create 설명</p>',
      categories_json: '[]',
      toc_json: '[]',
      components_json: JSON.stringify([{ name: 'mod_info', props: { 이름: 'Create', 로더: 'Forge · Fabric', 분류: '기술', '지원 버전': '문서 참조', '서버 필요': '알 수 없음', 상태: '확인 필요' } }]),
      missing_links_json: '[]',
      sidebarItems: [],
      recentRows: [{ namespace_code: 'mod', title: 'Create/축', display_title: '축', created_at: '2026-05-24 12:00:00' }]
    },
    null
  );
  assert.equal(html.includes('<h1>Create 위키</h1>'), true);
  assert.equal(html.includes('모드:Create'), false);
  assert.equal(html.includes('subwiki-home'), true);
  assert.equal(html.includes('회전력'), true);
  assert.equal(html.includes('subwiki-home-links'), false);
  assert.equal(html.includes('<div class="subwiki-status-row"><span class="tag">Forge</span><span class="tag">Fabric</span></div>'), true);
  assert.equal(html.includes('문서 참조'), false);
  assert.equal(html.includes('알 수 없음'), false);
  assert.equal(html.includes('확인 필요'), false);
  assert.equal(html.includes('class="sidebar-section sidebar-recent"'), true);
  assert.equal(html.includes('href="/recent?namespace=mod&amp;prefix=Create">더 보기</a>'), true);

  const modHomeHtml = articlePage(
    {
      namespace_code: 'mod',
      namespace_name: '모드',
      title: 'Create/대문',
      display_title: '대문',
      html: '<p>Create 설명</p>',
      categories_json: '[]',
      toc_json: '[]',
      components_json: JSON.stringify([{ name: 'mod_info', props: { 이름: 'Create', 로더: 'Forge · Fabric', 분류: '기술' } }]),
      missing_links_json: '[]',
      sidebarItems: [],
      recentRows: []
    },
    null
  );
  assert.equal(modHomeHtml.includes('<h1>Create 위키</h1>'), true);
  assert.equal(modHomeHtml.includes('skin-space'), true);
  assert.equal(modHomeHtml.includes('href="/mod/Create/new">새 문서'), true);
  assert.equal(modHomeHtml.includes('href="/mod/Create/%EB%8C%80%EB%AC%B8/new"'), false);

  const serverHtml = articlePage(
    {
      namespace_code: 'server',
      namespace_name: '서버',
      title: 'example',
      display_title: '예시 서버',
      html: '<p>서버 설명</p>',
      categories_json: '[]',
      toc_json: '[]',
      components_json: JSON.stringify([{ name: 'server_info', props: { 에디션: 'java', '지원 버전': '1.21.x', 장르: '반야생' } }]),
      missing_links_json: '[]',
      sidebarItems: [],
      recentRows: []
    },
    null
  );
  assert.equal(serverHtml.includes('<h1>예시 서버 위키</h1>'), true);
  assert.equal(serverHtml.includes('<title>예시 서버 위키 - MineWiki 서버</title>'), true);
  assert.equal(serverHtml.includes('<h1>example 위키</h1>'), false);
  assert.equal(serverHtml.includes('/server/example/%EC%84%9C%EB%B2%84_%EA%B7%9C%EC%B9%99'), true);
  assert.equal(serverHtml.includes('/server/example/%EA%B7%9C%EC%B9%99'), false);
});

test('user wiki pages hide login id from visible document titles', () => {
  const html = articlePage(
    {
      namespace_code: 'main',
      namespace_name: '문서',
      title: '사용자:secret-login',
      display_title: '사용자:secret-login',
      html: '<p>사용자 문서 본문</p>',
      categories_json: '[]',
      toc_json: '[]',
      components_json: '[]',
      missing_links_json: '[]',
      sidebarItems: []
    },
    null
  );
  assert.equal(html.includes('<h1>사용자 문서</h1>'), true);
  assert.equal(html.includes('<title>사용자 문서 - MineWiki</title>'), true);
  assert.equal(html.includes('<h1>사용자:secret-login</h1>'), false);
  assert.equal(html.includes('<title>사용자:secret-login - MineWiki</title>'), false);

  const editHtml = editPage('main', '사용자:secret-login/연습장', 'memo', { id: 1, username: 'secret-login', display_name: '표시명', groups: [], permissions: [] });
  assert.equal(editHtml.includes('<h1>연습장 편집</h1>'), true);
  assert.equal(editHtml.includes('name="title" value="사용자:secret-login/연습장"'), true);
  assert.equal(editHtml.includes('name="title" value="연습장"'), false);
  assert.equal(editHtml.includes('value="연습장" readonly'), true);
});

test('article tools expose ACL and anonymous editor warns about IP history', () => {
  const articleHtml = articlePage(
    {
      id: 1,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '테스트',
      display_title: '테스트',
      html: '<p>본문</p>',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: '[]',
      protection_level: 'open',
      discussionThreads: [{ id: 7, title: '표제어 정리', status: 'open', comment_count: 2, updated_at: '2026-05-24 12:00:00' }],
      canCreateDiscussion: true
    },
    null
  );
  assert.equal(articleHtml.includes('/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/acl'), true);
  assert.equal(articleHtml.includes('/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion'), true);
  assert.equal(articleHtml.includes('/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/raw'), true);
  assert.equal(articleHtml.includes('class="document-mode-tabs"'), true);
  assert.equal(articleHtml.includes('class="document-tool-links"'), true);
  assert.equal(articleHtml.includes('class="discussion-panel"'), false);
  assert.equal(articleHtml.includes('<strong>문서 보조</strong>'), false);
  assert.equal(articleHtml.includes('article-watch-control'), false);
  assert.equal(articleHtml.includes('원본 편집'), false);
  assert.equal(articleHtml.includes('역사 보기'), false);

  const watchedArticleHtml = articlePage(
    {
      id: 2,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '감시',
      display_title: '감시',
      html: '<p>본문</p>',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: '[]',
      protection_level: 'open',
      is_watched: true,
      watch_discussion: true
    },
    { id: 1, username: 'wiki-user', display_name: '위키러', groups: [], permissions: [] }
  );
  assert.equal(watchedArticleHtml.includes('article-watch-control is-watched'), true);
  assert.equal(watchedArticleHtml.includes('action="/watchlist/2"'), true);
  assert.equal(watchedArticleHtml.includes('action="/watchlist/2/remove"'), true);
  assert.equal(watchedArticleHtml.includes('name="next" value="/wiki/%EA%B0%90%EC%8B%9C"'), true);
  assert.equal(watchedArticleHtml.includes('토론 끄기'), true);
  assert.equal(watchedArticleHtml.includes('감시 해제'), true);
  const unwatchedArticleHtml = articlePage(
    {
      id: 3,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '새감시',
      display_title: '새감시',
      html: '<p>본문</p>',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: '[]',
      protection_level: 'open'
    },
    { id: 1, username: 'wiki-user', display_name: '위키러', groups: [], permissions: [] }
  );
  assert.equal(unwatchedArticleHtml.includes('action="/watchlist/3"'), true);
  assert.equal(unwatchedArticleHtml.includes('>감시</button>'), true);
  assert.equal(unwatchedArticleHtml.includes('name="next" value="/wiki/%EC%83%88%EA%B0%90%EC%8B%9C"'), true);

  const lockedArticleHtml = articlePage(
    {
      id: 1,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '잠금',
      display_title: '잠금',
      html: '<h2 id="intro">개요</h2>',
      categories_json: '[]',
      toc_json: JSON.stringify([{ level: 2, id: 'intro', text: '개요' }]),
      missing_links_json: '[]',
      protection_level: 'open',
      sectionLocks: [{ anchor: 'intro', heading: '개요', lock_type: 'admin_only', reason: '정책' }]
    },
    { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['page.protect'] }
  );
  assert.equal(lockedArticleHtml.includes('관리자 전용'), true);
  assert.equal(lockedArticleHtml.includes('문서 관리'), true);
  assert.equal(lockedArticleHtml.includes('/admin/pages/1/protect'), true);
  assert.equal(lockedArticleHtml.includes('/api/admin/pages/1/protect'), false);
  assert.equal(lockedArticleHtml.includes('>관리자 전용</option>'), true);
  assert.equal(lockedArticleHtml.includes('>admin_only</option>'), false);
  assert.equal(lockedArticleHtml.includes('>owner_only</option>'), false);
  assert.equal(lockedArticleHtml.includes('>trusted_only</option>'), false);
  const reportOnlyArticleHtml = articlePage(
    {
      id: 1,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '잠금',
      display_title: '잠금',
      html: '<h2 id="intro">개요</h2>',
      categories_json: '[]',
      toc_json: JSON.stringify([{ level: 2, id: 'intro', text: '개요' }]),
      missing_links_json: '[]',
      protection_level: 'open',
      sectionLocks: [{ anchor: 'intro', heading: '개요', lock_type: 'admin_only', reason: '정책' }]
    },
    { id: 2, username: 'reviewer', display_name: '검토자', groups: [], permissions: ['report.handle'] }
  );
  assert.equal(reportOnlyArticleHtml.includes('/admin/pages/1/protect'), false);
  assert.equal(reportOnlyArticleHtml.includes('action="/admin/pages/1/section-locks"'), false);
  assert.equal(reportOnlyArticleHtml.includes('보호 저장'), false);
  assert.equal(reportOnlyArticleHtml.includes('문단 잠금'), true);
  assert.equal(reportOnlyArticleHtml.includes('관리자 전용'), true);
  const deleteToolsHtml = articlePage(
    {
      id: 6,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '삭제대상',
      display_title: '삭제대상',
      html: '<p>본문</p>',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: '[]',
      protection_level: 'trusted_only'
    },
    { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['page.protect', 'page.delete'] }
  );
  assert.equal(deleteToolsHtml.includes('/admin/pages/6/delete'), true);
  assert.equal(deleteToolsHtml.includes('/api/admin/pages/6/delete'), false);
  assert.equal(deleteToolsHtml.includes('문서 삭제'), true);
  assert.equal(deleteToolsHtml.includes('placeholder="삭제대상"'), true);
  assert.equal(deleteToolsHtml.includes('>trusted_only<'), false);

  const oldRevisionHtml = articlePage(
    {
      namespace_code: 'main',
      namespace_name: '문서',
      title: '테스트',
      display_title: '테스트',
      html: '<p>old</p>',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: '[]',
      protection_level: 'open',
      view_revision_id: 4,
      view_revision_no: 2,
      view_revision_created_at: '2026-05-24 12:00:00',
      current_revision_id: 9
    },
    { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: [] } as any
  );
  assert.equal(oldRevisionHtml.includes('action="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/rollback"'), true);
  assert.equal(oldRevisionHtml.includes('name="action" value="rollback"'), false);

  const discussionHtml = discussionPage(
    {
      id: 1,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '테스트',
      display_title: '테스트',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: '[]',
      protection_level: 'open',
      discussionThreads: [{
        id: 7,
        title: '표제어 정리',
        status: 'open',
        created_by: 3,
        comment_count: 2,
        updated_at: '2026-05-24 12:00:00',
        comments: [{ id: 11, actor_name: '토론자', body: '첫 의견\n둘째 줄', created_at: '2026-05-24 12:10:00' }]
      }, {
        id: 8,
        title: '합의 완료',
        status: 'resolved',
        created_by: 4,
        comment_count: 1,
        updated_at: '2026-05-24 12:20:00',
        comments: []
      }],
      recentRows: [{ namespace_code: 'main', title: '최근 문서', display_title: '최근 문서', created_at: '2026-05-24 12:00:00' }],
      canCreateDiscussion: true,
      canWriteDiscussion: true
    },
    null
  );
  assert.equal(discussionHtml.includes('테스트 토론'), true);
  assert.equal(discussionHtml.includes('class="wiki-shell skin-article discussion-shell'), true);
  assert.equal(discussionHtml.includes('class="sidebar-section sidebar-recent"'), true);
  assert.equal(discussionHtml.includes('최근 문서'), true);
  assert.equal(discussionHtml.includes('class="active" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion">토론'), true);
  assert.equal(discussionHtml.includes('class="discussion-panel"'), true);
  assert.equal(discussionHtml.includes('class="discussion-summary"'), true);
  assert.equal(discussionHtml.includes('닫힌 토론<small>합의가 끝나 기록으로 남은 주제입니다.'), true);
  assert.equal(discussionHtml.includes('토론 이용 순서'), true);
  assert.equal(discussionHtml.includes('열린 토론에서 이미 논의 중인 주제가 있는지'), true);
  assert.equal(discussionHtml.includes('class="discussion-tabs"'), true);
  assert.equal(discussionHtml.includes('aria-current="page" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion?status=open#discussion">열린 토론<span>1</span>'), true);
  assert.equal(discussionHtml.includes('href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion?status=closed#discussion">닫힌 토론<span>1</span>'), true);
  assert.equal(discussionHtml.includes('href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion?status=new#discussion">새 토론</a>'), true);
  assert.equal(discussionHtml.includes('id="discussion-open"'), true);
  assert.equal(discussionHtml.includes('표제어 정리'), true);
  assert.equal(discussionHtml.includes('합의 완료'), false);
  assert.equal(discussionHtml.includes('action="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion"'), false);
  assert.equal(discussionHtml.includes('id="discussion-thread-7"'), true);
  assert.equal(discussionHtml.includes('id="discussion-comment-11"'), true);
  assert.equal(discussionHtml.includes('첫 의견<br>둘째 줄'), true);
  assert.equal(discussionHtml.includes('action="/discussion/7/comments"'), true);
  assert.equal(discussionHtml.includes('data-action="discussion_comment"') || !discussionHtml.includes('cf-turnstile'), true);
  assert.equal(discussionHtml.includes('<strong>문서 보조</strong>'), false);
  assert.equal(discussionHtml.includes('<strong>문서 도구</strong>'), false);
  assert.equal(discussionHtml.includes('원본 편집'), false);
  assert.equal(discussionHtml.includes('새로고침'), false);

  const closedDiscussionHtml = discussionPage(
    {
      id: 1,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '테스트',
      display_title: '테스트',
      protection_level: 'open',
      discussionStatus: 'resolved',
      discussionThreads: [
        { id: 7, title: '표제어 정리', status: 'open', comment_count: 2, updated_at: '2026-05-24 12:00:00', comments: [] },
        { id: 8, title: '합의 완료', status: 'resolved', comment_count: 1, updated_at: '2026-05-24 12:20:00', comments: [] }
      ],
      canCreateDiscussion: true,
      canWriteDiscussion: true
    },
    null
  );
  assert.equal(closedDiscussionHtml.includes('aria-current="page" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion?status=closed#discussion">닫힌 토론'), true);
  assert.equal(closedDiscussionHtml.includes('합의 완료'), true);
  assert.equal(closedDiscussionHtml.includes('표제어 정리'), false);
  assert.equal(closedDiscussionHtml.includes('action="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion"'), false);

  const newDiscussionHtml = discussionPage(
    {
      id: 1,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '테스트',
      display_title: '테스트',
      protection_level: 'open',
      discussionStatus: 'new',
      discussionThreads: [],
      canCreateDiscussion: true,
      canWriteDiscussion: true
    },
    null
  );
  assert.equal(newDiscussionHtml.includes('aria-current="page" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion?status=new#discussion">새 토론'), true);
  assert.equal(newDiscussionHtml.includes('action="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion"'), true);

  const ownerDiscussionHtml = discussionPage(
    {
      id: 1,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '테스트',
      display_title: '테스트',
      categories_json: '[]',
      toc_json: '[]',
      missing_links_json: '[]',
      protection_level: 'open',
      discussionThreads: [{ id: 7, title: '표제어 정리', status: 'open', created_by: 3, comment_count: 2, updated_at: '2026-05-24 12:00:00', comments: [] }],
      canCreateDiscussion: true,
      canWriteDiscussion: true
    },
    { id: 3, username: 'editor', display_name: '편집자', groups: [], permissions: [] }
  );
  assert.equal(ownerDiscussionHtml.includes('action="/discussion/7/status"'), true);
  assert.equal(ownerDiscussionHtml.includes('name="status" value="resolved"'), true);
  assert.equal(ownerDiscussionHtml.includes('해결로 표시'), true);

  const editHtml = editPage('main', '테스트', '내용', null, [], 'article', 1);
  assert.equal(editHtml.includes('비로그인 편집 안내'), true);
  assert.equal(editHtml.includes('IP 주소가 문서 역사에 공개됩니다'), true);
  assert.equal(editHtml.includes('type="checkbox" required'), true);
  assert.equal(editHtml.includes('class="directory-summary editor-summary"'), true);
  assert.equal(editHtml.includes('class="editor-guide-panel"'), true);
  assert.equal(editHtml.includes('저장 전 확인'), true);
  assert.equal(editHtml.includes('내부 링크'), true);
  assert.equal(editHtml.includes('class="active" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/edit">편집'), true);
  assert.equal(editHtml.includes('href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion">토론'), true);
  assert.equal(editHtml.includes('소스와 미리보기를 탭으로 전환합니다'), false);
  assert.equal(editHtml.includes('class="component-tool-group"'), true);
  assert.equal(editHtml.includes('data-template="block_info"'), true);
  assert.equal(editHtml.includes('data-template="server_info"'), false);
  assert.equal(editHtml.includes('data-component-forms="official_doc_link,block_info,item_info,mob_info,crafting_recipe,smelting_recipe,drop_table,villager_trade,edition_diff,version_history,command_info"'), true);
  assert.equal(editHtml.includes('/assets/editor.js?v=20260525-scoped-tools'), true);

  const rawHtml = rawPage(
    {
      namespace_code: 'main',
      title: '테스트',
      display_title: '테스트'
    },
    "'''원문''' <script>alert(1)</script>",
    null,
    { revision_no: 3, created_at: '2026-05-24 12:00:00' }
  );
  assert.equal(rawHtml.includes('테스트 원문'), true);
  assert.equal(rawHtml.includes('class="active" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/raw">원문'), true);
  assert.equal(rawHtml.includes("&#39;&#39;&#39;원문&#39;&#39;&#39; &lt;script&gt;alert(1)&lt;/script&gt;"), true);
  assert.equal(rawHtml.includes('r3 · 2026.05.24. 12:00'), true);
  assert.equal(rawHtml.includes('class="raw-summary"'), true);
  assert.equal(rawHtml.includes('<strong>r3</strong>표시 판'), true);
  assert.equal(rawHtml.includes('원문 읽는 방법'), true);
  assert.equal(rawHtml.includes('렌더링된 문서가 아니라 저장된 위키 문법을 그대로 보여줍니다.'), true);
  assert.equal(rawHtml.includes('bytes'), false);
  assert.equal(rawHtml.includes('바이트'), true);
  assert.equal(rawHtml.includes('문서 보기'), true);
  assert.equal(rawHtml.includes('판 기록'), true);
  assert.equal(rawHtml.includes('복사 가능한 위키 문법 원문'), true);
});

test('server wiki article applies safe server theme tokens', () => {
  const html = articlePage(
    {
      id: 1,
      namespace_code: 'server',
      namespace_name: '서버',
      title: '예시서버/규칙',
      display_title: '예시서버/규칙',
      html: '<p>규칙 본문</p>',
      categories_json: '[]',
      toc_json: '[]',
      components_json: '[]',
      missing_links_json: '[]',
      sidebarItems: [],
      subwikiTheme: {
        theme_key: 'minimal-docs',
        primary_color: '#12695f',
        accent_color: '#315c9a',
        background_mode: 'system',
        branding_mode: 'compact',
        custom_css_status: 'approved',
        custom_css: '.article-head{border-top:3px solid #12695f}'
      }
    },
    null
  );
  assert.equal(html.includes('class="minewiki is-anonymous server-themed server-theme-minimal-docs server-branding-compact server-bg-system"'), true);
  assert.equal(html.includes('<style id="server-subwiki-theme">'), true);
  assert.equal(html.includes('--server-primary:#12695f'), true);
  assert.equal(html.includes('--server-readable:color-mix(in srgb,var(--server-primary) 72%,black)'), true);
  assert.equal(html.includes('--brand-0:var(--server-readable)'), true);
  assert.equal(html.includes(':root[data-theme="dark"] body.server-themed{--server-readable:color-mix(in srgb,var(--server-primary) 45%,white);--brand-0:var(--server-readable)'), true);
  assert.equal(html.includes('body.server-themed .article-head{border-top:3px solid #12695f}'), true);
});

test('subwiki document tool pages keep sidebar and theme chrome', () => {
  const page = {
    id: 1,
    namespace_code: 'server',
    namespace_name: '서버',
    title: '예시서버/규칙',
    display_title: '규칙',
    protection_level: 'open',
    aclSummary: {},
    aclRules: [],
    aclLogs: [],
    sidebarItems: [{ label: '규칙', target_title: '예시서버/규칙' }],
    recentRows: [],
    subwikiTheme: {
      theme_key: 'minimal-docs',
      primary_color: '#12695f',
      accent_color: '#315c9a',
      background_mode: 'system',
      branding_mode: 'compact',
      custom_css_status: 'approved',
      custom_css: '.article-head{border-top:3px solid #12695f}'
    }
  };
  const historyHtml = revisionHistoryPage(page, [{ id: 12, revision_no: 2, actor_name: '관리자', created_at: '2026-05-24 12:00:00', edit_summary: '수정' }], null);
  const rawHtml = rawPage(page, '원문', null);
  const diffHtml = revisionDiffPage(page, { fromRevisionId: 11, toRevisionId: 12, fromRevisionNo: 1, toRevisionNo: 2, changes: [] }, null);
  const aclHtml = permissionInfoPage(page, [], null);

  for (const html of [historyHtml, rawHtml, diffHtml, aclHtml]) {
    assert.equal(html.includes('wiki-shell skin-space'), true);
    assert.equal(html.includes('<aside class="wiki-sidebar">'), true);
    assert.equal(html.includes('tool-article'), true);
    assert.equal(html.includes('class="minewiki is-anonymous server-themed server-theme-minimal-docs server-branding-compact server-bg-system"'), true);
    assert.equal(html.includes('<style id="server-subwiki-theme">'), true);
  }
  assert.equal(historyHtml.includes('<title>규칙 판 기록 - MineWiki 서버</title>'), true);
  assert.equal(diffHtml.includes('<title>규칙 문서 비교 - MineWiki 서버</title>'), true);
  assert.equal(aclHtml.includes('<title>규칙 ACL - MineWiki 서버</title>'), true);
  assert.equal(diffHtml.includes('변경된 줄 없음'), true);
  assert.equal(aclHtml.includes('개별 ACL 규칙 없음'), true);
  assert.equal(historyHtml.includes('<title>예시서버/규칙 판 기록'), false);
});

test('modpack pages inherit mod family navigation with modpack identity', () => {
  const html = articlePage(
    {
      namespace_code: 'modpack',
      namespace_name: '모드팩',
      title: 'RLCraft',
      display_title: 'RLCraft',
      html: '<p>설치와 호환성 문서</p>',
      categories_json: '[]',
      toc_json: '[]',
      components_json: '[]',
      missing_links_json: '[]'
    },
    null
  );
  assert.equal(html.includes('<title>RLCraft - MineWiki 모드팩</title>'), true);
  assert.equal(html.includes('class="active-space" href="/mods"'), true);
  assert.equal(html.includes('[Modpack]'), true);
  assert.equal(html.includes('모드팩 문서'), true);

  const editHtml = editPage('modpack', 'RLCraft', '내용', null, [], 'guide', 1);
  assert.equal(editHtml.includes('<title>RLCraft 편집 - MineWiki 모드팩</title>'), true);
  assert.equal(editHtml.includes('class="active-space" href="/mods"'), true);
  assert.equal(editHtml.includes('class="active" href="/modpack/RLCraft/edit">편집'), true);

  const aclHtml = permissionInfoPage(
    {
      namespace_code: 'modpack',
      title: 'RLCraft',
      display_title: 'RLCraft',
      protection_level: 'open',
      aclSummary: {},
      aclRules: [],
      aclLogs: []
    },
    [],
    null
  );
  assert.equal(aclHtml.includes('<title>RLCraft ACL - MineWiki 모드팩</title>'), true);
  assert.equal(aclHtml.includes('class="active-space" href="/mods"'), true);
  assert.equal(aclHtml.includes('class="active" href="/modpack/RLCraft/acl">ACL'), true);
});

test('auxiliary namespaces keep wiki family navigation and specific identity', () => {
  const guideEdit = editPage('guide', '처음 시작하기', '내용', null, [], 'guide', 1);
  assert.equal(guideEdit.includes('<title>처음 시작하기 편집 - MineWiki 가이드</title>'), true);
  assert.equal(guideEdit.includes('class="active-space" href="/wiki"'), true);
  assert.equal(guideEdit.includes('<span class="intent-context">가이드</span>'), true);
  assert.equal(guideEdit.includes('href="/search?space=guide">가이드 검색</a>'), true);

  const dataEdit = editPage('data', '아이템 ID', '내용', null, [], 'data', 1);
  assert.equal(dataEdit.includes('<title>아이템 ID 편집 - MineWiki 데이터</title>'), true);
  assert.equal(dataEdit.includes('class="active-space" href="/wiki"'), true);
  assert.equal(dataEdit.includes('<span class="intent-context">데이터</span>'), true);
  assert.equal(dataEdit.includes('href="/search?space=data">데이터 검색</a>'), true);
  assert.equal(dataEdit.includes('data-template="data_type_info"'), true);
  assert.equal(dataEdit.includes('data-template="mob_info"'), false);

  const templateEdit = editPage('template', '문서 상태', '내용', null, [], 'template', 1);
  assert.equal(templateEdit.includes('<title>문서 상태 편집 - MineWiki 틀</title>'), true);
  assert.equal(templateEdit.includes('class="active-space" href="/wiki"'), true);
  assert.equal(templateEdit.includes('data-template="document_status"'), true);
  assert.equal(templateEdit.includes('data-template="block_info"'), false);

  const guideArticle = articlePage(
    {
      namespace_code: 'guide',
      namespace_name: '가이드',
      title: '처음 시작하기',
      display_title: '처음 시작하기',
      html: '<p>가이드 본문</p>',
      categories_json: '[]',
      toc_json: '[]',
      components_json: '[]',
      missing_links_json: '[]'
    },
    null
  );
  assert.equal(guideArticle.includes('<title>처음 시작하기 - MineWiki 가이드</title>'), true);
  assert.equal(guideArticle.includes('class="active-space" href="/wiki"'), true);
  assert.equal(guideArticle.includes('절차형 가이드'), true);
});

test('layout footer includes Discord link', () => {
  const html = layout('테스트', '<main>본문</main>');
  assert.equal(html.includes('href="https://discord.gg/HPh2xYjSVH"'), true);
  assert.equal(html.includes('rel="noopener noreferrer">Discord</a>'), true);
});

test('message pages use shared wiki chrome and escaped actions', () => {
  const html = messagePage('문서 없음', '<script>alert(1)</script>', null, {
    actionHref: '/wiki/대문?x=<bad>',
    actionLabel: '대문으로',
    tone: 'error'
  });
  assert.equal(html.includes('class="topbar nav-wrapper"'), true);
  assert.equal(html.includes('class="site-footer"'), true);
  assert.equal(html.includes('message-panel error'), true);
  assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
  assert.equal(html.includes('href="/wiki/대문?x=&lt;bad&gt;"'), true);
  assert.equal(html.includes('class="button ghost"'), false);
  const missingHtml = messagePage('문서 없음', '아직 작성되지 않은 문서입니다.', null, {
    actionHref: '/wiki/새문서/edit',
    actionLabel: '새 문서 만들기',
    secondaryHref: '/search?q=%EC%83%88%EB%AC%B8%EC%84%9C',
    secondaryLabel: '검색',
    tone: 'error'
  });
  assert.equal(missingHtml.includes('href="/wiki/새문서/edit"'), true);
  assert.equal(missingHtml.includes('href="/search?q=%EC%83%88%EB%AC%B8%EC%84%9C"'), true);
  assert.equal(missingHtml.includes('class="button ghost"'), true);
});

test('account utility pages use shared wiki chrome', () => {
  const html = logoutConfirmPage({ id: 1, username: 'wiki-user', display_name: '위키러', groups: [], permissions: [] });
  assert.equal(html.includes('class="topbar nav-wrapper"'), true);
  assert.equal(html.includes('class="site-footer"'), true);
  assert.equal(html.includes('class="active-space" href="/wiki"'), true);
  assert.equal(html.includes('class="message-panel"'), true);
  assert.equal(html.includes('class="account-flow-summary"'), true);
  assert.equal(html.includes('로그아웃 전 확인'), true);
  assert.equal(html.includes('작성 중인 편집 화면이 있으면 먼저 저장하거나 별도로 보관합니다.'), true);
  assert.equal(html.includes('<form class="message-actions" method="post">'), true);
  assert.equal(html.includes('href="/wiki"'), true);

  const verificationHtml = emailVerificationSentPage('wiki@example.kr');
  assert.equal(verificationHtml.includes('class="auth-shell"'), true);
  assert.equal(verificationHtml.includes('class="account-flow-summary"'), true);
  assert.equal(verificationHtml.includes('인증 완료 순서'), true);
  assert.equal(verificationHtml.includes('wiki@example.kr'), true);
  assert.equal(verificationHtml.includes('href="/join"'), true);

  const invalidVerificationHtml = invalidEmailVerificationPage();
  assert.equal(invalidVerificationHtml.includes('이메일 인증 실패'), true);
  assert.equal(invalidVerificationHtml.includes('다시 인증하는 순서'), true);
  assert.equal(invalidVerificationHtml.includes('auth-message-error'), true);

  const resetSentHtml = passwordResetSentPage();
  assert.equal(resetSentHtml.includes('비밀번호 재설정 순서'), true);
  assert.equal(resetSentHtml.includes('<strong>1시간</strong>유효 시간'), true);
  const invalidResetHtml = invalidPasswordResetPage();
  assert.equal(invalidResetHtml.includes('다시 요청하는 순서'), true);
  assert.equal(invalidResetHtml.includes('href="/forgot-password"'), true);
});

test('user dashboard makes logged-in workflows visible', () => {
  const user = { id: 1, username: 'wiki-user', display_name: '위키러', groups: ['admin'], permissions: ['report.handle'] };
  const html = userDashboardPage(
    user,
    { id: 1, status: 'active' },
    { watch_count: 2, assigned_task_count: 1, recommended_task_count: 3, completed_task_count: 4, edit_count: 5 },
    [{ change_type: 'edit', namespace_code: 'main', title: '대문', display_title: '첫 화면', summary: '정리', created_at: '2026-05-25 12:00:00' }]
  );
  assert.equal(html.includes('<body class="minewiki is-authenticated role-admin">'), true);
  assert.equal(html.includes('<h1>내 위키</h1>'), true);
  assert.equal(html.includes('href="/user/wiki-user"'), true);
  assert.equal(html.includes('href="/user/wiki-user/%EC%97%B0%EC%8A%B5%EC%9E%A5"'), true);
  assert.equal(html.includes('href="/watchlist"'), true);
  assert.equal(html.includes('href="/tasks"'), true);
  assert.equal(html.includes('<strong>2</strong><span>감시문서</span>'), true);
  assert.equal(html.includes('<strong>1</strong><span>배정 작업</span>'), true);
  assert.equal(html.includes('<strong>3</strong><span>추천 작업</span>'), true);
  assert.equal(html.includes('관리자'), true);
  assert.equal(html.includes('report.handle'), false);
  assert.equal(html.includes('<a href="/wiki/%EB%8C%80%EB%AC%B8">첫 화면</a>'), true);
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("return reply.redirect(`/user/${encodeURIComponent(user.username)}`);"), false);
  assert.equal(serverTs.includes('userDashboardStats'), true);
  assert.equal(serverTs.includes('filterRecentRowsForActor'), true);
});

test('auth pages use shared wiki chrome and flat wiki skin tokens', () => {
  const html = authPage(
    '로그인',
    '이메일 로그인',
    'MineWiki에 로그인',
    '<form class="auth-form"><input name="email"><button>로그인</button></form>'
  );
  const css = readFileSync(new URL('../public/wiki-skin.css', import.meta.url), 'utf8');
  assert.equal(html.includes('class="topbar nav-wrapper"'), true);
  assert.equal(html.includes('class="site-footer"'), true);
  assert.equal(html.includes('class="active-space" href="/wiki"'), true);
  assert.equal(html.includes('class="auth-shell"'), true);
  assert.equal(html.includes('class="auth-card"'), true);
  assert.equal(html.includes('class="auth-context"'), true);
  assert.equal(html.includes('계정 바로가기'), true);
  assert.equal(html.includes('href="/forgot-password"'), true);
  assert.equal(html.includes('href="/help/처음_편집하기"'), true);
  assert.equal(html.includes('/assets/wiki-skin.css?v=20260525-semantic-grid-86'), true);
  assert.equal(html.includes('class="page-intent-strip" aria-label="현재 화면 바로가기"'), true);
  assert.equal(html.includes('<span class="intent-context">위키</span>'), true);
  assert.equal(html.includes('<span class="intent-title">로그인</span>'), true);
  assert.equal(html.includes('class="intent-links"'), true);
  assert.equal(css.includes('.auth-card {\n  border: 1px solid var(--border-0);\n  border-left: 4px solid var(--brand-0);'), true);
  assert.equal(css.includes('.auth-card,\n:root[data-theme="dark"] .auth-card {\n  border: 1px solid var(--border-0);\n  border-left: 4px solid var(--brand-0);'), false);
  assert.equal(css.includes('box-shadow: none;'), true);
  assert.equal(css.includes('.auth-note,\n.auth-message {\n  border: 1px solid var(--border-1);'), true);
  assert.equal(css.includes('.account-flow-summary {\n  display: grid;'), true);
  assert.equal(css.includes('.account-flow-guide {\n  display: grid;'), true);
  assert.equal(css.includes('.auth-context {\n  border: 1px solid var(--border-0);'), true);
  assert.equal(css.includes('.auth-shell {\n    grid-template-columns: minmax(0, 1fr);'), true);
  assert.equal(css.includes('/* Semantic Grid shape normalization: flat 4px wiki surfaces, no card shadows. */'), true);
  assert.equal(css.includes('.directory-card,\n.message-panel,\n.site-footer,'), true);
  assert.equal(css.includes('.page-intent-strip {\n  display: flex;'), true);
  assert.equal(css.includes('.intent-context {\n  flex: 0 0 auto;'), true);
  assert.equal(css.includes('.intent-links {\n  display: flex;'), true);
  assert.equal(css.includes('border-radius: 4px;\n  box-shadow: none;'), true);
  assert.equal(css.includes('.article-head,\n.skin-space .article-head {\n  border-radius: 4px 4px 0 0;'), true);
  assert.equal(css.includes('.skin-article .article-toc {\n    grid-row: 2;\n  }\n\n  .skin-article .wiki-sidebar,\n  .skin-space .wiki-sidebar {\n    grid-row: 3;'), true);
  assert.equal(css.includes('.sidebar-tree-list {\n  display: grid;'), true);
  assert.equal(css.includes('.sidebar-tree-link {\n  display: grid;'), true);
  assert.equal(css.includes('.sidebar-tree-marker {\n  position: relative;'), true);
  assert.equal(css.includes('.sidebar-tree-children {\n  margin-left: 10px;'), true);
  assert.equal(css.includes('.sidebar-edit-form {\n  grid-template-columns:'), true);
  assert.equal(css.includes('.file-upload-layout {\n  display: grid;'), true);
  assert.equal(css.includes('.file-detail-summary {\n  display: grid;'), true);
  assert.equal(css.includes('.file-detail-guide {\n  display: grid;'), true);
  assert.equal(css.includes('.file-report-panel {\n  display: grid;'), true);
  assert.equal(css.includes('.page-request-panel {\n  display: grid;'), true);
  assert.equal(css.includes('.request-form-grid {\n  display: grid;'), true);
  assert.equal(css.includes('.admin-file-summary {\n  display: grid;'), true);
  assert.equal(css.includes('.file-admin-form label {\n  display: grid;'), true);
  assert.equal(css.includes('.workflow-steps {\n  display: grid;'), true);
  assert.equal(css.includes('.workflow-steps ol {\n  display: grid;'), true);
  assert.equal(css.includes('.creation-flow-summary {\n  display: grid;'), true);
  assert.equal(css.includes('.editor-guide-panel {\n  display: grid;'), true);
  assert.equal(css.includes('.admin-guide-panel {\n  display: grid;'), true);
  assert.equal(css.includes('.search-admin-grid {\n  grid-template-columns: repeat(2, minmax(0, 1fr));'), true);
  assert.equal(css.includes('.task-action-stack {\n  display: flex;'), true);
  assert.equal(css.includes('.watchlist-start-panel {\n  display: grid;'), true);
  assert.equal(css.includes('.search-summary,\n.category-summary,\n.directory-summary,\n.data-list-summary {\n  display: grid;'), true);
  assert.equal(css.includes('.search-guide-panel {\n  position: sticky;'), true);
  assert.equal(css.includes('.search-shell .search-layout {\n  grid-template-columns: minmax(0, 1fr) 280px;'), true);
  assert.equal(css.includes('.directory-layout {\n  display: grid;'), true);
  assert.equal(css.includes('.directory-guide-panel {\n  position: sticky;'), true);
  assert.equal(css.includes('.data-list-layout {\n  display: grid;'), true);
  assert.equal(css.includes('.data-list-guide-panel {\n  align-self: start;'), true);
  assert.equal(css.includes('.revision-compare-panel,\n.history-filter-row {\n  border-color: var(--border-0);'), true);
  assert.equal(css.includes('.raw-summary {\n  display: grid;'), true);
  assert.equal(css.includes('.raw-guide-panel {\n  display: grid;'), true);
  assert.equal(css.includes('.article-toc-tree {\n  display: grid;'), true);
  assert.equal(css.includes('.article-toc-children {\n  margin-left: 10px;'), true);
  assert.equal(css.includes('.article-toc-link.toc-l3,\n.article-toc-link.toc-l4,'), true);
  assert.equal(css.includes('.article-toc-link {\n  display: grid;'), true);
  assert.equal(css.includes('.article-toc-number {\n  color: var(--text-2);'), true);
  assert.equal(css.includes('.article-toc-item.has-children > .article-toc-link {\n  font-weight: 700;'), true);
  assert.equal(css.includes('.permission-badge > div {\n  border-color: var(--border-1);'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .danger-button {\n  border-color:'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .admin-file-summary > div,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .account-flow-summary span,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .file-detail-summary span,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .workflow-steps,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .creation-flow-summary span,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .raw-summary span,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .editor-guide-panel,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .admin-guide-panel,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .watchlist-start-panel,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .search-guide-panel,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .directory-guide-panel,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .data-list-summary span,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .search-group li,'), true);
  assert.equal(css.includes('--border: var(--border-1);'), true);
  assert.equal(css.includes('--surface-alt: var(--surface-2);'), true);
  assert.equal(css.includes(':root[data-theme="dark"] ::placeholder {\n  color: var(--text-2);'), true);
  assert.equal(css.includes(':root[data-theme="dark"] option,\n:root[data-theme="dark"] optgroup {\n  background: var(--surface-1);'), true);
  assert.equal(css.includes(':root[data-theme="dark"] :where(input, textarea, select, button):disabled,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .minewiki :where(h1, h2, h3, h4, h5, h6, span'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .wiki-color-dark-unsafe,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .minewiki :is('), true);
  assert.equal(css.includes('[style^="color:black" i],'), true);
  assert.equal(css.includes('[style*="; color:#777" i],'), true);
  assert.equal(css.includes('[style^="color: rgb(0, 0, 0)" i],'), true);
  assert.equal(css.includes('[style^="color:rgb(0,0,0)" i],'), true);
  assert.equal(css.includes('[style^="color:rgba(0,0,0" i],'), true);
  assert.equal(css.includes('[style^="color:#202122" i],'), true);
  assert.equal(css.includes('[style*=";color:darkred" i],'), true);
  assert.equal(css.includes('[style^="color:gray" i],'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .wiki-sidebar .recent-item,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .history-page td,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .article-toc-link,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .sidebar-tree-marker'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .article-toc-number'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .wiki-sidebar a.current {\n  color: var(--text-0);'), true);
  assert.equal(css.includes(':root[data-theme="dark"] :where(.article, .admin, .operator-shell'), true);
  assert.equal(css.includes('--liberty-width: 1200px;'), true);
  assert.equal(css.includes('.wiki-shell.skin-article,\n.wiki-shell.skin-space,\n.admin,\n.page-intent-strip,\n.site-footer {\n  width: min(var(--liberty-width), calc(100% - 40px));'), true);

  const userHtml = authPage(
    '계정',
    '로그인 상태',
    '계정 작업',
    '<p class="auth-message">이미 로그인했습니다.</p>',
    { id: 1, username: 'wiki-user', display_name: '위키러', groups: [], permissions: [] }
  );
  assert.equal(userHtml.includes('href="/me"'), true);
  assert.equal(userHtml.includes('href="/watchlist"'), true);
  assert.equal(userHtml.includes('href="/tasks"'), true);
  assert.equal(userHtml.includes('href="/forgot-password"'), false);
});

test('watchlist page uses localized wiki layout with recent sidebar', () => {
  const html = watchlistPage(
    [
      {
        id: 9,
        namespace_code: 'main',
        title: '엔더맨',
        display_title: '엔더맨',
        watch_discussion: 1,
        created_at: '2026-05-24 12:00:00'
      }
    ],
    [
      {
        change_type: 'edit',
        namespace_code: 'main',
        title: '엔더맨',
        display_title: '엔더맨',
        summary: '문단 정리',
        created_at: '2026-05-24 12:05:00'
      }
    ],
    { id: 1, username: 'wiki-user', display_name: '위키러', groups: [], permissions: [] }
  );
  assert.equal(html.includes('watchlist-grid'), true);
  assert.equal(html.includes('watchlist-recent'), true);
  assert.equal(html.includes('watchlist-start-panel'), true);
  assert.equal(html.includes('감시할 문서를 찾기'), true);
  assert.equal(html.includes('placeholder="감시할 문서 검색"'), true);
  assert.equal(html.includes('class="data-table-wrap"'), true);
  assert.equal(html.includes('/wiki/%EC%97%94%EB%8D%94%EB%A7%A8'), true);
  assert.equal(html.includes('<td data-label="공간">위키</td>'), true);
  assert.equal(html.includes('토론 포함'), true);
  assert.equal(html.includes('action="/watchlist/9"'), true);
  assert.equal(html.includes('action="/watchlist/9/remove"'), true);
  assert.equal(html.includes('토론 끄기'), true);
  assert.equal(html.includes('>해제</button>'), true);
  assert.equal(html.includes('<span class="tag">수정</span>'), true);
  assert.equal(html.includes('namespace_code'), false);
  assert.equal(html.includes('change_type'), false);
  const emptyHtml = watchlistPage([], [], { id: 1, username: 'wiki-user', display_name: '위키러', groups: [], permissions: [] });
  assert.equal(emptyHtml.includes('empty-table-cell'), true);
  assert.equal(emptyHtml.includes('감시 중인 문서 없음'), true);
  assert.equal(emptyHtml.includes('최근 바뀜에서 찾기'), true);
  assert.equal(emptyHtml.includes('전체 최근 바뀜 보기'), true);
  assert.equal(emptyHtml.includes('href="/new"'), true);
  assert.equal(emptyHtml.includes('href="/tasks"'), true);
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("app.post('/watchlist/:id'"), true);
  assert.equal(serverTs.includes("app.post('/watchlist/:id/remove'"), true);
  assert.equal(serverTs.includes("safeNextPath((request.body as any)?.next) || '/watchlist'"), true);
});

test('revision search page localizes visibility and wraps tables for mobile', () => {
  const html = revisionSearchPage(
    [
      {
        revision_no: 12,
        url: '/revision/12',
        namespace: 'main',
        title: '엔더맨',
        visibility: 'admin_only',
        actor: '관리자',
        edit_summary: '숨김 처리',
        created_at: '2026-05-24 12:10:00'
      }
    ],
    { q: '엔더맨', namespace: 'main', visibility: 'admin_only' },
    { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: [] },
    true
  );
  assert.equal(html.includes('revision-search-page'), true);
  assert.equal(html.includes('class="data-table-wrap"'), true);
  assert.equal(html.includes('관리자 전용'), true);
  assert.equal(html.includes('<option value="main" selected>위키</option>'), true);
  assert.equal(html.includes('admin_only</option>'), false);
  assert.equal(html.includes('2026.05.24. 12:10'), true);
  assert.equal(html.includes('class="topbar nav-wrapper admin-topbar"'), true);
  assert.equal(html.includes('MineWiki 관리'), true);
  assert.equal(html.includes('리비전 감사 검색'), true);
  assert.equal(html.includes('/admin/audits'), true);
  const publicHtml = revisionSearchPage([], { q: '엔더맨' }, null, false);
  assert.equal(publicHtml.includes('공개 리비전 검색'), true);
  assert.equal(publicHtml.includes('관리자 최근 바뀜'), false);
  assert.equal(publicHtml.includes('공개 검색 결과 없음'), true);
});

test('signup info page is public wiki chrome instead of admin dashboard', () => {
  const html = openBetaPage(
    {
      ready: false,
      feedback: 'sent',
      issue: 'sent',
      settings: { signup_mode: 'invite', new_user_review_required: true, server_listing_mode: 'verified_or_owner', updated_at: '2026-05-24 12:00:00' },
      fileLicenses: { license_needed: 2 }
    },
    null
  );
  assert.equal(html.includes('<h1>가입 안내</h1>'), true);
  assert.equal(html.includes('class="directory-head"'), true);
  assert.equal(html.includes('class="public-info-tabs"'), true);
  assert.equal(html.includes('class="public-info-summary"'), true);
  assert.equal(html.includes('처음 시작 순서'), true);
  assert.equal(html.includes('가입 방식과 편집 반영 정책을 먼저 확인합니다.'), true);
  assert.equal(html.includes('class="active" aria-current="page" href="/beta">가입 안내'), true);
  assert.equal(html.includes('public-log-section'), true);
  assert.equal(html.includes('class="topbar nav-wrapper"'), true);
  assert.equal(html.includes('MineWiki 관리'), false);
  assert.equal(html.includes('/admin/files'), false);
  assert.equal(html.includes('파일 라이선스 검토'), false);
  assert.equal(html.includes('점검 중'), false);
  assert.equal(html.includes('초대'), true);
  assert.equal(html.includes('2026.05.24. 12:00'), true);
  assert.equal(html.includes('class="public-log-section beta-feedback-panel"'), true);
  assert.equal(html.includes('class="beta-feedback-form" method="post" action="/beta/feedback"'), true);
  assert.equal(html.includes('name="redirectTo" value="/beta?feedback=sent"'), true);
  assert.equal(html.includes('피드백 접수'), true);
  assert.equal(html.includes('보낸 의견이 운영 검토 큐에 등록되었습니다.'), true);
  assert.equal(html.includes('action="/api/beta/feedback"'), false);
  assert.equal(html.includes('문법/렌더링'), true);
  assert.equal(html.includes('class="public-log-section beta-issue-panel"'), true);
  assert.equal(html.includes('class="beta-issue-form" method="post" action="/beta/issues"'), true);
  assert.equal(html.includes('name="redirectTo" value="/beta?issue=sent"'), true);
  assert.equal(html.includes('문제 신고 접수'), true);
  assert.equal(html.includes('공개 전 확인할 이슈로 등록되었습니다.'), true);
  assert.equal(html.includes('action="/api/beta/issues"'), false);
  assert.equal(html.includes('서버 위키'), true);
  assert.equal(html.includes('문제 신고하기'), true);
  const userHtml = openBetaPage({ ready: true, settings: { signup_mode: 'open' } }, { id: 1, username: 'wiki-user', display_name: '위키러', groups: [], permissions: [] });
  assert.equal(userHtml.includes('위키러 계정으로 접수됩니다.'), true);
  assert.equal(userHtml.includes('href="/me"'), true);
  const css = readFileSync(new URL('../public/wiki-skin.css', import.meta.url), 'utf8');
  assert.equal(css.includes('.beta-feedback-form,\n.beta-issue-form {\n  display: grid;'), true);
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("app.post('/beta/feedback'"), true);
  assert.equal(serverTs.includes("app.post('/beta/issues'"), true);
  assert.equal(serverTs.includes('async function createBetaFeedback'), true);
  assert.equal(serverTs.includes('async function createBetaIssue'), true);
  assert.equal(serverTs.includes("return createBetaFeedback(request, reply, false);"), true);
  assert.equal(serverTs.includes("return createBetaIssue(request, reply, false);"), true);
  assert.equal(serverTs.includes('issueType: normalizeBetaIssueType(body.issueType)'), true);
});

test('generic data lists use localized labels and mobile table wrapper', () => {
  const html = dataListPage(
    '운영 상태',
    [{ title: '점검', incident_type: 'maintenance', resolved_at: '2026-05-24 12:00:00', target_id: 12, entity_id: 13, revision_id: 14 }],
    null
  );
  assert.equal(html.includes('class="data-table-wrap"'), true);
  assert.equal(html.includes('class="directory-summary data-list-summary"'), true);
  assert.equal(html.includes('class="data-list-layout"'), true);
  assert.equal(html.includes('class="directory-guide-panel data-list-guide-panel"'), true);
  assert.equal(html.includes('<h2>운영 항목</h2>'), true);
  assert.equal(html.includes('읽는 방법'), true);
  assert.equal(html.includes('다음 행동'), true);
  assert.equal(html.includes('<th>유형</th>'), true);
  assert.equal(html.includes('<th>해결</th>'), true);
  assert.equal(html.includes('<th>판</th>'), true);
  assert.equal(html.includes('r14'), true);
  assert.equal(html.includes('incident_type'), false);
  assert.equal(html.includes('target_id'), false);
  assert.equal(html.includes('entity_id'), false);
  assert.equal(html.includes('<th>대상 번호</th>'), false);
  assert.equal(html.includes('<strong>점검</strong>'), true);

  const emptyStatusHtml = dataListPage('운영 상태', [], null);
  assert.equal(emptyStatusHtml.includes('공개된 운영 항목 없음'), true);
  assert.equal(emptyStatusHtml.includes('새 공지가 등록되면 이 표에 표시됩니다.'), true);
  assert.equal(emptyStatusHtml.includes('href="/status"'), true);
  assert.equal(emptyStatusHtml.includes('운영 상태'), true);
  assert.equal(emptyStatusHtml.includes('공지'), true);

  const emptyRevisionHtml = dataListPage('최근 리비전', [], null);
  assert.equal(emptyRevisionHtml.includes('표시할 리비전 없음'), true);
  assert.equal(emptyRevisionHtml.includes('최근 바뀜 보기'), true);
  assert.equal(emptyRevisionHtml.includes('공개 리비전'), true);
  assert.equal(emptyRevisionHtml.includes('리비전 검색'), true);
  assert.equal(emptyRevisionHtml.includes('표시할 항목이 없습니다'), false);
});

test('revision data lists hide raw storage keys and format wiki labels', () => {
  const html = dataListPage(
    '최근 리비전',
    [
      {
        title: 'example/서버 규칙',
        namespace: 'server',
        revision_no: 7,
        visibility: 'admin_only',
        actor: '관리자',
        edit_summary: '초기 기준 문서 작성',
        created_at: '2026-05-24 12:00:00',
        url: '/revision/12'
      },
      {
        title: '공개 데이터 1',
        namespace: 'data',
        revision_no: 3,
        visibility: 'public',
        actor: 'MineWiki',
        edit_summary: '데이터 보강',
        created_at: '2026-05-24 13:00:00',
        url: '/revision/13'
      }
    ],
    null
  );
  assert.equal(html.includes('<th>공간</th>'), true);
  assert.equal(html.includes('<th>판</th>'), true);
  assert.equal(html.includes('<th>공개 범위</th>'), true);
  assert.equal(html.includes('권한 범위 안에서 볼 수 있는 판 기록입니다.'), true);
  assert.equal(html.includes('공개 문서의 공개 판만 표시합니다.'), true);
  assert.equal(html.includes('<h2>공개 리비전</h2>'), true);
  assert.equal(html.includes('서버'), true);
  assert.equal(html.includes('데이터'), true);
  assert.equal(html.includes('r7'), true);
  assert.equal(html.includes('관리자 전용'), true);
  assert.equal(html.includes('문서 작성'), true);
  assert.equal(html.includes('href="/revision/12"'), true);
  assert.equal(html.includes('revision_id'), false);
  assert.equal(html.includes('revision_no'), false);
  assert.equal(html.includes('admin_only'), false);
  assert.equal(html.includes('초기 기준 문서 작성'), false);
  const adminHtml = dataListPage('숨겨진 리비전', [{ title: '비공개', namespace: 'main', revision_no: 2, visibility: 'hidden' }], null, {
    currentSpace: 'admin',
    summary: '숨김 처리된 리비전과 처리 사유를 점검합니다.'
  });
  assert.equal(adminHtml.includes('class="topbar nav-wrapper admin-topbar"'), true);
  assert.equal(adminHtml.includes('숨김 처리된 리비전과 처리 사유를 점검합니다.'), true);
  assert.equal(adminHtml.includes('감사 대상 리비전'), true);
  assert.equal(adminHtml.includes('관리자 최근 바뀜'), true);
});

test('public operational pages use wiki cards instead of raw key tables', () => {
  const announcements = announcementsPage(
    [{ title: '점검 안내', body: '검색 점검', type: 'maintenance', visibility: 'public', starts_at: '2026-05-24 12:00:00', ends_at: null }],
    null
  );
  assert.equal(announcements.includes('public-log-page'), true);
  assert.equal(announcements.includes('public-info-page'), true);
  assert.equal(announcements.includes('class="public-info-summary"'), true);
  assert.equal(announcements.includes('공지 읽는 순서'), true);
  assert.equal(announcements.includes('class="active" aria-current="page" href="/announcements">공지'), true);
  assert.equal(announcements.includes('href="/release-notes"'), true);
  assert.equal(announcements.includes('href="/status"'), true);
  assert.equal(announcements.includes('href="/beta"'), true);
  assert.equal(announcements.includes('점검 안내'), true);
  assert.equal(announcements.includes('starts_at'), false);
  assert.equal(announcements.includes('전체 공개'), true);
  assert.equal(announcements.includes('class="active-space" href="/wiki"'), true);

  const releases = releaseNotesPage([{ version: '0.4.0', title: '토론 추가', body: '문서 토론 화면 추가', release_type: 'minor', published_at: '2026-05-24 12:00:00' }], null);
  assert.equal(releases.includes('0.4.0 · 토론 추가'), true);
  assert.equal(releases.includes('릴리즈 확인 순서'), true);
  assert.equal(releases.includes('가장 최근 버전의 공개 시각입니다.'), true);
  assert.equal(releases.includes('class="active" aria-current="page" href="/release-notes">릴리즈'), true);
  assert.equal(releases.includes('release_type'), false);
  assert.equal(releases.includes('일반 변경'), true);
  assert.equal(releases.includes('class="active-space" href="/wiki"'), true);

  const status = serviceStatusPage(
    {
      incidents: [{ title: '검색 지연', incident_type: 'degradation', severity: 'medium', status: 'open', started_at: '2026-05-24 12:00:00', resolved_at: null, summary: '일부 검색이 느립니다.' }]
    },
    null
  );
  assert.equal(status.includes('점검 및 장애'), true);
  assert.equal(status.includes('상태 확인 순서'), true);
  assert.equal(status.includes('아직 해결되지 않은 공개 점검 또는 장애입니다.'), true);
  assert.equal(status.includes('class="active" aria-current="page" href="/status">운영 상태'), true);
  assert.equal(status.includes('공개 베타 주간 지표'), false);
  assert.equal(status.includes('incident_type'), false);
  assert.equal(status.includes('1,200'), false);
  assert.equal(status.includes('class="active-space" href="/wiki"'), true);
});

test('quality pages share localized mobile data list rendering', () => {
  const html = qualityPage(
    '검증 필요 문서',
    [{ id: 123, target_page_id: 456, target_title: '엔더맨', namespace_code: 'main', issue_type: 'missing_status', created_at: '2026-05-24 12:00:00' }],
    null
  );
  assert.equal(html.includes('class="data-table-wrap"'), true);
  assert.equal(html.includes('<th>번호</th>'), false);
  assert.equal(html.includes('<th>대상 문서</th>'), true);
  assert.equal(html.includes('<th>점검 항목</th>'), true);
  assert.equal(html.includes('target_page_id'), false);
  assert.equal(html.includes('issue_type'), false);
  assert.equal(html.includes('missing_status'), false);
  assert.equal(html.includes('문서 상태 없음'), true);
  assert.equal(html.includes('<td data-label="분류">위키</td>'), true);
  assert.equal(html.includes('<strong><a href="/wiki/%EC%97%94%EB%8D%94%EB%A7%A8">엔더맨</a></strong>'), true);
  assert.equal(html.includes('<time>2026.05.24. 12:00</time>'), true);
  assert.equal(html.includes('정비 기준'), true);
  assert.equal(html.includes('권장 작업'), true);
  assert.equal(html.includes('/special/broken-links'), true);
  assert.equal(html.includes('문서 고치기'), true);

  const neededHtml = qualityPage(
    '필요한 문서',
    [{ namespace_code: 'mod', target_title: 'Create/회전력', link_count: 4 }],
    null,
    'needed-pages'
  );
  assert.equal(neededHtml.includes('class="active" aria-current="page" href="/special/needed-pages"'), true);
  assert.equal(neededHtml.includes('문서 만들기'), true);
  assert.equal(neededHtml.includes('/mod/Create/%ED%9A%8C%EC%A0%84%EB%A0%A5/edit'), true);
  assert.equal(neededHtml.includes('필요 문서별 링크 수입니다.'), true);

  const requestHtml = qualityPage(
    '문서 작성 요청',
    [{ namespace_code: 'dev', requested_title: 'NBT/엔티티', reason: '플러그인 개발에 필요', status: 'open', created_at: '2026-05-24 12:00:00' }],
    null,
    'page-requests'
  );
  assert.equal(requestHtml.includes('class="active" aria-current="page" href="/special/page-requests"'), true);
  assert.equal(requestHtml.includes('새 작성 요청'), true);
  assert.equal(requestHtml.includes('action="/page-requests"'), true);
  assert.equal(requestHtml.includes('name="redirectTo" value="/special/page-requests"'), true);
  assert.equal(requestHtml.includes('name="namespace"'), true);
  assert.equal(requestHtml.includes('<option value="dev">개발</option>'), true);
  assert.equal(requestHtml.includes('name="title"'), true);
  assert.equal(requestHtml.includes('name="reason"'), true);
  assert.equal(requestHtml.includes('작성 요청 등록'), true);
  assert.equal(requestHtml.includes('/new">직접 문서 만들기'), true);
  assert.equal(requestHtml.includes('/dev/NBT/%EC%97%94%ED%8B%B0%ED%8B%B0/edit'), true);
});

test('server hub links use canonical server wiki routes', () => {
  const html = serverHubPage(
    [{
      card_type: 'server_wiki',
      title: '예시서버',
      wiki_slug: 'example',
      host: 'play.example.kr',
      edition: 'java',
      genres: '반야생',
      verified_status: 'verified',
      wiki_status: 'active',
      operational_status: 'active',
      doc_count: 3
    }],
    {},
    null
  );
  assert.equal(html.includes('/server/example'), true);
  assert.equal(html.includes('/wiki/서버/'), false);
  assert.equal(html.includes('Java Edition'), true);
  assert.equal(html.includes('운영자 인증'), true);
  assert.equal(html.includes('>java<'), false);
  assert.equal(html.includes('>verified<'), false);
});

test('ACL page renders summary, rules, logs, and admin form', () => {
  const page = {
    namespace_code: 'main',
    title: '테스트',
    display_title: '테스트',
    protection_level: 'open',
    aclSummary: { read: '누구나', edit: '누구나', move: '자동 인증 사용자', delete: '관리자', acl: '관리자' },
    aclRules: [
      { id: 7, action: 'edit', effect: 'allow', subject_type: 'perm', subject_value: 'any', reason: '기본' },
      { id: 8, action: 'read', effect: 'deny', subject_type: 'user', subject_value: '42', reason: '차단' }
    ],
    aclLogs: [{ created_at: '2026-05-24 16:21:00', actor_name: '관리자', action_type: 'insert', reason: '반달 대응' }],
    canChangeAcl: true
  };
  const html = permissionInfoPage(
    page,
    [],
    { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] }
  );
  assert.equal(html.includes('문서의 ACL'), true);
  assert.equal(html.includes('ACL 요약'), true);
  assert.equal(html.includes('class="directory-summary acl-summary-strip"'), true);
  assert.equal(html.includes('상세 규칙'), true);
  assert.equal(html.includes('상세 ACL'), true);
  assert.equal(html.includes('ACL 변경 로그'), false);
  assert.equal(html.includes('name="subjectValue"'), true);
  assert.equal(html.includes('name="template"'), true);
  assert.equal(html.includes('name="deleteRuleId" value="7"'), true);
  assert.equal(html.includes('사용자 ID'), false);
  assert.equal(html.includes('ACLGroup'), false);
  assert.equal(html.includes('server_owner'), false);
  assert.equal(html.includes('사용자 번호'), false);
  assert.equal(html.includes('사용자명 또는 번호'), true);
  assert.equal(html.includes('placeholder="예: member, admin, 위키러"'), true);
  assert.equal(html.includes('사용자 #42'), true);
  assert.equal(html.includes('ACL 그룹'), true);
  assert.equal(html.includes('class="active" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/acl">ACL'), true);
  assert.equal(html.includes('href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion">토론'), true);
  assert.equal(html.includes('/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/acl/history'), true);

  const historyHtml = aclHistoryPage(
    {
      ...page,
      aclLogs: [{ created_at: '2026-05-24 12:00:00', actor_name: '관리자', action_type: 'insert', reason: '반달 대응' }]
    },
    [{ created_at: '2026-05-24 11:00:00', actor_name: '관리자', old_level: 'open', new_level: 'trusted_only', reason: '반달' }],
    { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] }
  );
  assert.equal(historyHtml.includes('ACL 변경 역사'), true);
  assert.equal(historyHtml.includes('ACL 변경 로그'), true);
  assert.equal(historyHtml.includes('규칙 추가'), true);
  assert.equal(historyHtml.includes('name="subjectValue"'), false);
  assert.equal(historyHtml.includes('name="template"'), false);
  const emptyHistoryHtml = aclHistoryPage({ ...page, aclLogs: [] }, [], null);
  assert.equal(emptyHistoryHtml.includes('ACL 변경 로그 없음'), true);
  assert.equal(emptyHistoryHtml.includes('보호 변경 기록 없음'), true);

  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes('async function normalizeAclUserSubjectValue'), true);
  assert.equal(serverTs.includes('await normalizeAclUserSubjectValue(body.subjectValue)'), true);
  assert.equal(serverTs.includes('await userByIdentifier(subject)'), true);
});

test('parses redirect syntax', () => {
  const parsed = parseMarkup('#넘겨주기 [[엔더맨]]');
  assert.equal(parsed.redirectTarget, '엔더맨');
  assert.equal(parsed.ast[0]?.type, 'redirect');
});

test('encodes wiki urls with localized namespace prefixes', () => {
  assert.equal(wikiUrl('guide', '검증 가이드'), '/wiki/%EA%B0%80%EC%9D%B4%EB%93%9C/%EA%B2%80%EC%A6%9D_%EA%B0%80%EC%9D%B4%EB%93%9C');
});

test('edit forms carry base revision and conflict page resets it to current revision', () => {
  const editHtml = editPage('main', '테스트', 'old content', null, [], 'article', 42);
  assert.equal(editHtml.includes('name="baseRevisionId" value="42"'), true);
  assert.equal(editHtml.includes('data-editor-tab="preview"'), true);
  assert.equal(editHtml.includes('편집 요약'), true);
  assert.equal(editHtml.includes('저장 전 확인'), true);
  assert.equal(editHtml.includes('id="checker"'), false);
  assert.equal(editHtml.includes('id="inspection"'), false);
  assert.equal(editHtml.includes('syntax-help'), false);
  assert.equal(editHtml.includes('/assets/editor.js?v=20260525-scoped-tools'), true);

  const conflictHtml = editConflictPage('main', '테스트', 'current content', 'submitted content', null, 'article', 43, '요약');
  assert.equal(conflictHtml.includes('편집 충돌'), true);
  assert.equal(conflictHtml.includes('name="baseRevisionId" value="43"'), true);
  assert.equal(conflictHtml.includes('편집 충돌 요약'), true);
  assert.equal(conflictHtml.includes('병합 저장'), true);
  assert.equal(conflictHtml.includes('current content'), true);
  assert.equal(conflictHtml.includes('submitted content'), true);
  assert.equal(conflictHtml.includes('class="active" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/edit">편집'), true);
});

test('recent changes page shows actor and signed size delta', () => {
  const rows = [
    {
      namespace_code: 'main',
      title: '테스트',
      actor_id: 1,
      actor_name: '관리자',
      size_delta: 13,
      revision_id: 12,
      revision_no: 2,
      visibility: 'public',
      change_type: 'edit',
      edit_summary: '내용 추가',
      created_at: '2026-05-23 16:04:31'
    },
    {
      namespace_code: 'server',
      title: 'example/규칙',
      actor_name: '운영자',
      size_delta: -50,
      revision_id: 13,
      revision_no: 3,
      visibility: 'public',
      change_type: 'delete',
      edit_summary: '정리',
      created_at: '2026-05-23 16:05:31'
    }
  ];
  const html = recentChangesPage(
    rows,
    { namespace: 'server', prefix: 'example' },
    { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['revision.hide'] } as any,
    { admin: true }
  );
  const publicHtml = recentChangesPage(
    rows,
    { namespace: 'server', prefix: 'example' },
    null
  );
  assert.equal(html.includes('관리자'), true);
  assert.equal(html.includes('recent-layout'), true);
  assert.equal(html.includes('recent-sidebar'), true);
  assert.equal(html.includes('class="change-list recent-card-list"'), true);
  assert.equal(html.includes('class="recent-table-view"'), true);
  assert.equal(html.includes('aria-label="최근 바뀜 도구"'), true);
  assert.equal(html.includes('aria-label="모바일 최근 변경 카드"'), true);
  assert.equal(html.includes('aria-label="최근 변경 표"'), true);
  assert.equal(html.includes('+13'), true);
  assert.equal(html.includes('-50'), true);
  assert.equal(html.includes('2026.05.23. 16:04'), true);
  assert.equal(html.includes('2026.05.23. 16:04:31'), false);
  assert.equal(html.includes('운영 기록 포함'), true);
  assert.equal(html.includes('관리 작업 포함'), false);
  assert.equal(html.includes('사용자 ID'), false);
  assert.equal(html.includes('placeholder="사용자명 또는 번호"'), true);
  assert.equal(html.includes('name="actor"'), true);
  assert.equal(html.includes('/admin/revisions/12/hide'), true);
  assert.equal(html.includes('최근 바뀜 관리자 숨김'), true);
  assert.equal(html.includes('>숨김</button>'), true);
  assert.equal(publicHtml.includes('운영 기록 포함'), false);
  assert.equal(publicHtml.includes('운영 기록 숨김'), false);
  assert.equal(publicHtml.includes('placeholder="사용자명 또는 번호"'), false);
  assert.equal(publicHtml.includes('name="includeDeleted"'), false);
  assert.equal(publicHtml.includes('name="includeSystem"'), false);
  assert.equal(html.includes('name="prefix" value="example"'), true);
  assert.equal(html.includes('선택한 위키의 공개 변경만 표시 중'), true);
  assert.equal(html.includes('>규칙</a>'), true);
  assert.equal(html.includes('>example/규칙</a>'), false);
  assert.equal(html.includes('/server/example%2F%EA%B7%9C%EC%B9%99/history') || html.includes('/server/example/%EA%B7%9C%EC%B9%99/history'), true);
  assert.equal(html.includes('class="topbar nav-wrapper admin-topbar"'), true);
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("app.post('/admin/revisions/:id/hide'"), true);
  assert.equal(serverTs.includes('async function recentActorIdFromQuery'), true);
  assert.equal(serverTs.includes('query.actor ?? query.actorId'), true);
  assert.equal(serverTs.includes('await userByIdentifier(actor)'), true);
});

test('directory pages hide internal quality language from public screens', () => {
  const mods = modIndexPage(
    [{ title: 'Create', wiki_slug: 'Create', loaders: 'Forge · Fabric', supported_versions: '1.21.x', category: '기술', doc_count: 13, last_checked: null, wiki_status: 'needs_check' }],
    {},
    null
  );
  assert.equal(mods.includes('모드별 위키를 찾거나 새로 만들 수 있습니다.'), true);
  assert.equal(mods.includes('class="directory-summary"'), true);
  assert.equal(mods.includes('class="directory-layout"'), true);
  assert.equal(mods.includes('class="directory-guide-panel"'), true);
  assert.equal(mods.includes('필터 기준'), true);
  assert.equal(mods.includes('오래된 모드 문서'), true);
  assert.equal(mods.includes('확인 대기'), true);
  assert.equal(mods.includes('검증 필요'), false);

  const servers = serverHubPage(
    [{ card_type: 'server_wiki', title: '예시서버', wiki_slug: 'example', host: 'play.example.kr', edition: 'java', supported_versions: '1.20.1 ~ 1.21.x', genres: '반야생 · 경제', verified_status: 'verified', wiki_status: 'active', doc_count: 5 }],
    {},
    null
  );
  assert.equal(servers.includes('예시서버 위키'), true);
  assert.equal(servers.includes('class="directory-summary"'), true);
  assert.equal(servers.includes('class="directory-layout"'), true);
  assert.equal(servers.includes('class="directory-guide-panel"'), true);
  assert.equal(servers.includes('서버 위키 신청'), true);
  assert.equal(servers.includes('서버 위키 도움말'), true);
  assert.equal(servers.includes('운영자 인증'), true);
  assert.equal(servers.includes('운영자 미등록'), false);

  const dev = developHubPage({ Protocol: [{ title: 'Protocol/VarInt' }], 'Plugin API': [], 'Mod API': [], Data: [], Tools: [] }, null);
  assert.equal(dev.includes('개발자용 위키'), true);
  assert.equal(dev.includes('<h2>Plugin API</h2>'), false);
  assert.equal(dev.includes('문서 길이 짧음'), false);
  assert.equal(dev.includes('정보 컴포넌트 없음'), false);
  const emptyDev = developHubPage({ Protocol: [], 'Plugin API': [], 'Mod API': [], Data: [], Tools: [] }, null);
  assert.equal(emptyDev.includes('개발 문서가 없습니다'), true);

  const newDoc = newDocumentPage(null);
  assert.equal(newDoc.includes('어디에 문서를 만들까요?'), true);
  assert.equal(newDoc.includes('class="creation-flow-summary"'), true);
  assert.equal(newDoc.includes('<strong>4가지</strong>작성 공간'), true);
  assert.equal(newDoc.includes('작성 흐름'), true);
  assert.equal(newDoc.includes('위치 선택'), true);
  assert.equal(newDoc.includes('/new/mod-page'), true);
  assert.equal(newDoc.includes('/mods/new'), true);
  assert.equal(newDoc.includes('새 모드 위키 만들기'), true);
  assert.equal(newDoc.includes('새 서버 위키 만들기'), true);
  assert.equal(newDoc.includes('MineWiki 관리'), false);
  assert.equal(newDoc.includes('admin-topbar'), false);
  assert.equal(newDoc.includes('href="/admin/files"'), false);
  assert.equal(newDoc.includes('href="/recent"'), true);
  assert.equal(newDoc.includes('class="active-space" href="/wiki"'), true);
  const savedTemplateNewDoc = newDocumentPage(null, { templateSaved: '1' });
  assert.equal(savedTemplateNewDoc.includes('양식 저장 완료'), true);
  const modPage = newDocumentFormPage('mod-page', null, { wikiSlug: 'Create', title: '회전력' }, [{ title: 'Create', wiki_slug: 'Create' }]);
  assert.equal(modPage.includes('/mod/Create/회전력'), true);
  assert.equal(modPage.includes('<strong>Create 위키</strong>저장 위치'), true);
  assert.equal(modPage.includes('<strong>로그인 필요</strong>저장 계정'), true);
  assert.equal(modPage.includes('문서 만들기 순서'), true);
  assert.equal(modPage.includes('MineWiki 관리'), false);
  assert.equal(modPage.includes('admin-topbar'), false);
  assert.equal(modPage.includes('href="/admin/files"'), false);
  assert.equal(modPage.includes('class="active-space" href="/mods"'), true);
  assert.equal(modPage.includes('새 문서 양식 만들기'), false);
  assert.equal(modPage.includes('로그인하면 개인 문서 양식을 만들 수 있습니다.'), true);
  const loggedInModPage = newDocumentFormPage(
    'mod-page',
    { id: 1, username: 'editor', display_name: '편집자', groups: ['member'], permissions: [] } as any,
    { wikiSlug: 'Create', title: '회전력' },
    [{ title: 'Create', wiki_slug: 'Create' }]
  );
  assert.equal(loggedInModPage.includes('/mod/Create/templates/new'), true);
  const subwikiPage = newSubwikiDocumentPage('server', '예시서버', null, { title: '규칙' });
  assert.equal(subwikiPage.includes('/server/예시서버/규칙'), true);
  assert.equal(subwikiPage.includes('<strong>예시서버 위키</strong>대상 위키'), true);
  assert.equal(subwikiPage.includes('이 위키에 문서 추가'), true);
  assert.equal(subwikiPage.includes('새 양식 만들기'), false);
  const missingSubwikiPage = newSubwikiDocumentPage('mod', '없는모드', null, {}, [], false);
  assert.equal(missingSubwikiPage.includes('없는모드 위키를 찾을 수 없습니다'), true);
  assert.equal(missingSubwikiPage.includes('모드 위키 만들기'), true);
  const modWiki = newModWikiPage(null, { slug: 'create' });
  assert.equal(modWiki.includes('/mod/create'), true);
  assert.equal(modWiki.includes('로그인 후 만들기'), true);
  assert.equal(modWiki.includes('모드 위키 생성 순서'), true);
  assert.equal(modWiki.includes('id="creation-login-gate"'), true);
  assert.equal(modWiki.includes('aria-describedby="creation-login-gate"'), true);
  assert.equal(modWiki.includes('title="로그인 후 사용할 수 있습니다."'), true);
  const serverRequest = serverWikiRequestPage(null, false, { slug: 'example' }, [{ set_key: 'server-basic', title: '기본 세트', description: '접속과 규칙을 준비합니다.' }]);
  assert.equal(serverRequest.includes('<title>서버 위키 신청 - MineWiki 서버</title>'), true);
  assert.equal(serverRequest.includes('서버 위키 신청 순서'), true);
  assert.equal(serverRequest.includes('로그인 후 신청'), true);
  assert.equal(serverRequest.includes('aria-describedby="creation-login-gate"'), true);
  assert.equal(serverRequest.includes('title="로그인 후 사용할 수 있습니다."'), true);
  assert.equal(serverRequest.includes('기본 세트'), true);
  const submittedServer = serverWikiRequestSubmittedPage(42, null);
  assert.equal(submittedServer.includes('신청 번호'), true);
  assert.equal(submittedServer.includes('#42'), true);
  assert.equal(submittedServer.includes('class="creation-flow-summary server-request-result-summary"'), true);
  assert.equal(submittedServer.includes('<strong>검토 대기</strong>현재 상태'), true);
  assert.equal(submittedServer.includes('승인 전에는 서버 허브에 바로 공개되지 않습니다.'), true);
  assert.equal(submittedServer.includes('href="/servers/new"'), true);
  assert.equal(submittedServer.includes('관리자 업무 큐'), false);
  assert.equal(submittedServer.includes('다음 진행'), true);
  const submittedAdminServer = serverWikiRequestSubmittedPage(43, { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] });
  assert.equal(submittedAdminServer.includes('href="/admin/work"'), true);
  assert.equal(submittedAdminServer.includes('관리자 업무 큐'), true);

  const templatePage = documentTemplateFormPage(
    { id: 1, username: 'editor', display_name: '편집자', groups: ['member'], permissions: [] } as any,
    { kind: 'global' }
  );
  assert.equal(templatePage.includes('<title>새 문서 양식 만들기 - MineWiki 틀</title>'), true);
  assert.equal(templatePage.includes('<strong>전역 양식</strong>적용 범위'), true);
  assert.equal(templatePage.includes('<strong>편집자</strong>작성 계정'), true);
  assert.equal(templatePage.includes('양식 작성 순서'), true);
  assert.equal(templatePage.includes('class="active-space" href="/wiki"'), true);
  assert.equal(templatePage.includes('admin-topbar'), false);

  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("app.get('/templates/new'"), true);
  assert.equal(serverTs.includes("return reply.redirect('/new?templateSaved=1');"), true);
  assert.equal(serverTs.includes("newSubwikiDocumentPage('mod', slug, (request as any).user, request.query as any, templates, Boolean(space))"), true);
  assert.equal(serverTs.includes("if (!user) return reply.code(403).type('text/html').send(messagePage('로그인 필요'"), true);
});

test('revision history and diff pages render user-facing controls', () => {
  const page = {
    id: 7,
    namespace_code: 'main',
    title: '테스트',
    display_title: '테스트',
    aclLogs: [{ created_at: '2026-05-23 16:00:00', actor_name: '관리자', reason: '보호', new_rule_json: '{"subject_type":"perm"}' }]
  };
  const historyHtml = revisionHistoryPage(
    page,
    [
      { id: 12, revision_no: 2, actor_name: '관리자', created_at: '2026.05.23. 16:04', edit_summary: '수정' },
      { id: 11, revision_no: 1, actor_name: '관리자', created_at: '2026.05.22. 16:04:31', edit_summary: '생성' }
    ],
    null
  );
  assert.equal(historyHtml.includes('테스트 문서의 판 기록'), true);
  assert.equal(historyHtml.includes('class="directory-summary history-summary"'), true);
  assert.equal(historyHtml.includes('선택한 두 판 비교'), true);
  assert.equal(historyHtml.includes('현재 판 보기'), false);
  assert.equal(historyHtml.includes('class="active" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/history">역사'), true);
  assert.equal(historyHtml.includes('href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion">토론'), true);
  assert.equal(historyHtml.indexOf('>문서</a>') < historyHtml.indexOf('>토론</a>'), true);
  assert.equal(historyHtml.indexOf('>토론</a>') < historyHtml.indexOf('>편집</a>'), true);
  assert.equal(historyHtml.indexOf('>편집</a>') < historyHtml.indexOf('>역사</a>'), true);
  assert.equal(historyHtml.includes('문서로 돌아가기'), false);
  assert.equal(historyHtml.includes('요약 없음'), false);
  assert.equal(historyHtml.includes('권한 변경 기록'), true);
  assert.equal(historyHtml.includes('new_rule_json'), false);
  assert.equal(historyHtml.includes('subject_type'), false);
  assert.equal(historyHtml.includes('{"'), false);
  assert.equal(historyHtml.includes('aria-current="page" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/history">전체</a>'), true);
  assert.equal(historyHtml.includes('/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/diff?from=11&amp;to=12'), false);
  assert.equal(historyHtml.includes('/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/diff?from=11&to=12'), true);
  const loggedInHistoryHtml = revisionHistoryPage(
    page,
    [{ id: 12, revision_no: 2, actor_name: '관리자', created_at: '2026.05.23. 16:04', edit_summary: '수정' }],
    { id: 1, username: 'editor', display_name: '편집자', groups: [], permissions: [] }
  );
  assert.equal((loggedInHistoryHtml.match(/oldid=12/g) ?? []).length, 1);
  assert.equal(loggedInHistoryHtml.includes('oldid=12">되돌리기</a>'), false);
  const rollbackHistoryHtml = revisionHistoryPage(page, [{ id: 13, revision_no: 3, actor_name: '관리자', created_at: '2026.05.24. 16:04', edit_summary: '되돌리기' }], null, { filterTag: 'rollback' });
  assert.equal(rollbackHistoryHtml.includes('aria-current="page" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/history?tag=rollback">되돌리기</a>'), true);

  const diffHtml = revisionDiffPage(page, { fromRevisionId: 11, toRevisionId: 12, fromRevisionNo: 1, toRevisionNo: 2, changes: [{ line: 3, before: 'old', after: 'new' }] }, null);
  assert.equal(diffHtml.includes('문서 비교'), true);
  assert.equal(diffHtml.includes('한 줄 보기'), true);
  assert.equal(diffHtml.includes('변경 줄'), true);
  assert.equal(diffHtml.includes('1개'), true);
  assert.equal(diffHtml.includes('현재 문서'), true);
  assert.equal(diffHtml.includes('판 기록'), true);
  assert.equal(diffHtml.includes('현재 판 보기'), false);
  assert.equal(diffHtml.includes('class="active" href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/history">역사'), true);
  assert.equal(diffHtml.includes('href="/wiki/%ED%85%8C%EC%8A%A4%ED%8A%B8/discussion">토론'), true);
  assert.equal(diffHtml.includes('<pre>old</pre>'), true);
  assert.equal(diffHtml.includes('<pre>new</pre>'), true);
});

test('category page renders category members with wiki links', () => {
  const html = categoryPage('중립적 몹', [{ namespace_code: 'main', namespace_name: '문서', title: '엔더맨', display_title: '엔더맨', excerpt: '중립적 몹 문서' }], null);
  assert.equal(html.includes('중립적 몹 분류'), true);
  assert.equal(html.includes('/wiki/%EC%97%94%EB%8D%94%EB%A7%A8'), true);
  assert.equal(html.includes('중립적 몹 문서'), true);
  assert.equal(html.includes('class="active-space" href="/wiki"'), true);
  assert.equal(html.includes('<span class="tag">문서</span>'), false);
  assert.equal(html.includes('class="category-summary"'), true);
  assert.equal(html.includes('class="category-actions"'), true);
  assert.equal(html.includes('category-member-card'), true);
  assert.equal(html.includes('문서 보기'), true);
  assert.equal(html.includes('분류 사용 방법'), true);
  assert.equal(html.includes('빠진 문서는 새로 만들거나 기존 문서 하단에 분류를 추가하세요.'), true);
});

test('category page keeps namespace tags user-facing', () => {
  const html = categoryPage(
    '개발 도구',
    [{ namespace_code: 'dev', title: '플러그인/API', display_title: '플러그인 API', excerpt: '개발 문서' }],
    null
  );
  assert.equal(html.includes('/dev/%ED%94%8C%EB%9F%AC%EA%B7%B8%EC%9D%B8/API'), true);
  assert.equal(html.includes('<span class="tag">개발</span>'), true);
  assert.equal(html.includes('<span class="tag">dev</span>'), false);
});

test('empty category page explains next actions', () => {
  const html = categoryPage('레드스톤 장치', [], null);
  assert.equal(html.includes('레드스톤 장치 분류에 문서가 없습니다'), true);
  assert.equal(html.includes('/new/wiki?title=%EB%A0%88%EB%93%9C%EC%8A%A4%ED%86%A4%20%EC%9E%A5%EC%B9%98'), true);
  assert.equal(html.includes('/special/needed-pages'), true);
  assert.equal(html.includes('<p class="empty-state">'), false);
});

test('layout emits MineWiki SEO and icon metadata', () => {
  const layoutTs = readFileSync(new URL('../src/ui/layout.ts', import.meta.url), 'utf8');
  const navigationTs = readFileSync(new URL('../src/ui/navigation.ts', import.meta.url), 'utf8');
  assert.equal(layoutTs.includes("from './navigation.js'"), true);
  assert.equal(layoutTs.includes("export { canAccessAdminTools } from './navigation.js';"), true);
  assert.equal(layoutTs.includes('function pageIntentLinks'), false);
  assert.equal(navigationTs.includes('export function pageIntentLinks'), true);
  assert.equal(navigationTs.includes('export function userRoleChrome'), true);
  assert.equal(navigationTs.includes('export function navActiveSpace'), true);
  const html = layout('테스트', '<main></main>', null, 'main', {
    canonicalPath: '/wiki/테스트',
    description: 'MineWiki 테스트 설명'
  });
  assert.equal(html.includes('<meta name="application-name" content="MineWiki">'), true);
  assert.equal(html.includes('<meta property="og:site_name" content="MineWiki">'), true);
  assert.equal(html.includes('/assets/og-image.svg'), true);
  assert.equal(html.includes('<meta name="twitter:card" content="summary_large_image">'), true);
  assert.equal(html.includes('<link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">'), true);
  assert.equal(html.includes('<link rel="manifest" href="/assets/site.webmanifest">'), true);
  assert.equal(html.includes('<body class="minewiki is-anonymous">'), true);
  assert.equal(html.includes('/assets/theme.js'), true);
  assert.equal(html.includes('/assets/wiki-skin.css?v=20260525-semantic-grid-86'), true);
  assert.equal(html.includes('class="page-intent-strip" aria-label="현재 화면 바로가기"'), true);
  assert.equal(html.includes('data-theme-toggle'), true);
  assert.equal(html.includes('desktop-nav'), true);
  assert.equal(html.includes('top-search desktop-search'), true);
  assert.equal(html.includes('class="mobile-search"'), true);
  assert.equal(html.includes('mobile-menu'), true);
  assert.equal(html.includes('pagead2.googlesyndication.com/pagead/js/adsbygoogle.js'), false);
  const adminHtml = layout('관리 테스트', '<main></main>', null, 'admin');
  assert.equal((adminHtml.match(/>검토 큐</g) ?? []).length, 3);
  assert.equal(adminHtml.includes('MineWiki 관리'), true);
  assert.equal(adminHtml.includes('class="page-intent-strip admin-intent-strip" aria-label="현재 화면 바로가기"'), true);
  assert.equal(adminHtml.includes('<span class="intent-context">관리</span>'), true);
  assert.equal(adminHtml.includes('class="top-search desktop-search"'), false);
  assert.equal(adminHtml.includes('class="mobile-search"'), false);
  assert.equal((adminHtml.match(/mobile-menu-section/g) ?? []).length, 6);
  assert.equal((adminHtml.match(/>관리</g) ?? []).length, 3);
  assert.equal((adminHtml.match(/>사이트</g) ?? []).length, 2);
  assert.equal(adminHtml.includes('문서 상태'), false);
  const userHtml = layout('로그인 테스트', '<main></main>', { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] }, 'main');
  assert.equal(userHtml.includes('<body class="minewiki is-authenticated role-admin">'), true);
  assert.equal(userHtml.includes('<span class="user-role">관리자</span> <a href="/me">관리자</a>'), true);
  assert.equal(userHtml.includes('<span class="intent-title">로그인 테스트</span>'), true);
  assert.equal(userHtml.includes('>감시문서</a>'), true);
  assert.equal(userHtml.includes('<summary>관리</summary>'), true);
  assert.equal(userHtml.includes('<a class="admin-entry" href="/admin">관리 홈</a>'), true);
  const modHtml = layout('모드 테스트', '<main></main>', null, 'mod');
  assert.equal(modHtml.includes('<span class="intent-context">모드</span>'), true);
  assert.equal(modHtml.includes('href="/mods/new">모드 위키 만들기</a>'), true);
  assert.equal(modHtml.includes('href="/new/mod-page">모드 문서 추가</a>'), true);
  assert.equal(modHtml.includes('href="/search?space=mod">모드 검색</a>'), true);
  const serverHtml = layout('서버 테스트', '<main></main>', null, 'server');
  assert.equal(serverHtml.includes('<span class="intent-context">서버</span>'), true);
  assert.equal(serverHtml.includes('href="/servers/new">서버 위키 신청</a>'), true);
  assert.equal(serverHtml.includes('href="/login?next=%2Fmy%2Fservers">내 서버</a>'), true);
  const devHtml = layout('개발 테스트', '<main></main>', null, 'dev');
  assert.equal(devHtml.includes('href="/new/dev">개발 문서 만들기</a>'), true);
  assert.equal(devHtml.includes('href="/search?space=dev">개발 문서 검색</a>'), true);
  const fileAdminHtml = layout('파일 테스트', '<main></main>', { id: 4, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] }, 'file');
  assert.equal(fileAdminHtml.includes('href="/admin/files">파일 관리</a>'), true);
  const developerHtml = layout('개발자 테스트', '<main></main>', { id: 3, username: 'dev', display_name: '개발자', groups: ['developer'], permissions: [] }, 'main');
  assert.equal(developerHtml.includes('<body class="minewiki is-authenticated role-developer">'), true);
  assert.equal(developerHtml.includes('<summary>관리</summary>'), true);
  assert.equal(developerHtml.includes('<a class="admin-entry" href="/admin">관리 홈</a>'), true);
});

test('browser scripts avoid string-built DOM injection surfaces', () => {
  const searchJs = readFileSync(new URL('../public/search.js', import.meta.url), 'utf8');
  const editorJs = readFileSync(new URL('../public/editor.js', import.meta.url), 'utf8');
  const adsJs = readFileSync(new URL('../public/ads.js', import.meta.url), 'utf8');
  const turnstileLoaderJs = readFileSync(new URL('../public/turnstile-loader.js', import.meta.url), 'utf8');
  assert.equal(searchJs.includes('innerHTML'), false);
  assert.equal(searchJs.includes('insertAdjacentHTML'), false);
  assert.equal(editorJs.includes('innerHTML'), false);
  assert.equal(editorJs.includes('insertAdjacentHTML'), false);
  assert.equal(editorJs.includes('DOMParser'), true);
  assert.equal(editorJs.includes('sanitizePreviewNode'), true);
  assert.equal(editorJs.includes("'/api/preview'"), true);
  assert.equal(editorJs.includes('/api/pages/${encodeURIComponent(pageId)}/preview'), true);
  assert.equal(editorJs.includes('formSelect.dataset.componentForms'), true);
  assert.equal(adsJs.includes('127.0.0.1'), true);
  assert.equal(adsJs.includes('document.createElement'), true);
  assert.equal(turnstileLoaderJs.includes("window.location.protocol === 'https:'"), true);
  assert.equal(turnstileLoaderJs.includes('document.createElement'), true);
  assert.equal(adsJs.includes('append('), true);
});

test('render audits share route catalog and check real text contrast', () => {
  const mobileAuditScript = readFileSync(new URL('../scripts/audit-mobile-render.ts', import.meta.url), 'utf8');
  const desktopAuditScript = readFileSync(new URL('../scripts/audit-desktop-render.ts', import.meta.url), 'utf8');
  const renderAuditShared = readFileSync(new URL('../scripts/audit-render-shared.ts', import.meta.url), 'utf8');
  const liveAffordanceAudit = readFileSync(new URL('../scripts/audit-live-affordances.ts', import.meta.url), 'utf8');
  const routeCatalog = readFileSync(new URL('../scripts/audit-route-catalog.ts', import.meta.url), 'utf8');
  const specialTs = readFileSync(new URL('../src/wiki/special.ts', import.meta.url), 'utf8');
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const packageJson = readFileSync(new URL('../package.json', import.meta.url), 'utf8');
  assert.equal(mobileAuditScript.includes('runRenderAudit'), true);
  assert.equal(mobileAuditScript.includes("theme: 'dark'"), true);
  assert.equal(mobileAuditScript.includes('requireMobileMenu: true'), true);
  assert.equal(mobileAuditScript.includes('minTargetSize: 32'), true);
  assert.equal(desktopAuditScript.includes('runRenderAudit'), true);
  assert.equal(desktopAuditScript.includes("theme: 'light'"), true);
  assert.equal(desktopAuditScript.includes('requireDesktopNav: true'), true);
  assert.equal(desktopAuditScript.includes('minTargetSize: 24'), true);
  assert.equal(renderAuditShared.includes('auditRouteSet'), true);
  assert.equal(renderAuditShared.includes('contrastRatio'), true);
  assert.equal(renderAuditShared.includes('relativeLuminance'), true);
  assert.equal(renderAuditShared.includes("document.querySelectorAll('.topbar, .page-intent-strip, main, .site-footer')"), true);
  assert.equal(renderAuditShared.includes('document.createTreeWalker(root, NodeFilter.SHOW_TEXT)'), true);
  assert.equal(renderAuditShared.includes('blendColor'), true);
  assert.equal(renderAuditShared.includes('visiblePseudoTextNodes'), true);
  assert.equal(renderAuditShared.includes("['::before', '::after']"), true);
  assert.equal(renderAuditShared.includes('low contrast text'), true);
  assert.equal(renderAuditShared.includes('deadLinks'), true);
  assert.equal(renderAuditShared.includes('formIssues'), true);
  assert.equal(renderAuditShared.includes('disabledWithoutReason'), true);
  assert.equal(renderAuditShared.includes('unlabeledControls'), true);
  assert.equal(renderAuditShared.includes('controlName'), true);
  assert.equal(renderAuditShared.includes('unlabeled form controls'), true);
  assert.equal(renderAuditShared.includes('smallTargets'), true);
  assert.equal(renderAuditShared.includes('small interactive targets'), true);
  assert.equal(renderAuditShared.includes('rolePurposePanels'), true);
  assert.equal(renderAuditShared.includes('actionControls'), true);
  assert.equal(renderAuditShared.includes('missing role workflow purpose panel'), true);
  assert.equal(renderAuditShared.includes('missing visible role action controls'), true);
  assert.equal(renderAuditShared.includes("message.type() === 'error'"), true);
  assert.equal(renderAuditShared.includes('browser console errors'), true);
  assert.equal(renderAuditShared.includes('browser page errors'), true);
  assert.equal(renderAuditShared.includes('dead links'), true);
  assert.equal(renderAuditShared.includes('form affordance issues'), true);
  assert.equal(renderAuditShared.includes('disabled controls without reason'), true);
  assert.equal(renderAuditShared.includes('hasDesktopNav'), true);
  assert.equal(renderAuditShared.includes('horizontal overflow'), true);
  assert.equal(renderAuditShared.includes('dark unreadable text'), false);
  assert.equal(liveAffordanceAudit.includes('renderedAffordances'), true);
  assert.equal(liveAffordanceAudit.includes('routeExists'), true);
  assert.equal(liveAffordanceAudit.includes('visible link points at JSON API'), true);
  assert.equal(liveAffordanceAudit.includes('has no server route'), true);
  assert.equal(routeCatalog.includes('export async function auditRouteSet'), true);
  assert.equal(routeCatalog.includes('specialQualityPages'), true);
  assert.equal(serverTs.includes('isSpecialQualityKind'), true);
  assert.equal(serverTs.includes('specialQualityLabel'), true);
  for (const specialKind of [
    'needs_check',
    'stub',
    'uncategorized',
    'broken-links',
    'needed-pages',
    'page-requests',
    'missing-status',
    'missing-infobox',
    'no-internal-links',
    'old-mods',
    'server-missing-address',
    'outdated'
  ]) {
    assert.equal(specialTs.includes(`kind: '${specialKind}'`), true);
  }
  assert.equal(packageJson.includes('"audit:desktop": "tsx scripts/audit-desktop-render.ts"'), true);
  assert.equal(packageJson.includes('"audit:affordances": "tsx scripts/audit-live-affordances.ts"'), true);
});

test('static internal UI links and form actions resolve to server routes', () => {
  const uiTs = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const paths = new Set<string>();
  for (const pattern of [/href="(\/[^"`<>{}\s]+)"/g, /action="(\/[^"`<>{}\s]+)"/g]) {
    for (const match of uiTs.matchAll(pattern)) paths.add(normalizeStaticPath(match[1]));
  }
  const routes = [...serverTs.matchAll(/app\.(?:get|post|put|delete)\('([^']+)'/g)]
    .map((match) => match[1])
    .filter((route) => route !== '/*')
    .map(routePattern);
  const staticPrefixes = ['/assets/', '/cdn/', '/file/'];
  const missing = [...paths]
    .filter((path) => !staticPrefixes.some((prefix) => path.startsWith(prefix)))
    .filter((path) => !routes.some((route) => route.test(path)))
    .sort();
  assert.deepEqual(missing, []);
});

test('UI tables use the shared wiki table styling', () => {
  const uiTs = readFileSync(new URL('../src/ui.ts', import.meta.url), 'utf8');
  const classlessTables = [...uiTs.matchAll(/<table(?![^>]*\bclass=)/g)].map((match) => match.index);
  assert.deepEqual(classlessTables, []);
  assert.equal(uiTs.includes('function componentTableMarkup'), true);
  assert.equal(uiTs.includes('<table class="component-table'), false);
  assert.equal((uiTs.match(/data-table-wrap/g) ?? []).length, 1);
  assert.equal(uiTs.includes("needs_alias: '별칭 필요'"), true);
  assert.equal(uiTs.includes("bad_ranking: '검색 순위 조정 필요'"), true);
  assert.equal(uiTs.includes("needs_work: '작업 필요'"), true);
});

test('public server status does not return raw MOTD text', () => {
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes('motd: status.motd'), false);
  assert.match(serverTs, /motd:\s*null/);
});

test('authenticated redirects and dense admin panels stay browser-safe', () => {
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../public/wiki-skin.css', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("encodeURIComponent('연습장')"), true);
  assert.equal(serverTs.includes("prefix: '/cdn/'"), true);
  assert.equal(serverTs.includes('decorateReply: false'), true);
  assert.equal(serverTs.includes("app.get('/servers/import'"), true);
  assert.equal(serverTs.includes("reply.redirect('/servers/new?import=1')"), true);
  assert.equal(serverTs.includes("app.get('/admin/files'"), true);
  assert.equal(serverTs.includes("app.post('/admin/files/:id'"), true);
  assert.equal(serverTs.includes("app.get('/admin/export/backup'"), true);
  assert.equal(serverTs.includes("app.get('/server/:slug/export'"), true);
  assert.equal(serverTs.includes("app.get('/admin/jobs'"), true);
  assert.equal(serverTs.includes("app.get('/api/admin/jobs'"), true);
  assert.equal(serverTs.includes("app.get('/admin/subwiki-requests/:id'"), true);
  assert.equal(serverTs.includes("app.post('/admin/subwiki-requests/:id'"), true);
  assert.equal(serverTs.includes("app.post('/mod/:slug/manage/roles'"), true);
  assert.equal(serverTs.includes("app.post('/mod/:slug/manage/roles/:roleId/revoke'"), true);
  assert.equal(serverTs.includes("app.get('/favicon.ico'"), true);
  assert.equal(serverTs.includes("https://ep2.adtrafficquality.google"), true);
  assert.equal(serverTs.includes("https://csi.gstatic.com"), true);
  assert.equal(serverTs.includes("https://www.google.com"), true);
  assert.equal(serverTs.includes('function safeNextPath'), true);
  assert.equal(serverTs.includes('function loginHrefForRequest'), true);
  assert.equal(serverTs.includes('function accessActionOptions'), true);
  assert.equal(serverTs.includes('function adminAccessDenied'), true);
  assert.equal(serverTs.includes('return reply.redirect(safeNextPath(body.next) || \'/\');'), true);
  assert.equal((serverTs.match(/reply\.redirect\(loginHrefForRequest\(request\)\)/g) ?? []).length >= 7, true);
  assert.equal(serverTs.includes('<input type="hidden" name="next"'), true);
  assert.equal((serverTs.match(/adminAccessDenied\(reply, request/g) ?? []).length >= 9, true);
  assert.equal(serverTs.includes("secondaryLabel: '다른 계정으로 로그인'"), true);
  assert.equal(serverTs.includes("if (!can(user, 'report.handle')) return reply.code(403).type('text/html').send(messagePage('권한 없음', '관리 권한이 필요합니다.', user, { tone: 'error', actionHref: '/login', actionLabel: '로그인', currentSpace: 'admin' }));"), false);
  assert.equal(serverTs.includes("return reply.code(400).send('title required');"), false);
  assert.equal(serverTs.includes("return reply.code(400).send('wiki and title required');"), false);
  assert.equal(serverTs.includes("return reply.code(403).send('owner required');"), false);
  assert.equal(serverTs.includes("return reply.code(404).send('server wiki not found');"), false);
  assert.equal(serverTs.includes("return reply.code(403).send('admin required');"), false);
  assert.equal(serverTs.includes("return reply.code(404).send('plan not found');"), false);
  assert.equal(/reply\.code\([0-9]+\)\.send\('[^']+'\)/.test(serverTs), false);
  assert.equal(serverTs.includes('function missingDocumentPage'), true);
  assert.equal(serverTs.includes('.send(missingDocumentPage(resolved.namespace, resolved.title'), true);
  assert.equal(serverTs.includes('.send(editPage(namespace, title, initialContent, user, [], pageTypeForDocumentType(requestedType), \'\'));'), false);
  assert.equal(serverTs.includes('function revisionHistoryFilterTag'), true);
  assert.equal(serverTs.includes('filterRevisionHistory(revisions, filterTag, user)'), true);
  assert.equal(css.includes('.admin-panel,\n.operator-panel {\n  max-width: 100%;\n  overflow-x: auto;'), true);
  assert.equal(css.includes('.data-table-wrap {\n  overflow-x: auto;'), true);
  assert.equal(css.includes('.recent-layout {\n  display: grid;\n  grid-template-columns: minmax(0, 1fr) 260px;'), true);
  assert.equal(css.includes('grid-template-areas: "recent-main recent-sidebar";'), true);
  assert.equal(css.includes('.recent-sidebar {\n  grid-area: recent-sidebar;\n  position: sticky;'), true);
  assert.equal(css.includes('.inline-post-action {\n  display: inline-flex;'), true);
  assert.equal(css.includes('.recent-card-list {\n  display: none;'), true);
  assert.equal(css.includes('.recent-table-view {\n    display: none;'), true);
	  assert.equal(css.includes('.topbar .top-search {\n  box-sizing: border-box;'), true);
	  assert.equal(css.includes('.admin-topbar {\n  grid-template-columns: 220px minmax(0, 1fr);'), true);
	  assert.equal(css.includes('.admin-topbar .desktop-search,\n.desktop-nav .mobile-menu-section {\n  display: none;'), true);
	  assert.equal(css.includes('.topbar .desktop-search {\n    display: none !important;'), true);
	  assert.equal(css.includes('.mobile-search[open] form {\n    display: grid;'), true);
	  assert.equal(css.includes('.mobile-menu > nav {\n    top: 56px;'), true);
	  assert.equal(css.includes('.mobile-menu > nav .mobile-menu-section {\n    grid-column: 1 / -1;'), true);
	  assert.equal(css.includes('/* Liberty-inspired wiki chrome: compact role state and dense page tools. */'), true);
	  assert.equal(css.includes('.user-chip,\n.admin-mode-chip {\n  display: inline-flex;'), true);
	  assert.equal(css.includes('.role-admin .user-chip,\n.role-developer .user-chip {'), true);
	  assert.equal(css.includes('grid-template-areas:\n      "recent-sidebar"\n      "recent-main";'), true);
	  assert.equal(css.includes('.article-actions > .document-mode-tabs,'), true);
	  assert.equal(css.includes('.article-watch-control {\n  display: inline-flex;'), true);
	  assert.equal(css.includes('.discussion-shell .article {\n  grid-column: 2 / 4;'), true);
	  assert.equal(css.includes('.discussion-summary {\n  display: grid;'), true);
	  assert.equal(css.includes('.discussion-guide-panel {\n  display: grid;'), true);
	  assert.equal(css.includes('.component-tool-group {\n  display: grid;'), true);
	  assert.equal(css.includes('.public-info-tabs {\n  display: flex;'), true);
	  assert.equal(css.includes('.public-info-summary {\n  display: grid;'), true);
	  assert.equal(css.includes('.public-info-guide {\n  display: grid;'), true);
	  assert.equal(css.includes('.operator-flow-summary {\n  display: grid;'), true);
	  assert.equal(css.includes('.operator-guide-panel {\n  display: grid;'), true);
	  assert.equal(css.includes('.discussion-tabs {\n  display: flex;'), true);
	  assert.equal(css.includes('.recent-quick-filters a,\n.mobile-menu > nav a,'), true);
	  assert.equal(css.includes('.empty-table-cell {\n  background: var(--surface-2);'), true);
	  assert.equal(css.includes('.empty-table-action {\n  width: fit-content;'), true);
  assert.equal(css.includes('.diff-table,\n.diff-grid > article'), true);
  assert.equal(css.includes('.inline-form,\n  .filter-bar,\n  .stack-form'), true);
  assert.equal(css.includes('.narrow > .component-table {\n    display: block;\n    overflow-x: auto;'), true);
  assert.equal(css.includes('.article-body > table,\n  .article-body > .wiki-table {\n    width: 100%;\n    min-width: 0;'), true);
  assert.equal(css.includes('.article-body > .table-scroll .wiki-table {\n    min-width: 520px;'), true);
  assert.equal(css.includes('.project-kanban {\n    grid-template-columns: minmax(0, 1fr);\n    margin-inline: 0;'), true);
  assert.equal(css.includes('.kanban-column {\n    min-width: 0;'), true);
  assert.equal(css.includes('.operator-card strong,\n.operator-card span,\n.operator-card small,'), true);
  assert.equal(css.includes('overflow-wrap: anywhere;'), true);
  assert.equal(css.includes('/* Dark-mode hardening for legacy app.css surfaces. */'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .article,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .auth-card,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .operator-flow-summary span,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .public-info-summary span,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .discussion-summary span,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .discussion-comment,'), true);
  assert.equal(css.includes(':root[data-theme="dark"] .component-table,'), true);
});

test('browser post forms return to HTML pages instead of JSON endpoints', () => {
  const user = { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['page.move', 'revision.hide', 'report.handle'] } as any;
  const articleHtml = articlePage(
    {
      id: 1,
      namespace_code: 'main',
      namespace_name: '문서',
      title: '문서 정리',
      display_title: '문서 정리',
      html: '<h2 id="s-1">개요</h2><p>본문</p>',
      categories_json: '[]',
      toc_json: JSON.stringify([{ level: 2, id: 's-1', text: '개요' }]),
      missing_links_json: '[]',
      sectionLocks: [],
      protection_level: 'open'
    },
    user
  );
  assert.equal(articleHtml.includes('/admin/pages/1/split-section'), true);
  assert.equal(articleHtml.includes('/admin/pages/1/merge'), true);
  assert.equal(articleHtml.includes('<summary>문서 정리</summary>'), true);
  assert.equal(articleHtml.includes('name="sourcePageRef"'), true);
  assert.equal(articleHtml.includes('병합할 문서 제목 또는 번호'), true);
  assert.equal(articleHtml.includes('병합할 문서 번호'), false);
  assert.equal(articleHtml.includes('/api/admin/pages/1/split-section'), false);
  assert.equal(articleHtml.includes('/api/admin/pages/1/merge'), false);

  const reviewHtml = reviewDetailPage(
    {
      id: 9,
      status: 'pending',
      reason: '신규 사용자 검토',
      draft: { namespace_code: 'main', title: '검토 문서', content_raw: '제출', edit_summary: '요약' },
      current: { content_raw: '현재', current_revision_id: 3 }
    },
    user
  );
  assert.equal(reviewHtml.includes('/admin/reviews/9/resolve'), true);
  assert.equal(reviewHtml.includes('admin-review-page'), true);
  assert.equal(reviewHtml.includes('class="admin-guide-panel review-guide"'), true);
  assert.equal(reviewHtml.includes('편집 검토 순서'), true);
  assert.equal(reviewHtml.includes('변경 영향 확인'), true);
  assert.equal(reviewHtml.includes('렌더링 비교'), true);
  assert.equal(reviewHtml.includes('처리 기록'), true);
  assert.equal(reviewHtml.includes('/api/admin/reviews/9/resolve'), false);
  assert.equal(reviewHtml.includes('main:검토 문서'), false);
  assert.equal(reviewHtml.includes('<a href="/wiki/%EA%B2%80%ED%86%A0_%EB%AC%B8%EC%84%9C">위키 · 검토 문서</a>'), true);
  assert.equal(reviewHtml.includes('<th>기준 판</th><td>r3</td>'), true);
  assert.equal(reviewHtml.includes('검토 영향'), true);
  assert.equal(reviewHtml.includes('제출 미리보기'), true);
  assert.equal(reviewHtml.includes('<summary>원문 비교</summary>'), true);

  const historyHtml = revisionHistoryPage(
    { id: 1, namespace_code: 'main', title: '문서 정리', display_title: '문서 정리', aclLogs: [] },
    [
      { id: 3, revision_no: 3, visibility: 'public', created_at: '2026-05-24 12:00:00', actor_name: '관리자', edit_summary: '현재', content_size: 10 },
      { id: 2, revision_no: 2, visibility: 'admin_only', created_at: '2026-05-24 11:00:00', actor_name: '관리자', edit_summary: '숨김', content_size: 8 }
    ],
    user
  );
  assert.equal(historyHtml.includes('/admin/revisions/2/unhide'), true);
  assert.equal(historyHtml.includes('/api/admin/revisions/2/unhide'), false);

  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("app.post('/admin/pages/:id/split-section'"), true);
  assert.equal(serverTs.includes("app.post('/admin/pages/:id/merge'"), true);
  assert.equal(serverTs.includes("searchTargetPageFromBody(body, ['sourcePageRef', 'sourcePageId', 'source_page_id'])"), true);
  assert.equal(serverTs.includes('same_page_merge'), true);
  assert.equal(serverTs.includes('병합할 원본 문서를 제목 또는 번호로 입력하세요.'), true);
  assert.equal(serverTs.includes("app.post('/admin/reviews/:id/resolve'"), true);
  assert.equal(serverTs.includes("app.post('/admin/revisions/:id/unhide'"), true);
  assert.equal(serverTs.includes("app.post('/files/:id/report'"), true);
  assert.equal(serverTs.includes('reply.redirect(`/api/server-subwikis/${encodeURIComponent(slug)}/export'), false);
  assert.equal(serverTs.includes("return reply.redirect('/api/admin/export/backup')"), false);
  assert.equal(serverTs.includes("return reply.redirect('/api/admin/export/manifest')"), false);
});

test('empty search requests use the wiki page-request flow', () => {
  const html = searchPage('없는문서', [], null, 'dev');
  assert.equal(html.includes('action="/page-requests"'), true);
  assert.equal(html.includes('name="namespace" value="dev"'), true);
  assert.equal(html.includes('name="title" value="없는문서"'), true);
  assert.equal(html.includes('문서 작성 요청'), true);
  assert.equal(html.includes('class="active-space" href="/dev"'), true);
  assert.equal(html.includes('action="/api/beta/feedback"'), false);
  assert.equal(html.includes('/new?title=%EC%97%86%EB%8A%94%EB%AC%B8%EC%84%9C'), true);

  const newHtml = newDocumentPage(null, { title: '없는문서' });
  assert.equal(newHtml.includes('작성할 제목'), true);
  assert.equal(newHtml.includes('/new/wiki?title=%EC%97%86%EB%8A%94%EB%AC%B8%EC%84%9C'), true);
  assert.equal(newHtml.includes('/new/dev?title=%EC%97%86%EB%8A%94%EB%AC%B8%EC%84%9C'), true);

  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("app.post('/page-requests'"), true);
  assert.equal(serverTs.includes('createPageRequestAction'), true);
});

test('search result badges escape space titles and avoid raw namespace codes', () => {
  const html = searchPage(
    '테스트',
    [
      { page_id: 1, namespace_code: 'main', title: '대문', space_title: '<script>alert(1)</script>', excerpt: '요약' },
      { page_id: 2, namespace_code: 'dev', title: '플러그인/API', excerpt: '개발 문서' },
      { page_id: 3, namespace_code: 'server', title: '예시/규칙', excerpt: '', server_verified_status: 'verified', server_operational_status: 'active', server_edition: 'java' }
    ],
    null
  );
  assert.equal(html.includes('<script>alert(1)</script>'), false);
  assert.equal(html.includes('&lt;script&gt;alert(1)&lt;/script&gt;'), true);
  assert.equal(html.includes('<span class="space-badge">개발</span>'), true);
  assert.equal(html.includes('<span class="space-badge">dev</span>'), false);
  assert.equal(html.includes('요약 없음'), true);
  assert.equal(html.includes('문서 요약을 준비 중입니다'), false);
  assert.equal(html.includes('class="search-summary"'), true);
  assert.equal(html.includes('class="search-guide-panel"'), true);
  assert.equal(html.includes('운영자 인증'), true);
  assert.equal(html.includes('운영 중'), true);
  assert.equal(html.includes('>verified<'), false);
  assert.equal(html.includes('>active<'), false);
});

test('server operator utility pages use operator wiki chrome', () => {
  const user = { id: 1, username: 'owner', display_name: '운영자', groups: ['server_owner'], permissions: [] } as any;
  const myServersHtml = myServersPage(
    [
      {
        slug: 'example',
        title: '예시 서버',
        verified_status: 'verified',
        next_verification_due_at: '2026-06-01 00:00:00',
        verification_expires_at: '2026-07-01 00:00:00',
        official_doc_count: 3,
        last_edit_at: '2026-05-24 12:00:00',
        pending_review_count: 0,
        owner_count: 1
      }
    ],
    user
  );
  assert.equal(myServersHtml.includes('operator-shell space-server'), true);
  assert.equal(myServersHtml.includes('operator-panel'), true);
  assert.equal(myServersHtml.includes('class="operator-flow-summary my-server-summary"'), true);
  assert.equal(myServersHtml.includes('서버 관리 순서'), true);
  assert.equal(myServersHtml.includes('갱신 필요 서버가 있으면 먼저 인증 화면에서 DNS 상태를 확인합니다.'), true);
  assert.equal(myServersHtml.includes('<strong>1개</strong>인증 완료'), true);
  assert.equal(myServersHtml.includes('<strong>3개</strong>공식 문서'), true);
  assert.equal(myServersHtml.includes('<main class="admin space-server">'), false);
  const emptyMyServersHtml = myServersPage([], user);
  assert.equal(emptyMyServersHtml.includes('관리 중인 서버 없음'), true);
  assert.equal(emptyMyServersHtml.includes('서버 위키 만들기'), true);

  const claimHtml = serverClaimPage(
    { slug: 'example', title: '예시 서버' },
    { host: 'play.example.kr', verified_status: 'pending' },
    { id: 1, record_name: '_minewiki.play.example.kr', expected_value: 'minewiki-token', status: 'pending' },
    [],
    user
  );
  assert.equal(claimHtml.includes('operator-shell space-server'), true);
  assert.equal(claimHtml.includes('operator-panel'), true);
  assert.equal(claimHtml.includes('class="operator-flow-summary server-claim-summary"'), true);
  assert.equal(claimHtml.includes('DNS 인증 순서'), true);
  assert.equal(claimHtml.includes('DNS 토큰을 발급하고 아래 TXT Name과 Value를 복사합니다.'), true);
  assert.equal(claimHtml.includes('<strong>대기</strong>인증 상태'), true);
  assert.equal(claimHtml.includes('<strong>발급됨</strong>DNS 토큰'), true);
  assert.equal(claimHtml.includes('<main class="admin space-server">'), false);
  assert.equal((claimHtml.match(/href="\/server\/example\/manage"/g) ?? []).length, 1);
  assert.equal((claimHtml.match(/href="\/server\/example"/g) ?? []).length, 1);
  assert.equal(claimHtml.includes('확인 기록 없음'), true);
});

test('operator dashboards localize raw document and server statuses', () => {
  const user = { id: 1, username: 'owner', display_name: '운영자', groups: ['server_owner'], permissions: [] } as any;
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  const serverHtml = serverOperatorDashboardPage(
    { slug: 'example', title: '예시 서버', name: '예시 서버' },
    [{ title: 'example/규칙', quality_status: null, updated_at: '2026-05-24 12:00:00' }],
    [
      { id: 1, label: '가이드', target_title: 'example/가이드', sort_order: 10 },
      { id: 2, parent_id: 1, label: '규칙', target_title: 'example/규칙', sort_order: 20 }
    ],
    [{ id: 2, display_name: '운영자', role: 'server_manager', status: 'active' }],
    [{ source_type: 'gitbook', status: 'in_progress', source_note: '이전 중' }],
    {},
    [{ title: '시즌 2', status: 'planned', starts_at: '2026-06-01 00:00:00', ends_at: null }],
    { host: 'play.example.kr', edition: 'unknown', operational_status: 'active' },
    user,
    {
      features: { themeTokens: true, customCss: true, customDomain: true, markdownImport: false },
      theme: { theme_key: 'minimal-docs', background_mode: 'system', custom_css_status: 'none' },
      domains: [
        { id: 1, domain: 'pending.example.kr', status: 'pending', ssl_status: 'pending', dns_record_name: '_minewiki.pending', dns_record_value: 'token-1' },
        { id: 2, domain: 'verified.example.kr', status: 'verified', ssl_status: 'issued', dns_record_name: '_minewiki.verified', dns_record_value: 'token-2' },
        { id: 3, domain: 'active.example.kr', status: 'active', ssl_status: 'active', dns_record_name: '_minewiki.active', dns_record_value: 'token-3' }
      ]
    }
  );
  assert.equal(serverHtml.includes('알 수 없음'), true);
  assert.equal(serverHtml.includes('에디션 미정'), true);
  assert.equal(serverHtml.includes('서버 관리자'), true);
  assert.equal(serverHtml.includes('>편집자</option>'), true);
  assert.equal(serverHtml.includes('>관리자</option>'), true);
  assert.equal(serverHtml.includes('>소유자</option>'), true);
  assert.equal(serverHtml.includes('진행 중'), true);
  assert.equal(serverHtml.includes('예정'), true);
  assert.equal(serverHtml.includes('>unknown<'), false);
  assert.equal(serverHtml.includes('>active<'), false);
  assert.equal(serverHtml.includes('server_manager'), false);
  assert.equal(serverHtml.includes('>example/규칙<'), false);
  assert.equal(serverHtml.includes('>규칙</a>'), true);
  assert.equal(serverHtml.includes('상위 항목을 지정하면 방문자 화면의 문서 트리에 부모-자식 관계로 표시됩니다.'), true);
  assert.equal(serverHtml.includes('<th>상위</th>'), true);
  assert.equal(serverHtml.includes('name="parentId"'), true);
  assert.equal(serverHtml.includes('<td>가이드</td><td><a href="/server/example/%EA%B7%9C%EC%B9%99">규칙</a></td>'), true);
  assert.equal(serverHtml.includes('<option value="1" selected>가이드</option>'), true);
  assert.equal(serverHtml.includes('<option value="2" selected>'), false);
  assert.equal(serverHtml.includes('href="#"'), false);
  assert.equal(serverHtml.includes('/api/server-subwikis'), false);
  assert.equal(serverHtml.includes('href="/server/example/export">전체 문서 묶음</a>'), false);
  assert.equal(serverHtml.includes('/server/example/export?format=markdown'), true);
  assert.equal(serverHtml.includes('>문서 중심</option>'), true);
  assert.equal(serverHtml.includes('>기기 설정 따름</option>'), true);
  assert.equal(serverHtml.includes('상태: 등록 없음'), true);
  assert.equal(serverHtml.includes('>editor</option>'), false);
  assert.equal(serverHtml.includes('>manager</option>'), false);
  assert.equal(serverHtml.includes('>owner</option>'), false);
  assert.equal(serverHtml.includes('>minimal-docs</option>'), false);
  assert.equal(serverHtml.includes('>system</option>'), false);
  assert.equal(serverHtml.includes('/manage/custom-domain/1/verify'), true);
  assert.equal(serverHtml.includes('/manage/custom-domain/1/activate'), false);
  assert.equal(serverHtml.includes('/manage/custom-domain/2/activate'), true);
  assert.equal(serverHtml.includes('/manage/custom-domain/3/activate'), false);
  assert.equal(serverHtml.includes('/manage/custom-domain/3/disable'), true);
  assert.equal(serverHtml.includes('name="archive" accept=".zip,.md,.markdown" aria-label="Markdown 또는 GitBook 파일" disabled title="Pro 이상에서 Markdown/GitBook 이전을 사용할 수 있습니다." aria-describedby="markdown-import-plan-lock"'), true);
  assert.equal(serverHtml.includes('<button disabled title="Pro 이상에서 Markdown/GitBook 이전을 사용할 수 있습니다." aria-describedby="markdown-import-plan-lock">Markdown 가져오기</button>'), true);
  assert.equal(serverHtml.includes('Markdown/GitBook 이전 잠김'), true);
  assert.equal(serverHtml.includes('id="markdown-import-plan-lock"'), true);
  assert.equal(serverHtml.includes('필요 플랜: Pro 이상'), true);
  assert.equal(serverHtml.includes('커스텀 도메인 잠김'), false);
  assert.equal(serverHtml.includes('서버 테마 잠김'), false);
  const emptyServerHtml = serverOperatorDashboardPage(
    { slug: 'example', title: '예시 서버', name: '예시 서버' },
    [],
    [],
    [],
    [],
    {},
    [],
    {},
    user
  );
  assert.equal(emptyServerHtml.includes('등록된 운영자 없음'), true);
  assert.equal(emptyServerHtml.includes('문서 만들기'), true);
  assert.equal(emptyServerHtml.includes('이전 작업 없음'), true);
  assert.equal(emptyServerHtml.includes('커스텀 도메인 잠김'), true);
  assert.equal(emptyServerHtml.includes('서버 테마 잠김'), true);
  assert.equal(emptyServerHtml.includes('제한 CSS 잠김'), true);
  assert.equal(emptyServerHtml.includes('Markdown/GitBook 이전 잠김'), true);
  assert.equal(emptyServerHtml.includes('id="custom-domain-plan-lock"'), true);
  assert.equal(emptyServerHtml.includes('aria-describedby="custom-domain-plan-lock"'), true);
  assert.equal(emptyServerHtml.includes('id="theme-plan-lock"'), true);
  assert.equal(emptyServerHtml.includes('aria-describedby="theme-plan-lock"'), true);
  assert.equal(emptyServerHtml.includes('id="custom-css-plan-lock"'), true);
  assert.equal(emptyServerHtml.includes('aria-describedby="custom-css-plan-lock"'), true);
  assert.equal(emptyServerHtml.includes('id="markdown-import-plan-lock"'), true);
  assert.equal(emptyServerHtml.includes('aria-describedby="markdown-import-plan-lock"'), true);

  const modHtml = modOperatorDashboardPage(
    { slug: 'create', title: 'Create', name: 'Create' },
    [{ title: 'Create/회전력', quality_status: 'needs_check', updated_at: '2026-05-24 12:00:00' }],
    [
      { id: 10, label: '기초', target_title: 'Create/기초', sort_order: 10 },
      { id: 11, parent_id: 10, label: '회전력', target_title: 'Create/회전력', sort_order: 20 }
    ],
    [{ id: 9, display_name: '검토자', role: 'mod_wiki_editor', status: 'active' }],
    { require_review: 1 },
    { category: '기술', loaders: 'Forge, Fabric', supported_versions: '1.20.1', official_url: 'https://example.com', source_url: 'https://github.com/example/create', license: 'MIT' },
    user
  );
  assert.equal(modHtml.includes('검토 필요'), true);
  assert.equal(modHtml.includes('모드 위키 편집자'), true);
  assert.equal(modHtml.includes('/mod/create/manage/roles/9/revoke'), true);
  assert.equal(modHtml.includes('/mod/create/manage/roles'), true);
  assert.equal(modHtml.includes('데이터 완성도'), true);
  assert.equal(modHtml.includes('7/7'), true);
  assert.equal(modHtml.includes('>needs_check<'), false);
  assert.equal(modHtml.includes('mod_wiki_editor'), false);
  assert.equal(modHtml.includes('>Create/회전력<'), false);
  assert.equal(modHtml.includes('>회전력</a>'), true);
  assert.equal(modHtml.includes('설치, 시스템, 아이템처럼 상위 항목을 나누면 읽는 사람이 문서 흐름을 바로 파악할 수 있습니다.'), true);
  assert.equal(modHtml.includes('<td>기초</td><td><a href="/mod/Create/%ED%9A%8C%EC%A0%84%EB%A0%A5">회전력</a></td>'), true);
  assert.equal(modHtml.includes('<option value="10" selected>기초</option>'), true);
  const emptyModHtml = modOperatorDashboardPage({ slug: 'create', title: 'Create', name: 'Create' }, [], [], [], {}, {}, user);
  assert.equal(emptyModHtml.includes('문서 없음'), true);
  assert.equal(emptyModHtml.includes('/mod/create/new'), true);
  assert.equal(emptyModHtml.includes('등록된 역할 없음'), true);
  assert.equal(emptyModHtml.includes('공동 편집자나 검토자를 추가하세요'), true);
  assert.equal(serverTs.includes('SELECT id, parent_id, label, target_title, sort_order FROM subwiki_sidebar_items'), true);
  assert.equal(serverTs.includes('async function sidebarParentIdFromBody'), true);
  assert.equal(serverTs.includes('사이드바 부모-자식 관계가 순환됩니다.'), true);
  assert.equal(serverTs.includes('parent_id=:parentId'), true);
});

test('admin files page renders as managed HTML instead of JSON navigation', () => {
  const html = adminFilesPage(
    {
      licenseIssues: [
        {
          id: 1,
          file_name: 'license-needed.png',
          original_name: 'license-needed.png',
          mime_type: 'image/png',
          size_bytes: 68,
          license: 'license_needed',
          source_url: 'https://example.com/source',
          source_text: 'https://example.com/source',
          status: 'license_needed'
        }
      ],
      unusedFiles: []
    },
    { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] } as any
  );
  assert.equal(html.includes('/admin/files/1'), true);
  assert.equal(html.includes('/file/license-needed.png'), true);
  assert.equal(html.includes('검토 요약'), true);
  assert.equal(html.includes('<span>라이선스/출처 필요</span>'), true);
  assert.equal(html.includes('파일 정보 저장'), true);
  assert.equal(html.includes('<span>출처 URL</span>'), true);
  assert.equal(html.includes('숨김/삭제는 일반 문서의 파일 표시를 제한합니다.'), true);
  assert.equal(html.includes('href="/file/upload"'), true);
  assert.equal(html.includes('/api/admin/file-license-issues'), false);
  assert.equal(html.includes('라이선스 원본'), false);
  assert.equal(html.includes('라이선스 JSON'), false);
  assert.equal(html.includes('>license_needed<'), false);
  assert.equal(html.includes('라이선스 확인 필요'), true);
  assert.equal(html.includes('출처 링크'), true);
  assert.equal(html.includes('data-theme-toggle'), true);
  assert.equal(html.includes('/assets/wiki-skin.css'), true);
});

test('admin task pages use the shared admin chrome', () => {
  const user = { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] } as any;
  const adminHome = adminPage(
    {
      work: [
        {
          id: 1,
          work_type: 'server_claim',
          target_type: 'server',
          target_id: 7,
          priority: 'urgent',
          status: 'in_progress',
          assigned_to: null,
          created_at: '2026-05-24 12:00:00'
        }
      ],
      reports: [{ id: 4, page_id: 9, reason: '문제', status: 'open', created_at: '2026-05-24 12:00:00' }],
      logs: [{ id: 5, action: 'server.permissions', target_type: 'server_subwiki', target_id: 12, created_at: '2026-05-24 12:00:00' }]
    },
    user
  );
  const auditPageHtml = adminAuditHubPage(
    {
      contentAudits: [{ page_id: 9, namespace_code: 'main', title: '대문', audit_type: 'structure', status: 'needs_fix', note: '목차 정리' }],
      searchAudits: [{ query: '페이퍼', expected_page_id: 9, expected_namespace_code: 'dev', expected_title: 'Paper API', status: 'bad_ranking', note: '순위 조정' }],
      securityTests: [{ test_key: 'xss-editor-preview', severity: 'high', status: 'failed', note: '재검증 필요' }],
      permissionAudits: [{ audit_key: 'anon-edit-protected', target_type: 'page', status: 'pending', note: '' }],
      performanceChecks: [{ check_key: 'mobile-recent-overflow', target_area: 'recent_changes', status: 'needs_work', note: '' }],
      userTrust: [{ id: 7, username: 'newbie', display_name: '새 사용자', trust_level: 'new', good_edits: 2, reports_received: 0 }]
    },
    user
  );
  const publicationHtml = adminPublicationPage(
    {
      settings: { signup_mode: 'invite', server_listing_mode: 'verified_or_owner', new_user_edit_limit: 10, new_user_external_link_limit: 2, new_user_review_required: 1 },
      announcements: [{ title: '점검 안내', body: '검색 점검', type: 'maintenance', visibility: 'public', starts_at: '2026-05-24 12:00:00', ends_at: null }],
      releaseNotes: [{ version: '2026.05', title: '검색 개선', release_type: 'feature', published_at: '2026-05-24 12:00:00' }],
      incidents: [{ title: '검색 지연', incident_type: 'search', severity: 'major', status: 'investigating', summary: '일부 검색 지연' }],
      campaigns: [{ title: '레드스톤 정비', description: '문서 보강', campaign_type: 'cleanup', status: 'active', starts_at: null, ends_at: null }],
      reportSlaRules: [{ reason: '저작권', priority: 'urgent', target_minutes: 60, enabled: 1 }],
      policyVersions: [{ page_id: 9, namespace_code: 'project', title: '문서 작성 정책', policy_key: 'editing', version: '1.0', status: 'active', effective_at: '2026-05-24 12:00:00' }]
    },
    user
  );
  const identityHtml = adminIdentityPage(
    {
      users: [
        { id: 7, username: 'newbie', display_name: '새 사용자', status: 'active', trust_level: 'new', groups: 'autoconfirmed' },
        { id: 8, username: 'blocked', display_name: '차단 사용자', status: 'blocked', trust_level: 'restricted', groups: '' }
      ],
      serverOwners: [{ id: 3, page_id: 9, server_title: '예시서버', username: 'owner', display_name: '운영자', role: 'owner', status: 'active' }],
      aclGroups: [{ id: 1, group_key: 'trusted_editors', title: '신뢰 편집자', description: '보호 문서 편집 허용', status: 'active', active_member_count: 1 }],
      aclMembers: [{ id: 4, group_key: 'trusted_editors', group_title: '신뢰 편집자', member_type: 'user', user_id: 7, username: 'newbie', display_name: '새 사용자', reason: '검증됨', expires_at: null }]
    },
    user
  );
  const filterHtml = adminEditFiltersPage(
    [
      { id: 5, name: '명백한 스팸 차단', description: '광고성 키워드', filter_type: 'keyword', pattern: '무료 다이아', action: 'block_save', enabled: 1, hit_count: 12 },
      { id: 6, name: '외부 링크 과다 검토', description: '신규 문서 링크 수 확인', filter_type: 'link_count', pattern: '5', action: 'require_review', enabled: 0, hit_count: 3 }
    ],
    user
  );
  const importsHtml = adminImportsPage(
    {
      spaces: [{ id: 3, code: 'server-example', title: '예시 서버', space_type: 'server_wiki', status: 'active' }],
      gitbookJobs: [{ id: 9, space_id: 3, source_type: 'markdown_zip', status: 'pending', imported_pages: 0, source_note: '기존 문서', error_message: null, updated_at: '2026-05-25 12:00:00', space_title: '예시 서버' }],
      markdownJobs: [{ id: 10, space_id: 3, source_type: 'markdown', source_name: 'rules.md', status: 'pending', imported_pages: 0, checklist_json: '["이미지 링크 확인"]', updated_at: '2026-05-25 12:00:00', space_title: '예시 서버' }]
    },
    user
  );
  const subwikisHtml = adminSubwikisPage(
    {
      spaces: [{ id: 3, code: 'server-example', title: '예시 서버', slug: 'example', space_type: 'server_wiki', status: 'active', host: 'play.example.kr', edition: 'java', verified_status: 'pending', doc_count: 3, sidebar_count: 2, role_count: 1 }],
      requests: [{ id: 12, request_type: 'server', title: '테스트 서버', status: 'pending', requester_username: 'owner', created_at: '2026-05-25 12:00:00' }]
    },
    user
  );
  const reportsHtml = adminReportsPage(
    [{ id: 4, target_type: 'page', page_id: 9, namespace_code: 'main', page_title: '대문', reason: 'copyright', detail: '출처 확인 필요', status: 'open', reporter_username: 'wiki-user', created_at: '2026-05-25 12:00:00' }],
    user
  );
  const pages = [
    adminHome,
    adminWorkPage([], [], user),
    reportsHtml,
    adminJobsPage([], user),
    importsHtml,
    subwikisHtml,
    adminReleasePage({ status: {} }, user),
    adminSearchPage({ failed: [], noClicks: [], pins: [], disambiguations: [], dictionary: [] }, user),
    adminFilesPage({ licenseIssues: [], unusedFiles: [] }, user),
    publicationHtml,
    identityHtml,
    filterHtml,
    auditPageHtml,
    modVerificationPage([], [], user)
  ];
  const manifestHtml = adminBackupManifestPage(
    {
      generatedAt: '2026-05-24T12:00:00.000Z',
      includes: { pageSources: 10, revisions: 20, files: 3, wikiSpaces: 4, sidebarItems: 5, subwikiRoles: 6, searchAliases: 7, serverClaims: 8, subwikiSettings: 9, gitbookImports: 1 },
      excludedRegenerable: ['search_index', 'page_render_cache']
    },
    user
  );
  pages.push(manifestHtml);
  for (const html of pages) {
    assert.equal(html.includes('class="topbar nav-wrapper admin-topbar"'), true);
    assert.equal(html.includes('admin-hero'), true);
    assert.equal((html.match(/class="component-table/g) ?? []).length, (html.match(/class="data-table-wrap/g) ?? []).length);
    assert.equal(html.includes('MineWiki 관리'), true);
    assert.equal(html.includes('href="/admin/recent"'), true);
    assert.equal(html.includes('href="/admin/files"'), true);
    assert.equal(html.includes('href="/admin/jobs"'), true);
    assert.equal(html.includes('>JSON<'), false);
    assert.equal(html.includes(' JSON</a>'), false);
    assert.equal(html.includes('Export'), false);
    assert.equal(html.includes('원본 데이터'), false);
    assert.equal(html.includes('상태 원본'), false);
    assert.equal(html.includes('실패어 원본'), false);
    assert.equal(html.includes('라이선스 원본'), false);
    assert.equal(html.includes('미사용 파일 원본'), false);
    assert.equal(html.includes('/api/admin/export'), false);
    assert.equal(html.includes('관리 홈'), false);
  }
  assert.equal(adminHome.includes('/admin/export/backup'), true);
  assert.equal(adminHome.includes('오늘 처리할 일'), true);
  assert.equal(adminHome.includes('운영 기준'), true);
  assert.equal(adminHome.includes('열린 업무'), true);
  assert.equal(adminHome.includes('열린 신고'), true);
  assert.equal(adminHome.includes('href="/admin/reports"'), true);
  assert.equal(adminHome.includes('id="feedback"'), true);
  assert.equal(manifestHtml.includes('백업 매니페스트'), true);
  assert.equal(manifestHtml.includes('admin-backup-page'), true);
  assert.equal(manifestHtml.includes('class="admin-guide-panel backup-guide"'), true);
  assert.equal(manifestHtml.includes('백업 확인 순서'), true);
  assert.equal(manifestHtml.includes('포함 범위 확인'), true);
  assert.equal(manifestHtml.includes('재생성 항목 구분'), true);
  assert.equal(manifestHtml.includes('파일 보관'), true);
  assert.equal(manifestHtml.includes('class="audit-summary backup-summary"'), true);
  assert.equal(manifestHtml.includes('문서</th><td>10'), true);
  assert.equal(manifestHtml.includes('/admin/export/manifest?download=1'), true);
  assert.equal(manifestHtml.includes('/api/admin/export'), false);
  assert.equal(adminHome.includes('업무 유형'), true);
  assert.equal(adminHome.includes('서버 인증'), true);
  assert.equal(adminHome.includes('긴급'), true);
  assert.equal(adminHome.includes('진행 중'), true);
  assert.equal(adminHome.includes('work_type'), false);
  assert.equal(adminHome.includes('server_claim'), false);
  assert.equal(adminHome.includes('urgent'), false);
  assert.equal(adminHome.includes('in_progress'), false);
  assert.equal(adminHome.includes('target_id'), false);
  assert.equal(adminHome.includes('<th>대상 번호</th>'), false);
  assert.equal(adminHome.includes('<th>문서 번호</th>'), false);
  assert.equal(adminHome.includes('<th>문서</th>'), true);
  assert.equal(adminHome.includes('page id'), false);
  assert.equal(adminHome.includes('server.permissions'), false);
  assert.equal(adminHome.includes('server_subwiki'), false);
  assert.equal(adminHome.includes('문서 #9'), false);
  assert.equal(adminHome.includes('문서 지정됨'), true);
  assert.equal(adminHome.includes('id="reports"'), true);
  assert.equal(adminHome.includes('서버 권한 변경'), true);
  assert.equal(adminHome.includes('서버 위키'), true);
  assert.equal(adminHome.includes('베타 피드백'), false);
  assert.equal(adminHome.includes('사용자 피드백'), true);
  assert.equal(adminHome.includes('사용자 없음'), true);
  assert.equal(adminHome.includes('열린 사용자 피드백 없음'), true);
  assert.equal(adminHome.includes('/admin/audits'), true);
  assert.equal(adminHome.includes('/admin/publication'), true);
  assert.equal(adminHome.includes('/admin/identity'), true);
  assert.equal(adminHome.includes('/admin/filters'), true);
  assert.equal(identityHtml.includes('사용자/권한'), true);
  assert.equal(identityHtml.includes('class="admin-guide-panel identity-guide"'), true);
  assert.equal(identityHtml.includes('권한 변경 기준'), true);
  assert.equal(identityHtml.includes('신뢰 등급'), true);
  assert.equal(identityHtml.includes('서버 소유자'), true);
  assert.equal(identityHtml.includes('ACL 그룹'), true);
  assert.equal(identityHtml.includes('action="/admin/identity/users/7/trust"'), true);
  assert.equal(identityHtml.includes('action="/admin/identity/users/8/unblock"'), true);
  assert.equal(identityHtml.includes('action="/admin/identity/server-owners"'), true);
  assert.equal(identityHtml.includes('action="/admin/identity/server-owners/3/revoke"'), true);
  assert.equal(identityHtml.includes('action="/admin/identity/acl-groups/trusted_editors/members"'), true);
  assert.equal(identityHtml.includes('action="/admin/identity/acl-groups/trusted_editors/members/4/remove"'), true);
  assert.equal(identityHtml.includes('/api/admin/user-trust'), false);
  assert.equal(identityHtml.includes('/api/admin/server-owners'), false);
  assert.equal(identityHtml.includes('제한'), true);
  assert.equal(identityHtml.includes('신뢰 편집자'), true);
  assert.equal(filterHtml.includes('편집 필터'), true);
  assert.equal(filterHtml.includes('class="admin-guide-panel filter-guide"'), true);
  assert.equal(filterHtml.includes('필터 처리 단계'), true);
  assert.equal(filterHtml.includes('경고/태그'), true);
  assert.equal(filterHtml.includes('검토 요청'), true);
  assert.equal(filterHtml.includes('저장 차단'), true);
  assert.equal(filterHtml.includes('action="/admin/filters"'), true);
  assert.equal(filterHtml.includes('action="/admin/filters/5"'), true);
  assert.equal(filterHtml.includes('/api/admin/edit-filters'), false);
  assert.equal(filterHtml.includes('저장 차단'), true);
  assert.equal(filterHtml.includes('검토 요청'), true);
  assert.equal(filterHtml.includes('외부 링크 수'), true);
  assert.equal(publicationHtml.includes('공개 운영'), true);
  assert.equal(publicationHtml.includes('class="admin-guide-panel publication-guide"'), true);
  assert.equal(publicationHtml.includes('공개 운영 순서'), true);
  assert.equal(publicationHtml.includes('공지/상태'), true);
  assert.equal(publicationHtml.includes('릴리즈/캠페인'), true);
  assert.equal(publicationHtml.includes('가입/정책 기준'), true);
  assert.equal(publicationHtml.includes('class="audit-summary publication-settings-summary"'), true);
  assert.equal(publicationHtml.includes('<strong>초대 가입</strong>가입 방식'), true);
  assert.equal(publicationHtml.includes('<strong>검토 후 반영</strong>신규 기여'), true);
  assert.equal(publicationHtml.includes('<strong>10회</strong>편집 제한'), true);
  assert.equal(publicationHtml.includes('<strong>2개</strong>외부 링크'), true);
  assert.equal(publicationHtml.includes('<strong>인증 또는 운영자</strong>서버 노출'), true);
  assert.equal(publicationHtml.includes('action="/admin/publication/settings"'), true);
  assert.equal(publicationHtml.includes('action="/admin/publication/announcements"'), true);
  assert.equal(publicationHtml.includes('action="/admin/publication/release-notes"'), true);
  assert.equal(publicationHtml.includes('action="/admin/publication/incidents"'), true);
  assert.equal(publicationHtml.includes('action="/admin/publication/campaigns"'), true);
  assert.equal(publicationHtml.includes('action="/admin/publication/report-sla"'), true);
  assert.equal(publicationHtml.includes('action="/admin/publication/policy-versions"'), true);
  assert.equal(publicationHtml.includes('/api/admin/announcements'), false);
  assert.equal(publicationHtml.includes('검색 지연'), true);
  assert.equal(publicationHtml.includes('조사 중'), true);
  assert.equal(publicationHtml.includes('정비'), true);
  assert.equal(publicationHtml.includes('가입 기준'), true);
  const auditHtml = auditPageHtml;
  assert.equal(auditHtml.includes('action="/admin/audits/content"'), true);
  assert.equal(auditHtml.includes('action="/admin/audits/search"'), true);
  assert.equal(auditHtml.includes('action="/admin/audits/security"'), true);
  assert.equal(auditHtml.includes('action="/admin/audits/performance"'), true);
  assert.equal(auditHtml.includes('action="/admin/audits/consistency"'), true);
  assert.equal(auditHtml.includes('action="/admin/audits/user-trust/7/evaluate"'), true);
  assert.equal(auditHtml.includes('/api/admin/content-audits'), false);
  assert.equal(auditHtml.includes('/api/admin/consistency'), false);
  assert.equal(auditHtml.includes('일관성 점검 실행'), true);
  assert.equal(auditHtml.includes('자동 보정'), true);
  assert.equal(auditHtml.includes('수정 필요'), true);
  assert.equal(auditHtml.includes('검색 순위 조정 필요'), true);
  assert.equal(auditHtml.includes('최근 바뀜'), true);
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes("app.get('/admin/audits'"), true);
  assert.equal(serverTs.includes("app.post('/admin/audits/content'"), true);
  assert.equal(serverTs.includes("app.post('/admin/audits/search'"), true);
  assert.equal(serverTs.includes("app.post('/admin/audits/security'"), true);
  assert.equal(serverTs.includes("app.post('/admin/audits/performance'"), true);
  assert.equal(serverTs.includes("app.post('/admin/audits/consistency'"), true);
  assert.equal(serverTs.includes("app.get('/admin/reports'"), true);
  assert.equal(serverTs.includes("app.post('/admin/reports/:id/resolve'"), true);
  assert.equal(serverTs.includes("app.post('/admin/pages/:id/protect'"), true);
  assert.equal(serverTs.includes("app.post('/admin/pages/:id/delete'"), true);
  assert.equal(serverTs.includes("app.get('/admin/publication'"), true);
  assert.equal(serverTs.includes("app.post('/admin/publication/announcements'"), true);
  assert.equal(serverTs.includes("app.post('/admin/publication/settings'"), true);
  assert.equal(serverTs.includes("app.patch('/api/admin/open-beta/settings'"), true);
  assert.equal(serverTs.includes('async function saveOpenBetaSettings'), true);
  assert.equal((serverTs.match(/INSERT INTO open_beta_settings/g) ?? []).length, 1);
  assert.equal(serverTs.includes("app.get('/admin/identity'"), true);
  assert.equal(serverTs.includes("app.post('/admin/identity/users/:id/trust'"), true);
  assert.equal(serverTs.includes("app.post('/admin/identity/acl-groups/:key/members'"), true);
  assert.equal(serverTs.includes("app.get('/admin/filters'"), true);
  assert.equal(serverTs.includes("app.post('/admin/filters/:id'"), true);
  assert.equal(serverTs.includes("app.post('/admin/jobs'"), true);
  assert.equal(serverTs.includes("app.post('/admin/jobs/sync-spaces'"), true);
  assert.equal(serverTs.includes("app.get('/admin/imports'"), true);
  assert.equal(serverTs.includes("app.post('/admin/imports/markdown'"), true);
  assert.equal(serverTs.includes("app.post('/admin/imports/gitbook'"), true);
  assert.equal(serverTs.includes("app.post('/admin/imports/gitbook/:id/run'"), true);
  assert.equal(serverTs.includes("app.get('/admin/subwikis'"), true);
  assert.equal(serverTs.includes("app.post('/admin/subwikis/server'"), true);
  assert.equal(serverTs.includes("app.post('/admin/subwikis/mod'"), true);
  assert.equal(serverTs.includes("app.post('/admin/subwikis/:code/status'"), true);
  assert.equal(serverTs.includes("app.post('/admin/subwikis/:code/sidebar'"), true);
  assert.equal(serverTs.includes("app.post('/admin/mod-wikis/:slug/creator-verification'"), true);
  assert.equal(serverTs.includes("app.post('/admin/servers/:pageId/status'"), true);
  assert.equal(serverTs.includes("app.post('/admin/release/rebuild-stats'"), true);
  assert.equal(serverTs.includes('async function rebuildWikiDailyStats()'), true);
  assert.equal(adminJobsPage([], user).includes('대기 중인 작업 없음'), true);
  const jobsHtml = adminJobsPage(
    [{ id: 11, job_type: 'reindex_page', payload_json: '{"pageId":9}', status: 'pending', attempts: 0, max_attempts: 3, run_after: null, created_at: '2026-05-25 12:00:00' }],
    user
  );
  assert.equal(jobsHtml.includes('action="/admin/jobs"'), true);
  assert.equal(jobsHtml.includes('admin-jobs-page'), true);
  assert.equal(jobsHtml.includes('class="admin-guide-panel jobs-guide"'), true);
  assert.equal(jobsHtml.includes('작업 큐 운용 순서'), true);
  assert.equal(jobsHtml.includes('대기/실패 확인'), true);
  assert.equal(jobsHtml.includes('필요 작업 추가'), true);
  assert.equal(jobsHtml.includes('실행 후 검증'), true);
  assert.equal(jobsHtml.includes('action="/admin/jobs/run-next"'), true);
  assert.equal(jobsHtml.includes('action="/admin/jobs/sync-spaces"'), true);
  assert.equal(jobsHtml.includes('/api/admin/jobs'), false);
  assert.equal(jobsHtml.includes('/api/admin/spaces/sync-pages'), false);
  assert.equal(jobsHtml.includes('검색 색인 갱신'), true);
  assert.equal(jobsHtml.includes('문서 #9'), true);
  assert.equal(jobsHtml.includes('작업 추가'), true);
  assert.equal(jobsHtml.includes('위키 공간 동기화'), true);
  assert.equal(jobsHtml.includes('/admin/imports'), true);
  const importOpsHtml = adminImportsPage(
    {
      spaces: [{ id: 3, code: 'server-example', title: '예시 서버', space_type: 'server_wiki', status: 'active' }],
      gitbookJobs: [{ id: 9, space_id: 3, source_type: 'markdown_zip', status: 'pending', imported_pages: 0, source_note: 'GitBook export', error_message: null, updated_at: '2026-05-25 12:00:00', space_title: '예시 서버' }],
      markdownJobs: [{ id: 10, space_id: 3, source_type: 'markdown', source_name: 'rules.md', status: 'pending', imported_pages: 0, checklist_json: '["이미지 링크 확인","공식 영역 확인"]', updated_at: '2026-05-25 12:00:00', space_title: '예시 서버' }]
    },
    user
  );
  assert.equal(importOpsHtml.includes('action="/admin/imports/gitbook"'), true);
  assert.equal(importOpsHtml.includes('admin-imports-page'), true);
  assert.equal(importOpsHtml.includes('class="admin-guide-panel imports-guide"'), true);
  assert.equal(importOpsHtml.includes('문서 이전 순서'), true);
  assert.equal(importOpsHtml.includes('대상 위키 선택'), true);
  assert.equal(importOpsHtml.includes('목차/본문 검토'), true);
  assert.equal(importOpsHtml.includes('실행 후 확인'), true);
  assert.equal(importOpsHtml.includes('action="/admin/imports/markdown"'), true);
  assert.equal(importOpsHtml.includes('action="/admin/imports/gitbook/9/run"'), true);
  assert.equal(importOpsHtml.includes('/api/admin/gitbook-imports'), false);
  assert.equal(importOpsHtml.includes('/api/admin/markdown-imports'), false);
  assert.equal(importOpsHtml.includes('Markdown 압축'), true);
  assert.equal(importOpsHtml.includes('예시 서버 · 서버 위키'), true);
  assert.equal(importOpsHtml.includes('이미지 링크 확인, 공식 영역 확인'), true);
  assert.equal(importOpsHtml.includes('>markdown_zip<'), false);
  assert.equal(importOpsHtml.includes('>pending<'), false);
  const noSpaceImportOpsHtml = adminImportsPage({ spaces: [], gitbookJobs: [], markdownJobs: [] }, user);
  assert.equal(noSpaceImportOpsHtml.includes('id="import-space-gate"'), true);
  assert.equal(noSpaceImportOpsHtml.includes('대상 위키 필요'), true);
  assert.equal(noSpaceImportOpsHtml.includes('href="/admin/subwikis"'), true);
  assert.equal(noSpaceImportOpsHtml.includes('title="대상 서버/모드 위키를 먼저 만들어야 합니다."'), true);
  assert.equal(noSpaceImportOpsHtml.includes('aria-describedby="import-space-gate"'), true);
  const subwikiOpsHtml = adminSubwikisPage(
    {
      spaces: [
        { id: 3, code: 'server-example', title: '예시 서버', slug: 'example', root_page_id: 9, space_type: 'server_wiki', status: 'active', host: 'play.example.kr', edition: 'java', verified_status: 'pending', operational_status: 'disputed', doc_count: 3, sidebar_count: 2, role_count: 1 },
        { id: 4, code: 'mod-create', title: 'Create', slug: 'create', space_type: 'mod_wiki', status: 'needs_maintainer', category: '기술', loaders: 'Forge, Fabric', supported_versions: '1.20.1', creator_verified: 0, doc_count: 7, sidebar_count: 4, role_count: 2 }
      ],
      requests: [{ id: 12, request_type: 'mod', title: '새 모드', status: 'pending', requester_username: 'editor', created_at: '2026-05-25 12:00:00' }]
    },
    user
  );
  assert.equal(subwikiOpsHtml.includes('action="/admin/subwikis/server"'), true);
  assert.equal(subwikiOpsHtml.includes('admin-subwikis-page'), true);
  assert.equal(subwikiOpsHtml.includes('class="admin-guide-panel subwikis-guide"'), true);
  assert.equal(subwikiOpsHtml.includes('서브위키 운영 순서'), true);
  assert.equal(subwikiOpsHtml.includes('신청 검토'), true);
  assert.equal(subwikiOpsHtml.includes('상태 정리'), true);
  assert.equal(subwikiOpsHtml.includes('탐색 구조 확인'), true);
  assert.equal(subwikiOpsHtml.includes('action="/admin/subwikis/mod"'), true);
  assert.equal(subwikiOpsHtml.includes('action="/admin/subwikis/server-example/status"'), true);
  assert.equal(subwikiOpsHtml.includes('action="/admin/subwikis/mod-create/sidebar"'), true);
  assert.equal(subwikiOpsHtml.includes('action="/admin/mod-wikis/create/creator-verification"'), true);
  assert.equal(subwikiOpsHtml.includes('action="/admin/servers/9/status"'), true);
  assert.equal(subwikiOpsHtml.includes('/api/admin/subwikis'), false);
  assert.equal(subwikiOpsHtml.includes('/api/admin/spaces'), false);
  assert.equal(subwikiOpsHtml.includes('/api/admin/mod-wikis'), false);
  assert.equal(subwikiOpsHtml.includes('/api/admin/servers'), false);
  assert.equal(subwikiOpsHtml.includes('서버 위키'), true);
  assert.equal(subwikiOpsHtml.includes('관리자 필요'), true);
  assert.equal(subwikiOpsHtml.includes('제작자 미확인'), true);
  assert.equal(subwikiOpsHtml.includes('분쟁 중'), true);
  assert.equal(subwikiOpsHtml.includes('>needs_maintainer<'), false);
  assert.equal(subwikiOpsHtml.includes('>disputed<'), false);
  assert.equal(subwikiOpsHtml.includes('>server_wiki<'), false);
  const reportOpsHtml = adminReportsPage(
    [
      { id: 4, target_type: 'page', page_id: 9, namespace_code: 'main', page_title: '대문', reason: 'copyright', detail: '출처 확인 필요', status: 'open', reporter_username: 'wiki-user', created_at: '2026-05-25 12:00:00' },
      { id: 5, target_type: 'file', target_id: 3, reason: 'license', status: 'reviewing', reporter_display_name: '신고자', handler_username: 'admin', created_at: '2026-05-25 12:00:00' },
      { id: 6, target_type: 'page', page_id: 9, namespace_code: 'main', page_title: '대문', reason: 'content', status: 'resolved', created_at: '2026-05-25 12:00:00' }
    ],
    user
  );
  assert.equal(reportOpsHtml.includes('action="/admin/reports/4/resolve"'), true);
  assert.equal(reportOpsHtml.includes('admin-reports-page'), true);
  assert.equal(reportOpsHtml.includes('class="admin-guide-panel reports-guide"'), true);
  assert.equal(reportOpsHtml.includes('신고 처리 순서'), true);
  assert.equal(reportOpsHtml.includes('접수 확인'), true);
  assert.equal(reportOpsHtml.includes('대상 검토'), true);
  assert.equal(reportOpsHtml.includes('상태 마감'), true);
  assert.equal(reportOpsHtml.includes('/api/admin/reports'), false);
  assert.equal(reportOpsHtml.includes('저작권'), true);
  assert.equal(reportOpsHtml.includes('라이선스'), true);
  assert.equal(reportOpsHtml.includes('문서 내용'), true);
  assert.equal(reportOpsHtml.includes('검토 중'), true);
  assert.equal(reportOpsHtml.includes('>content<'), false);
  assert.equal(reportOpsHtml.includes('>reviewing<'), false);
  assert.equal(reportOpsHtml.includes('target_type'), false);
  assert.equal(adminFilesPage({ licenseIssues: [], unusedFiles: [] }, user).includes('라이선스 확인 대상 없음'), true);
  assert.equal(adminFilesPage({ licenseIssues: [], unusedFiles: [] }, user).includes('미사용 파일 없음'), true);

  const searchOpsHtml = adminSearchPage(
    {
      failed: [{ query: '페이퍼', normalized_query: '페이퍼', attempts: 3, last_seen: '2026-05-24 12:00:00' }],
      noClicks: [],
      pins: [{ query: '페이퍼', namespace_code: 'dev', title: 'Paper API', page_id: 9, note: '', enabled: 1 }],
      disambiguations: [{ query: '페이퍼', namespace_code: 'dev', title: 'Paper API', page_id: 9, label: 'Paper API', note: '', enabled: 1 }],
      aliases: [{ alias_title: '페퍼', alias_namespace_code: 'dev', alias_type: 'typo', target_page_id: 9, target_namespace_code: 'dev', target_title: 'Paper API', created_at: '2026-05-24 12:00:00' }],
      dictionary: [
        { term: '페이퍼', action: 'alias', target_page_id: 9, namespace_code: 'dev', title: 'Paper API', note: '', enabled: 1 },
        { term: '페이퍼 서버', action: 'disambiguation', target_page_id: null, namespace_code: null, title: null, note: '', enabled: 1 },
        { term: '노이즈', action: 'ignore', target_page_id: null, namespace_code: null, title: null, note: '', enabled: 1 }
      ]
    },
    user
  );
  assert.equal(searchOpsHtml.includes('대상 page_id'), false);
  assert.equal(searchOpsHtml.includes('고정할 page_id'), false);
  assert.equal(searchOpsHtml.includes('후보 page_id'), false);
  assert.equal(searchOpsHtml.includes('대상 문서 번호'), false);
  assert.equal(searchOpsHtml.includes('문서 제목 또는 번호'), true);
  assert.equal(searchOpsHtml.includes('후보 문서 제목 또는 번호'), true);
  assert.equal(searchOpsHtml.includes('admin-search-page'), true);
  assert.equal(searchOpsHtml.includes('class="admin-guide-panel search-ops-guide"'), true);
  assert.equal(searchOpsHtml.includes('검색 정비 흐름'), true);
  assert.equal(searchOpsHtml.includes('막힌 검색어 확인'), true);
  assert.equal(searchOpsHtml.includes('문서 연결'), true);
  assert.equal(searchOpsHtml.includes('사전 정리'), true);
  assert.equal((searchOpsHtml.match(/search-admin-grid/g) ?? []).length, 3);
  assert.equal(searchOpsHtml.includes('문서 별칭'), true);
  assert.equal(searchOpsHtml.includes('action="/admin/search/aliases"'), true);
  assert.equal(searchOpsHtml.includes('/api/admin/aliases'), false);
  assert.equal(searchOpsHtml.includes('페퍼'), true);
  assert.equal(searchOpsHtml.includes('<td>오탈자</td>'), true);
  assert.equal(searchOpsHtml.includes('검색 사전'), true);
  assert.equal(searchOpsHtml.includes('문서 #9'), false);
  assert.equal(searchOpsHtml.includes('Paper API'), true);
  assert.equal(searchOpsHtml.includes('<td>개발</td>'), true);
  assert.equal(searchOpsHtml.includes('<td>alias</td>'), false);
  assert.equal(searchOpsHtml.includes('<td>disambiguation</td>'), false);
  assert.equal(searchOpsHtml.includes('<td>ignore</td>'), false);
  assert.equal(searchOpsHtml.includes('<td>별칭</td>'), true);
  assert.equal(searchOpsHtml.includes('<td>동음이의</td>'), true);
  assert.equal(searchOpsHtml.includes('<td>무시</td>'), true);
  assert.equal(serverTs.includes("app.post('/admin/search/aliases'"), true);

  const boardsHtml = projectBoardsPage([], [], [], user);
  assert.equal(boardsHtml.includes('원본 데이터'), false);
  assert.equal(boardsHtml.includes('>JSON<'), false);
  assert.equal(boardsHtml.includes('admin-project-board-page'), true);
  assert.equal(boardsHtml.includes('class="admin-guide-panel project-board-guide"'), true);
  assert.equal(boardsHtml.includes('보드 운영 순서'), true);
  assert.equal(boardsHtml.includes('보드 만들기'), true);
  assert.equal(boardsHtml.includes('작업 연결'), true);
  assert.equal(boardsHtml.includes('상태 이동'), true);
  assert.equal(boardsHtml.includes('admin-hero'), true);
  assert.equal(boardsHtml.includes('프로젝트 보드 없음'), true);
  assert.equal(boardsHtml.includes('관리 홈'), true);
  assert.equal(boardsHtml.includes('project-board-summary'), true);
  assert.equal(boardsHtml.includes('진행 항목'), true);
});

test('task and moderation pages localize workflow states', () => {
  const user = { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] } as any;
  const tasksHtml = contributorTasksPage(
    {
      assigned: [{ id: 7, title: '문서 정리', description: '표현 정리', task_type: 'cleanup', target_type: 'page', target_id: 7, target_namespace_code: 'main', target_title: '대문', target_display_title: '첫 화면', priority: 'high', status: 'assigned', due_at: '2026-05-25 12:00:00' }],
      recommended: [{ id: 8, title: '분류 추가', task_type: 'add_category', target_type: 'page', target_id: 8, target_namespace_code: 'main', target_title: '엔더맨', priority: 'normal', status: 'open', due_at: null }],
      done: []
    },
    user
  );
  assert.equal(tasksHtml.includes('문서 정리'), true);
  assert.equal(tasksHtml.includes('표현 정리'), true);
  assert.equal(tasksHtml.includes('높음'), true);
  assert.equal(tasksHtml.includes('배정됨'), true);
  assert.equal(tasksHtml.includes('문서 #7'), false);
  assert.equal(tasksHtml.includes('href="/wiki/%EB%8C%80%EB%AC%B8">문서 · 첫 화면</a>'), true);
  assert.equal(tasksHtml.includes('작업 진행 방법'), true);
  assert.equal(tasksHtml.includes('href="/wiki/%EB%8C%80%EB%AC%B8/edit"'), true);
  assert.equal(tasksHtml.includes('문서 고치기'), true);
  assert.equal(tasksHtml.includes('대상 열기'), true);
  assert.equal(tasksHtml.includes('cleanup'), false);
  assert.equal(tasksHtml.includes('assigned'), false);
  assert.equal(tasksHtml.includes('/tasks/7/complete'), true);
  assert.equal(tasksHtml.includes('/tasks/8/claim'), true);
  assert.equal(tasksHtml.includes('추천 작업 없음'), false);
  assert.equal(tasksHtml.includes('<strong>1</strong>배정'), true);
  assert.equal(tasksHtml.includes('<strong>1</strong>추천'), true);
  assert.equal(tasksHtml.includes('처음 편집하기'), true);
  const claimedTasksHtml = contributorTasksPage({ assigned: [], recommended: [], done: [] }, user, { claimed: '8' });
  assert.equal(claimedTasksHtml.includes('작업을 맡았습니다'), true);
  const completedTasksHtml = contributorTasksPage({ assigned: [], recommended: [], done: [] }, user, { completed: '7' });
  assert.equal(completedTasksHtml.includes('작업 완료 처리'), true);
  const serverTs = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  assert.equal(serverTs.includes('target_page.display_title AS target_display_title'), true);
  assert.equal(serverTs.includes("app.post('/tasks/:id/claim'"), true);
  assert.equal(serverTs.includes("app.post('/tasks/:id/complete'"), true);
  assert.equal(serverTs.includes("reply.redirect(`/tasks?claimed="), true);
  assert.equal(serverTs.includes("reply.redirect(`/tasks?completed="), true);
  assert.equal(serverTs.includes('async function contributorTaskRow'), true);

  const workHtml = adminWorkPage(
    [{ id: 3, work_type: 'server_claim', target_id: 2, claim_page_title: '예시서버', claim_status: 'pending', claim_method: 'dns', priority: 'urgent', status: 'in_progress', updated_at: '2026-05-24 12:00:00' }],
    [],
    user
  );
  assert.equal(workHtml.includes('긴급'), true);
  assert.equal(workHtml.includes('admin-work-page'), true);
  assert.equal(workHtml.includes('class="admin-guide-panel work-guide"'), true);
  assert.equal(workHtml.includes('업무 처리 순서'), true);
  assert.equal(workHtml.includes('긴급/미배정 확인'), true);
  assert.equal(workHtml.includes('대상 화면 검토'), true);
  assert.equal(workHtml.includes('상태 정리'), true);
  assert.equal(workHtml.includes('class="audit-summary work-summary"'), true);
  assert.equal(workHtml.includes('대상 열기'), true);
  assert.equal(workHtml.includes('대기'), true);
  assert.equal(workHtml.includes('진행 중'), true);
  assert.equal(workHtml.includes('서버 인증 #2'), false);
  assert.equal(workHtml.includes('<small>#3</small>'), false);
  assert.equal(workHtml.includes('>예시서버'), true);
  assert.equal(workHtml.includes('>urgent<'), false);
  assert.equal(workHtml.includes('>in_progress<'), false);

  const subwikiWorkHtml = adminWorkPage(
    [{ id: 5, work_type: 'subwiki_request', target_id: 12, subwiki_title: '테스트서버', subwiki_status: 'pending', priority: 'normal', status: 'open', updated_at: '2026-05-24 12:00:00' }],
    [],
    user
  );
  assert.equal(subwikiWorkHtml.includes('/admin/subwiki-requests/12'), true);
  assert.equal(subwikiWorkHtml.includes('테스트서버'), true);
  const emptyWorkHtml = adminWorkPage([], [], user);
  assert.equal(emptyWorkHtml.includes('열린 관리자 업무 없음'), true);
  assert.equal(emptyWorkHtml.includes('관리자 최근 바뀜'), true);

  const requestHtml = adminSubwikiRequestPage(
    {
      id: 12,
      request_type: 'server',
      title: '테스트서버',
      status: 'pending',
      note: 'slug: test\nhost: play.example.kr\nedition: java\nstarterSet: server-basic\nnote: 공식 문서 신청',
      requester_username: 'owner',
      created_at: '2026-05-24 12:00:00'
    },
    { id: 5, priority: 'normal', status: 'open' },
    user
  );
  assert.equal(requestHtml.includes('play.example.kr'), true);
  assert.equal(requestHtml.includes('/admin/subwiki-requests/12'), true);
  assert.equal(requestHtml.includes('승인하고 위키 생성'), true);
  assert.equal(requestHtml.includes('slug: test'), false);
  assert.equal(requestHtml.includes('생성 경로'), true);
  assert.equal(requestHtml.includes('/server/test'), true);
  assert.equal(requestHtml.includes('승인 전 확인'), true);
  assert.equal(requestHtml.includes('초기 문서'), true);
  const completedRequestHtml = adminSubwikiRequestPage(
    {
      id: 13,
      request_type: 'server',
      title: '완료서버',
      status: 'created',
      note: 'slug: done\nhost: play.done.kr\nedition: java',
      requester_username: 'owner',
      created_at: '2026-05-24 12:00:00'
    },
    { id: 6, priority: 'normal', status: 'done' },
    user
  );
  assert.equal(completedRequestHtml.includes('처리 완료'), true);
  assert.equal(completedRequestHtml.includes('이미 승인되어 전용 위키가 생성된 신청입니다.'), true);
  assert.equal(completedRequestHtml.includes('title="이미 승인되어 전용 위키가 생성된 신청입니다."'), true);
  assert.equal(completedRequestHtml.includes('id="subwiki-request-13-completed"'), true);
  assert.equal(completedRequestHtml.includes('aria-describedby="subwiki-request-13-completed"'), true);
  assert.equal(completedRequestHtml.includes('href="/server/done"'), true);
  assert.equal(completedRequestHtml.includes('업무 큐로 돌아가기'), true);

  const modHtml = modVerificationPage(
    [{ id: 4, title: 'Create', task_type: 'mod_link_review', status: 'in_progress', assigned_to: null, due_at: null, note: '' }],
    [],
    user
  );
  assert.equal(modHtml.includes('모드 링크 검토'), true);
  assert.equal(modHtml.includes('admin-mod-verification-page'), true);
  assert.equal(modHtml.includes('class="admin-guide-panel mod-verification-guide"'), true);
  assert.equal(modHtml.includes('모드 검증 순서'), true);
  assert.equal(modHtml.includes('대상 생성'), true);
  assert.equal(modHtml.includes('링크/버전 확인'), true);
  assert.equal(modHtml.includes('상태 마감'), true);
  assert.equal(modHtml.includes('class="audit-summary mod-verification-summary"'), true);
  assert.equal(modHtml.includes('진행 중'), true);
  assert.equal(modHtml.includes('#4'), false);
  assert.equal(modHtml.includes('>mod_link_review<'), false);
});

test('utility and admin tables hide internal status values', () => {
  const user = { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] } as any;
  const fileHtml = fileDetailPage(
    {
      id: 2,
      file_name: 'example.png',
      original_name: 'example.png',
      mime_type: 'image/png',
      size_bytes: 128,
      status: 'license_needed',
      license: 'license_needed',
      source_url: 'https://example.com/source',
      source_text: 'https://example.com/source',
      url: '/file/example.png/raw',
      sha256: 'abc123',
      usages: [{ namespace_code: 'main', title: '대문', display_title: '첫 화면', usage_context: 'document' }],
      reports: [{ id: 2, reason: '출처 없음', status: 'open', created_at: '2026-05-24 12:00:00' }]
    },
    user
  );
  assert.equal(fileHtml.includes('라이선스 필요'), true);
  assert.equal(fileHtml.includes('class="wiki-shell space-file file-detail-page"'), true);
  assert.equal(fileHtml.includes('class="file-detail-summary"'), true);
  assert.equal(fileHtml.includes('파일 확인 순서'), true);
  assert.equal(fileHtml.includes('라이선스와 출처가 문서 사용 조건에 맞는지'), true);
  assert.equal(fileHtml.includes('class="file-report-panel"'), true);
  assert.equal(fileHtml.includes('라이선스, 출처, 개인정보, 저작권 문제가 보이면'), true);
  assert.equal(fileHtml.includes('href="/admin/files">파일 관리</a>'), true);
  assert.equal(fileHtml.includes('/files/2/report'), true);
  assert.equal(fileHtml.includes('/api/files/2/report'), false);
  assert.equal(fileHtml.includes('<summary>검증 정보</summary>'), true);
  assert.equal(fileHtml.includes('라이선스 확인 필요'), true);
  assert.equal(fileHtml.includes('출처 링크'), true);
  assert.equal(fileHtml.includes('example.png · image/png'), false);
  assert.equal(fileHtml.includes('>첫 화면</a>'), true);
  assert.equal(fileHtml.includes('>대문</a>'), false);
  assert.equal(fileHtml.includes('문서 본문'), true);
  assert.equal(fileHtml.includes('>license_needed<'), false);
  assert.equal(fileHtml.includes('>document<'), false);
  const emptyFileHtml = fileDetailPage(
    {
      id: 3,
      file_name: 'unused.png',
      original_name: 'unused.png',
      mime_type: 'image/png',
      size_bytes: 128,
      status: 'normal',
      license: 'cc-by',
      source_url: '',
      source_text: '직접 제작',
      url: '/file/unused.png/raw',
      sha256: 'def456',
      usages: [],
      reports: []
    },
    user
  );
  assert.equal(emptyFileHtml.includes('사용 중인 문서 없음'), true);
  assert.equal(emptyFileHtml.includes('href="/admin/files"'), true);
  const publicEmptyFileHtml = fileDetailPage(
    {
      id: 4,
      file_name: 'public-unused.png',
      original_name: 'public-unused.png',
      mime_type: 'image/png',
      size_bytes: 128,
      status: 'normal',
      license: 'cc-by',
      source_url: '',
      source_text: '직접 제작',
      url: '/file/public-unused.png/raw',
      sha256: 'ghi789',
      usages: [],
      reports: []
    },
    { id: 2, username: 'member', display_name: '일반 사용자', groups: ['autoconfirmed'], permissions: [] } as any
  );
  assert.equal(publicEmptyFileHtml.includes('사용 중인 문서 없음'), true);
  assert.equal(publicEmptyFileHtml.includes('href="/admin/files"'), false);
  assert.equal(publicEmptyFileHtml.includes('href="/help/파일_업로드"'), true);
  assert.equal(publicEmptyFileHtml.includes('파일 사용법'), true);
  const developerEmptyFileHtml = fileDetailPage(
    {
      id: 5,
      file_name: 'developer-unused.png',
      original_name: 'developer-unused.png',
      mime_type: 'image/png',
      size_bytes: 128,
      status: 'normal',
      license: 'cc-by',
      source_url: '',
      source_text: '직접 제작',
      url: '/file/developer-unused.png/raw',
      sha256: 'jkl012',
      usages: [],
      reports: []
    },
    { id: 3, username: 'dev', display_name: '개발자', groups: ['developer'], permissions: [] } as any
  );
  assert.equal(developerEmptyFileHtml.includes('href="/admin/files"'), true);

  const operatorHtml = operatorHomePage(
    [{ work_type: 'pending_review', label: '검토 큐', count: 2, href: '/admin/work', detail: '승인 대기 중인 문서 검토' }],
    [{ id: 5, work_type: 'server_claim', target_type: 'server', target_id: 9, claim_status: 'pending', priority: 'urgent', status: 'in_progress', updated_at: '2026-05-24 12:00:00' }],
    user
  );
  assert.equal(operatorHtml.includes('/api/admin/reviews'), false);
  assert.equal(operatorHtml.includes('pending_reviews.status'), false);
  assert.equal(operatorHtml.includes('승인 대기 중인 문서 검토'), true);
  assert.equal(operatorHtml.includes('긴급'), true);
  assert.equal(operatorHtml.includes('진행 중'), true);
  assert.equal(operatorHtml.includes('>urgent<'), false);
  assert.equal(operatorHtml.includes('>in_progress<'), false);
  assert.equal(operatorHtml.includes('class="topbar nav-wrapper admin-topbar"'), true);
  assert.equal(operatorHtml.includes('MineWiki 관리'), true);

  const boardsHtml = projectBoardsPage(
    [{ id: 1, name: '문서 정비', description: '정비 작업' }],
    [{ id: 3, board_id: 1, task_id: 9, task_title: '분류 기준 정리', title: '분류 정리', status: 'todo', sort_order: 0 }],
    [{ id: 9, title: '분류 기준 정리', task_type: 'cleanup', priority: 'high', status: 'open' }],
    user
  );
  assert.equal(boardsHtml.includes('할 일'), true);
  assert.equal(boardsHtml.includes('project-kanban'), true);
  assert.equal(boardsHtml.includes('kanban-column'), true);
  assert.equal(boardsHtml.includes('보드 운영 순서'), true);
  assert.equal(boardsHtml.includes('검토 대기'), true);
  assert.equal(boardsHtml.includes('연결 작업: 분류 기준 정리'), true);
  assert.equal(boardsHtml.includes('admin-hero'), true);
  assert.equal(boardsHtml.includes('업무 큐'), true);
  assert.equal(boardsHtml.includes('작업 #9'), false);
  assert.equal(boardsHtml.includes('>#9 '), false);
  assert.equal(boardsHtml.includes('>todo<'), false);

  const reviewHtml = reviewDetailPage(
    {
      id: 7,
      status: 'pending',
      reason: '검토 필요',
      submitted_display_name: '기여자',
      draft: { namespace_code: 'main', title: '대문', content_raw: '새 내용 [[링크]]\n[[분류:테스트]]', edit_summary: '수정' },
      current: { content_raw: '기존 내용', current_revision_id: 4 }
    },
    user
  );
  assert.equal(reviewHtml.includes('검토 대기'), true);
  assert.equal(reviewHtml.includes('편집 검토 순서'), true);
  assert.equal(reviewHtml.includes('>pending<'), false);
  assert.equal(reviewHtml.includes('main:대문'), false);
  assert.equal(reviewHtml.includes('<a href="/wiki/%EB%8C%80%EB%AC%B8">위키 · 대문</a>'), true);
  assert.equal(reviewHtml.includes('<th>내부 링크</th><td>0</td><td>1</td>'), true);
  assert.equal(reviewHtml.includes('<th>분류</th><td>0</td><td>1</td>'), true);

  const adminHome = adminPage(
    { feedback: [{ id: 8, title: '검색 오류', feedback_type: 'bug', status: 'reviewing', body: '검색이 느립니다.' }] },
    user
  );
  assert.equal(adminHome.includes('오류'), true);
  assert.equal(adminHome.includes('검토 중'), true);
  assert.equal(adminHome.includes('>bug<'), false);
  assert.equal(adminHome.includes('>reviewing<'), false);

  const jobsHtml = adminJobsPage([{ id: 9, job_type: 'search_reindex', status: 'pending', attempts: 0, max_attempts: 3, run_after: null, created_at: '2026-05-24 12:00:00' }], user);
  assert.equal(jobsHtml.includes('검색 색인'), true);
  assert.equal(jobsHtml.includes('대기'), true);
  assert.equal(jobsHtml.includes('search_reindex'), false);
  assert.equal(jobsHtml.includes('>pending<'), false);

  const importsHtml = adminImportsPage(
    {
      spaces: [{ id: 4, code: 'mod-create', title: 'Create', space_type: 'mod_wiki', status: 'active' }],
      gitbookJobs: [{ id: 7, space_id: 4, source_type: 'notion_export', status: 'mapping', imported_pages: 0, source_note: 'Notion', error_message: 'parse failed', updated_at: '2026-05-24 12:00:00', space_title: 'Create' }],
      markdownJobs: [{ id: 8, space_id: 4, source_type: 'manual', source_name: 'manual', status: 'imported', imported_pages: 2, checklist_json: '[]', updated_at: '2026-05-24 12:00:00', space_title: 'Create' }]
    },
    user
  );
  assert.equal(importsHtml.includes('Notion 내보내기'), true);
  assert.equal(importsHtml.includes('매핑 중'), true);
  assert.equal(importsHtml.includes('가져옴'), true);
  assert.equal(importsHtml.includes('오류 확인 필요'), true);
  assert.equal(importsHtml.includes('>mapping<'), false);
  assert.equal(importsHtml.includes('>imported<'), false);
});

test('admin release page presents localized operational statuses', () => {
  const user = { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] } as any;
  const html = adminReleasePage(
    {
      status: {
        ready: false,
        gates: [{ status: 'not_started', count: 1 }],
        blockers: [{ status: 'open', count: 1 }],
        performance: [{ status: 'passed', count: 2 }],
        rehearsals: [{ status: 'failed', count: 1 }],
        fileLicenses: { license_needed: 3 },
        settings: { signup_mode: 'invite', new_user_review_required: true, server_listing_mode: 'verified_or_owner' }
      },
      gates: [{ gate_key: 'file_license', title: '파일 라이선스', status: 'not_started', note: '' }],
      issues: [{ id: 4, title: '검색 오류', issue_type: 'search', severity: 'critical', status: 'triaged', updated_at: '2026-05-24 12:00:00' }],
      blockers: [{ id: 5, title: '백업 확인', blocker_type: 'data_loss', severity: 'high', status: 'open', description: '백업 검증 필요' }],
      contentAudits: [{ page_id: 9, title: '대문', audit_type: 'quality', status: 'open', note: '' }],
      searchAudits: [{ query: '페이퍼', status: 'fixed', expected_page_id: 9, expected_namespace_code: 'dev', expected_title: 'Paper API', note: '' }],
      securityChecks: [{ test_key: 'permissions', severity: 'high', status: 'passed', note: '' }],
      performanceChecks: [{ check_key: 'search', target_area: 'public', status: 'passed', note: '' }],
      releaseRehearsals: [{ scenario: 'search_alias', run_key: 'run-1', status: 'passed', note: '', run_at: '2026-05-24 12:00:00', evidence_json: { raw_status: 'passed' } }]
    },
    user
  );
  assert.equal(html.includes('라이선스 검토 필요: 3'), true);
  assert.equal(html.includes('admin-release-page'), true);
  assert.equal(html.includes('class="directory-summary release-summary"'), true);
  assert.equal(html.includes('공개 전 점검 순서'), true);
  assert.equal(html.includes('블로커 확인'), true);
  assert.equal(html.includes('게이트 판정'), true);
  assert.equal(html.includes('리허설 증적'), true);
  assert.equal(html.includes('열린 블로커'), true);
  assert.equal(html.includes('실패 점검'), true);
  assert.equal(html.includes('파일 라이선스'), true);
  assert.equal(html.includes('시작 전'), true);
  assert.equal(html.includes('긴급'), true);
  assert.equal(html.includes('분류됨'), true);
  assert.equal(html.includes('데이터 손실'), true);
  assert.equal(html.includes('증적 등록됨'), true);
  assert.equal(html.includes('license_needed'), false);
  assert.equal(html.includes('unknown'), false);
  assert.equal(html.includes('raw_status'), false);
  assert.equal(html.includes('문서 #9'), false);
  assert.equal(html.includes('Paper API'), true);
  assert.equal(html.includes('#4'), false);
  assert.equal(html.includes('#5'), false);
  assert.equal(html.includes('expected_page_id'), false);
  assert.equal(html.includes('page_id'), false);
  assert.equal(html.includes('오픈 베타'), false);
  assert.equal(html.includes('베타 이슈'), false);
  assert.equal(html.includes('공개 이슈'), true);
  assert.equal(html.includes('action="/admin/release/rebuild-stats"'), true);
  assert.equal(html.includes('오늘 통계 재계산'), true);
  assert.equal(html.includes('/api/admin/stats/rebuild'), false);
  assert.equal(html.includes('<code>{'), false);
  const emptyHtml = adminReleasePage({ status: {} }, user);
  assert.equal(emptyHtml.includes('릴리즈 게이트 없음'), true);
  assert.equal(emptyHtml.includes('공개 이슈 없음'), true);
  assert.equal(emptyHtml.includes('최종 리허설 기록 없음'), true);
});

test('mod verification page links back to the canonical mod hub', () => {
  const user = { id: 1, username: 'admin', display_name: '관리자', groups: ['admin'], permissions: ['report.handle'] } as any;
  const html = modVerificationPage([], [], user);
  assert.equal(html.includes('href="/mods"'), true);
  assert.equal(html.includes('href="/mod"'), false);
  assert.equal(html.includes('원본 데이터'), false);
  assert.equal(html.includes('검증할 모드 작업 없음'), true);
  assert.equal(html.includes('오래된 모드 문서나 링크 점검'), true);
  assert.equal(html.includes('모드 검증 순서'), true);
});

function normalizeStaticPath(value: string) {
  return value.replace(/&amp;/g, '&').split('#')[0].split('?')[0] || '/';
}

function routePattern(route: string) {
  const parts = route.split('/').map((part) => {
    if (part === '') return '';
    if (part === '*') return '.*';
    if (part.startsWith(':')) return '[^/]+';
    return part.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  });
  return new RegExp(`^${parts.join('/')}$`);
}
