import type { CurrentUser } from '../auth.js';
import { config } from '../config.js';
import { escapeHtml } from '../wiki/markup.js';
import { canAccessAdminTools, navActiveSpace, pageIntentStrip, pageTitle, userRoleChrome } from './navigation.js';

export { canAccessAdminTools } from './navigation.js';

export interface SeoOptions {
  description?: string;
  canonicalPath?: string;
  imagePath?: string;
  headHtml?: string;
  bodyClass?: string;
  hideIntentStrip?: boolean;
}

export function layout(title: string, body: string, user: CurrentUser | null = null, currentSpace = '', seo: SeoOptions = {}) {
  const activeSpace = navActiveSpace(currentSpace);
  const nav = (href: string, label: string, key: string) => `<a${activeSpace === key ? ' class="active-space"' : ''} href="${href}">${label}</a>`;
  const themeToggle = '<button class="theme-toggle" type="button" data-theme-toggle aria-label="다크모드 전환" title="다크모드 전환" aria-pressed="false">◐</button>';
  const isAdminLayout = currentSpace === 'admin';
  const fullTitle = pageTitle(title, currentSpace);
  const description = seo.description ?? 'Minecraft 정보를 한국어로 정리하는 MineWiki입니다. 바닐라, 모드, 서버, 개발 문서를 함께 다룹니다.';
  const canonical = seo.canonicalPath ? new URL(seo.canonicalPath, config.baseUrl).toString() : config.baseUrl;
  const imageUrl = new URL(seo.imagePath ?? '/assets/og-image.svg', config.baseUrl).toString();
  const canManageServers = Boolean(user?.groups.some((group) => ['server_owner', 'admin', 'developer'].includes(group)) || user?.permissions.includes('server.official_edit'));
  const canHandleReports = canAccessAdminTools(user);
  const canVerifyMods = Boolean(user?.permissions.includes('mod.verify') || canHandleReports);
  const needsTurnstile = body.includes('cf-turnstile');
  const userRole = userRoleChrome(user);

  const userWorkbench = user
    ? `<details class="nav-tools">
        <summary>${escapeHtml(user.display_name)}</summary>
        <div>
          <a href="/me">내 위키</a>
          <a href="/watchlist">감시문서</a>
          <a href="/tasks">내 작업</a>
          ${canManageServers ? '<a href="/my/servers">내 서버</a>' : ''}
          <a href="/help/위키_문법">도움말</a>
          <a href="/logout">로그아웃</a>
        </div>
      </details>
      ${canVerifyMods || canHandleReports ? `<details class="nav-tools admin-tools">
        <summary>${canHandleReports ? '관리' : '검증'}</summary>
        <div>
          ${canHandleReports ? '<a class="admin-entry" href="/admin">관리 홈</a>' : ''}
          ${canVerifyMods ? '<a href="/admin/mod-verification">모드 검증</a>' : ''}
        </div>
      </details>` : ''}`
    : `<a href="/join">가입</a><a href="/login">로그인</a>`;

  const searchForm = `<form class="desktop-search" action="/search" method="get">
      <input name="q" placeholder="검색" autocomplete="off" aria-label="검색">
      <button type="submit" aria-label="검색 실행">검색</button>
    </form>`;

  const mobileSearch = `<details class="mobile-search">
      <summary aria-label="검색">🔍</summary>
      <form action="/search" method="get">
        <input name="q" placeholder="검색" autocomplete="off" autofocus>
        <button type="submit">검색</button>
      </form>
    </details>`;

  const publicNav = `${nav('/wiki', '위키', 'main')}${nav('/mods', '모드', 'mod')}${nav('/servers', '서버', 'server')}${nav('/dev', '개발', 'dev')}<a href="/recent">최근 바뀜</a><a href="/new">새 문서</a><span class="nav-separator"></span>${userWorkbench}${themeToggle}`;

  const adminNav = `<a href="/admin">운영자 홈</a><a href="/admin/recent">최근 바뀜</a><a href="/admin/reports">신고</a><a href="/admin/work">검토 큐</a><a href="/admin/jobs">작업 큐</a><a href="/admin/imports">이전 작업</a><a href="/admin/subwikis">서브위키</a><a href="/admin/audits">감사</a><a href="/admin/identity">사용자/권한</a><a href="/admin/filters">편집 필터</a><a href="/admin/publication">공개 운영</a><a href="/admin/mod-verification">모드 검증</a><a href="/admin/files">파일</a><span class="nav-separator"></span><a href="/wiki">사이트로</a>${userWorkbench}${themeToggle}`;

  /* mobile menu nav contents */
  const mobilePublicLinks = `<span class="mobile-menu-section">탐색</span><a href="/wiki">위키</a><a href="/mods">모드</a><a href="/servers">서버</a><a href="/dev">개발</a><a href="/recent">최근 바뀜</a><a href="/new">새 문서</a>${user ? `<span class="mobile-menu-section">내 메뉴</span><a href="/me">내 위키</a><a href="/watchlist">감시문서</a><a href="/tasks">내 작업</a>${canManageServers ? '<a href="/my/servers">내 서버</a>' : ''}<a href="/help/위키_문법">도움말</a><a href="/logout">로그아웃</a>${canHandleReports ? '<span class="mobile-menu-section">관리</span><a href="/admin">관리 홈</a><a href="/admin/mod-verification">모드 검증</a>' : ''}` : `<span class="mobile-menu-section">계정</span><a href="/join">가입</a><a href="/login">로그인</a>`}`;

  const mobileAdminLinks = `<span class="mobile-menu-section">관리</span><a href="/admin">운영자 홈</a><a href="/admin/recent">최근 바뀜</a><a href="/admin/reports">신고</a><a href="/admin/work">검토 큐</a><a href="/admin/jobs">작업 큐</a><a href="/admin/imports">이전 작업</a><a href="/admin/subwikis">서브위키</a><a href="/admin/audits">감사</a><a href="/admin/identity">사용자/권한</a><a href="/admin/filters">편집 필터</a><a href="/admin/publication">공개 운영</a><a href="/admin/mod-verification">모드 검증</a><a href="/admin/files">파일</a><span class="mobile-menu-section">사이트</span><a href="/wiki">사이트로 돌아가기</a>`;

  const navHtml = isAdminLayout ? adminNav : publicNav;
  const mobileNavHtml = isAdminLayout ? mobileAdminLinks : mobilePublicLinks;

  const bodyClass = `minewiki ${user ? `is-authenticated ${escapeHtml(userRole.bodyClass)}` : 'is-anonymous'}${seo.bodyClass ? ` ${escapeHtml(seo.bodyClass)}` : ''}`;
  const intentStrip = seo.hideIntentStrip ? '' : pageIntentStrip(title, currentSpace, user, isAdminLayout);

  return `<!doctype html>
<html lang="ko">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${escapeHtml(fullTitle)}</title>
  <meta name="application-name" content="MineWiki">
  <meta name="apple-mobile-web-app-title" content="MineWiki">
  <meta name="theme-color" content="#00a495">
  <meta name="description" content="${escapeHtml(description)}">
  <link rel="canonical" href="${escapeHtml(canonical)}">
  <link rel="icon" type="image/svg+xml" href="/assets/favicon.svg">
  <link rel="alternate icon" href="/assets/favicon.svg">
  <link rel="manifest" href="/assets/site.webmanifest">
  <meta property="og:site_name" content="MineWiki">
  <meta property="og:title" content="${escapeHtml(fullTitle)}">
  <meta property="og:description" content="${escapeHtml(description)}">
  <meta property="og:url" content="${escapeHtml(canonical)}">
  <meta property="og:type" content="website">
  <meta property="og:image" content="${escapeHtml(imageUrl)}">
  <meta property="og:image:alt" content="MineWiki">
  <meta name="twitter:card" content="summary_large_image">
  <meta name="twitter:site" content="@MineWiki">
  <meta name="twitter:title" content="${escapeHtml(fullTitle)}">
  <meta name="twitter:description" content="${escapeHtml(description)}">
  <meta name="twitter:image" content="${escapeHtml(imageUrl)}">
  <link rel="stylesheet" href="/assets/app.css?v=20260524-base">
  <link rel="stylesheet" href="/assets/wiki-skin.css?v=20260705-namu6">
  <link rel="stylesheet" href="/assets/styles/tokens.css?v=20260705-namu6">
  <link rel="stylesheet" href="/assets/styles/layout.css?v=20260705-namu6">
  <link rel="stylesheet" href="/assets/styles/article.css?v=20260705-namu6">
  <link rel="stylesheet" href="/assets/styles/pages/front-page.css?v=20260705-namu6">
  ${seo.headHtml ?? ''}
  <script src="/assets/theme.js" type="module"></script>
  <script src="/assets/search.js" type="module"></script>
  ${needsTurnstile ? '<script src="/assets/turnstile-loader.js?v=20260524-local-http-guard" type="module"></script>' : ''}
  ${config.nodeEnv === 'production' && config.baseUrl.startsWith('https://') ? '<script src="/assets/ads.js?v=20260524-local-guard" type="module"></script>' : ''}
</head>
<body class="${bodyClass}">
  <header class="topbar nav-wrapper${isAdminLayout ? ' admin-topbar' : ''}">
    <a class="brand" href="${isAdminLayout ? '/admin' : '/'}">MineWiki${isAdminLayout ? ' 관리' : ''}</a>
    <nav class="desktop-nav">${navHtml}</nav>
    ${isAdminLayout ? '' : searchForm}
    ${isAdminLayout ? '' : mobileSearch}
    <details class="mobile-menu">
      <summary aria-label="메뉴">☰</summary>
      <nav>${mobileNavHtml}${themeToggle}</nav>
    </details>
  </header>
  ${intentStrip}
  ${body}
  <footer class="site-footer">
    <span>MineWiki</span>
    <a href="https://discord.gg/HPh2xYjSVH" rel="noopener noreferrer">Discord</a>
    <a href="mailto:${escapeHtml(config.supportEmail)}">도움: ${escapeHtml(config.supportEmail)}</a>
  </footer>
</body>
</html>`;
}
