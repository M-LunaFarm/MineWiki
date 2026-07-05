import type { CurrentUser } from './auth.js';
import type { NamespaceCode } from './types.js';
import { config } from './config.js';
import { namespaceSpecs, wikiUrl } from './wiki/namespaces.js';
import { escapeHtml, parseMarkup, renderDocument } from './wiki/markup.js';
import { normalizeTitle } from './wiki/normalize.js';
import { canAccessAdminTools, layout } from './ui/layout.js';
export { layout } from './ui/layout.js';

interface MessagePageOptions {
  actionHref?: string;
  actionLabel?: string;
  secondaryHref?: string;
  secondaryLabel?: string;
  currentSpace?: string;
  tone?: 'notice' | 'error';
}

export function messagePage(title: string, message: string, user: CurrentUser | null = null, options: MessagePageOptions = {}) {
  const actions = [
    options.actionHref && options.actionLabel ? { href: options.actionHref, label: options.actionLabel, primary: true } : null,
    options.secondaryHref && options.secondaryLabel ? { href: options.secondaryHref, label: options.secondaryLabel, primary: false } : null
  ].filter(Boolean) as { href: string; label: string; primary: boolean }[];
  const actionHtml = actions.length
    ? `<div class="message-actions">${actions
        .map((action) => `<a class="button${action.primary ? '' : ' ghost'}" href="${escapeHtml(action.href)}">${escapeHtml(action.label)}</a>`)
        .join('')}</div>`
    : '';
  const tone = options.tone === 'error' ? ' error' : '';
  return layout(
    title,
    `<main class="narrow message-page">
      <section class="message-panel${tone}">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(message)}</p>
        ${actionHtml}
      </section>
    </main>`,
    user,
    options.currentSpace ?? ''
  );
}

export function logoutConfirmPage(user: CurrentUser | null) {
  const displayName = user ? (user.display_name || user.username) : '현재 계정';
  return layout(
    '로그아웃',
    `<main class="narrow message-page">
      <section class="message-panel">
        <h1>로그아웃</h1>
        <p>현재 계정에서 로그아웃합니다.</p>
        ${accountFlowSummary([
          { label: '대상 계정', value: displayName, detail: '이 브라우저에서 접속 중인 계정입니다.' },
          { label: '저장 상태', value: '유지', detail: '이미 저장된 편집과 감시문서는 그대로 남습니다.' },
          { label: '다음 행동', value: '확인', detail: '공용 기기에서는 로그아웃을 완료하세요.' }
        ])}
        ${accountFlowGuide('로그아웃 전 확인', [
          '작성 중인 편집 화면이 있으면 먼저 저장하거나 별도로 보관합니다.',
          '로그아웃하면 감시문서, 작업, 관리자 메뉴는 다시 로그인해야 사용할 수 있습니다.',
          '공용 기기에서는 브라우저에 저장된 자동완성 정보도 함께 확인합니다.'
        ])}
        <form class="message-actions" method="post">
          <button>로그아웃</button>
          <a class="button ghost" href="/wiki">취소</a>
        </form>
      </section>
    </main>`,
    user,
    'main'
  );
}

function accountFlowSummary(items: Array<{ label: string; value: string; detail: string }>) {
  return `<section class="account-flow-summary" aria-label="계정 흐름 요약">
    ${items.map((item) => `<span><strong>${escapeHtml(item.value)}</strong>${escapeHtml(item.label)}<small>${escapeHtml(item.detail)}</small></span>`).join('')}
  </section>`;
}

function accountFlowGuide(title: string, steps: string[]) {
  return `<section class="account-flow-guide">
    <strong>${escapeHtml(title)}</strong>
    <ol>${steps.map((step) => `<li><span>${escapeHtml(step)}</span></li>`).join('')}</ol>
  </section>`;
}

export function userDashboardPage(user: CurrentUser, wiki: any, stats: any, changes: any[] = []) {
  const userHref = `/user/${encodeURIComponent(user.username)}`;
  const sandboxHref = `${userHref}/${encodeURIComponent('연습장')}`;
  const statCards = [
    ['감시문서', stats.watch_count ?? 0, '바뀐 문서를 빠르게 확인합니다.', '/watchlist'],
    ['배정 작업', stats.assigned_task_count ?? 0, '내가 처리해야 할 문서 정비입니다.', '/tasks'],
    ['추천 작업', stats.recommended_task_count ?? 0, '바로 맡을 수 있는 공개 작업입니다.', '/tasks'],
    ['기여', stats.edit_count ?? 0, '작성하고 고친 문서 판 수입니다.', userHref]
  ]
    .map(([label, value, detail, href]) => `<a class="user-stat-card" href="${escapeHtml(String(href))}"><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(String(label))}</span><small>${escapeHtml(String(detail))}</small></a>`)
    .join('');
  const quickLinks = [
    { href: userHref, label: '사용자 문서', desc: '내 공개 사용자 문서를 확인하고 정리합니다.' },
    { href: sandboxHref, label: '연습장', desc: '문법, 표, 링크를 공개 전 미리 시험합니다.' },
    { href: '/watchlist', label: '감시문서', desc: '관심 문서의 최근 변경을 모아봅니다.' },
    { href: '/tasks', label: '내 작업', desc: '배정 작업과 추천 작업을 처리합니다.' },
    { href: '/new', label: '새 문서', desc: '위키, 모드, 서버, 개발 문서를 새로 만듭니다.' }
  ]
    .map((link) => `<a href="${escapeHtml(link.href)}"><strong>${escapeHtml(link.label)}</strong><span>${escapeHtml(link.desc)}</span></a>`)
    .join('');
  const roleBadges = [...new Set(user.groups ?? [])]
    .map((role) => `<span>${escapeHtml(roleLabel(role))}</span>`)
    .join('');
  const changeRows = changes
    .map((row) => {
      const href = wikiUrl(row.namespace_code ?? 'main', row.title ?? '');
      return `<tr>
        <td data-label="종류"><span class="tag">${escapeHtml(recentTypeLabel(String(row.change_type ?? '')))}</span></td>
        <td data-label="문서"><a href="${href}">${escapeHtml(publicDocumentTitle(row.namespace_code ?? 'main', row.title ?? '', row.display_title ?? ''))}</a></td>
        <td data-label="요약">${escapeHtml(publicRevisionSummary(row.summary))}</td>
        <td data-label="시간">${escapeHtml(formatDateTime(row.created_at))}</td>
      </tr>`;
    })
    .join('');
  return layout(
    '내 위키',
    `<main class="narrow user-dashboard">
      <section class="directory-head user-dashboard-head">
        <div>
          <span class="space-badge">계정</span>
          <h1>내 위키</h1>
          <p>${escapeHtml(user.display_name)} 계정으로 편집, 감시문서, 작업을 관리합니다.</p>
        </div>
        <div class="quick-actions"><a class="button" href="${userHref}">사용자 문서</a><a class="button ghost" href="${sandboxHref}">연습장</a></div>
      </section>
      <section class="user-stat-grid">${statCards}</section>
      <section class="user-dashboard-grid">
        <div class="public-log-section">
          <h2>바로가기</h2>
          <nav class="user-quick-links">${quickLinks}</nav>
        </div>
        <aside class="public-log-section">
          <h2>계정 상태</h2>
          <dl class="user-status-list">
            <div><dt>사용자 위키</dt><dd>${wiki ? '준비됨' : '생성 필요'}</dd></div>
            <div><dt>완료 작업</dt><dd>${escapeHtml(String(stats.completed_task_count ?? 0))}</dd></div>
            <div><dt>권한</dt><dd class="role-badge-list">${roleBadges || '<span>일반 사용자</span>'}</dd></div>
          </dl>
        </aside>
      </section>
      <section class="public-log-section">
        <h2>최근 내 기여</h2>
        ${componentTableMarkup(`<thead><tr><th>종류</th><th>문서</th><th>요약</th><th>시간</th></tr></thead><tbody>${changeRows || emptyTableRow(4, '최근 기여 없음', '문서를 편집하면 내 최근 기여가 이곳에 표시됩니다.', '/new', '새 문서 만들기')}</tbody>`)}
      </section>
    </main>`,
    user,
    'main'
  );
}

export function authPage(title: string, eyebrow: string, heading: string, body: string, user: CurrentUser | null = null) {
  return layout(
    title,
    `<main class="auth-shell">
      <section class="auth-card">
        <p class="auth-eyebrow">${escapeHtml(eyebrow)}</p>
        <h1>${escapeHtml(heading)}</h1>
        ${body}
      </section>
      ${authContextPanel(user)}
    </main>`,
    user,
    'main'
  );
}

function authContextPanel(user: CurrentUser | null) {
  const links = user
    ? [
        { href: '/me', label: '내 위키', desc: '사용자 문서' },
        { href: '/watchlist', label: '감시문서', desc: '최근 변경' },
        { href: '/tasks', label: '내 작업', desc: '배정 업무' },
        { href: '/new', label: '새 문서', desc: '작성 시작' }
      ]
    : [
        { href: '/login', label: '로그인', desc: '계정 접속' },
        { href: '/join', label: '가입', desc: '이메일 인증' },
        { href: '/forgot-password', label: '비밀번호 찾기', desc: '계정 복구' },
        { href: '/help/처음_편집하기', label: '처음 편집하기', desc: '도움말' }
      ];
  return `<aside class="auth-context" aria-label="계정 바로가기">
    <h2>계정 바로가기</h2>
    <nav>${links.map((link) => `<a href="${escapeHtml(link.href)}"><strong>${escapeHtml(link.label)}</strong><span>${escapeHtml(link.desc)}</span></a>`).join('')}</nav>
  </aside>`;
}

export function authErrorPage(title: string, message: string, linkHref = '/login', linkLabel = '로그인으로 돌아가기') {
  return authPage(
    title,
    '입력 확인',
    title,
    `<p class="auth-message auth-message-error">${escapeHtml(message)}</p>
     <div class="auth-actions"><a class="button ghost" href="${escapeHtml(linkHref)}">${escapeHtml(linkLabel)}</a></div>`
  );
}

export function emailVerificationSentPage(email: string) {
  return authPage(
    '이메일 인증',
    '메일 확인',
    '이메일 인증을 기다리는 중입니다.',
    `${accountFlowSummary([
      { label: '인증 주소', value: email, detail: '가입할 때 입력한 이메일입니다.' },
      { label: '다음 단계', value: '메일 열기', detail: '인증 링크를 열면 가입이 완료됩니다.' },
      { label: '문제 해결', value: '재시도', detail: '메일이 없으면 스팸함을 확인하고 다시 가입합니다.' }
    ])}
    ${accountFlowGuide('인증 완료 순서', [
      '메일함에서 MineWiki 인증 메일을 찾습니다.',
      '메일 안의 인증 링크를 열어 가입을 완료합니다.',
      '인증 후 로그인해서 사용자 문서와 연습장을 확인합니다.'
    ])}
    <p class="auth-message">${escapeHtml(email)} 주소로 인증 메일을 보냈습니다. 메일의 인증 링크를 열면 MineWiki 가입이 완료됩니다.</p>
    <div class="auth-actions"><a class="button" href="/login">로그인으로 돌아가기</a><a class="button ghost" href="/join">다시 가입</a></div>`
  );
}

export function invalidEmailVerificationPage() {
  return authPage(
    '이메일 인증 실패',
    '링크 확인',
    '이메일 인증 링크를 사용할 수 없습니다.',
    `${accountFlowSummary([
      { label: '인증 상태', value: '실패', detail: '링크가 올바르지 않거나 만료되었습니다.' },
      { label: '권장 행동', value: '다시 가입', detail: '새 인증 메일을 받아 가입을 진행합니다.' },
      { label: '도움말', value: '계정', detail: '반복 실패하면 계정 도움말을 확인합니다.' }
    ])}
    ${accountFlowGuide('다시 인증하는 순서', [
      '이전에 열었던 오래된 인증 메일을 닫습니다.',
      '가입 화면에서 이메일을 다시 입력해 새 인증 메일을 받습니다.',
      '가장 최근에 받은 메일의 링크만 엽니다.'
    ])}
    <p class="auth-message auth-message-error">인증 링크가 올바르지 않거나 만료되었습니다. 다시 가입하거나 지원 메일로 문의하세요.</p>
    <div class="auth-actions"><a class="button" href="/join">다시 가입</a><a class="button ghost" href="/help/계정">계정 도움말</a></div>`
  );
}

export function passwordResetSentPage() {
  return authPage(
    '비밀번호 재설정',
    '메일 확인',
    '비밀번호 재설정 안내를 보냈습니다.',
    `${accountFlowSummary([
      { label: '요청 상태', value: '접수', detail: '일치하는 계정이 있으면 메일이 발송됩니다.' },
      { label: '유효 시간', value: '1시간', detail: '재설정 링크는 제한된 시간만 사용할 수 있습니다.' },
      { label: '다음 단계', value: '메일 확인', detail: '링크를 열고 새 비밀번호를 저장합니다.' }
    ])}
    ${accountFlowGuide('비밀번호 재설정 순서', [
      '메일함에서 MineWiki 비밀번호 재설정 메일을 찾습니다.',
      '1시간 안에 링크를 열고 새 비밀번호를 입력합니다.',
      '재설정 후 새 비밀번호로 다시 로그인합니다.'
    ])}
    <p class="auth-message">입력한 이메일과 일치하는 계정이 있으면 재설정 링크가 발송됩니다. 링크는 1시간 동안만 사용할 수 있습니다.</p>
     <div class="auth-actions"><a class="button" href="/login">로그인으로 돌아가기</a></div>`
  );
}

export function invalidPasswordResetPage() {
  return authPage(
    '비밀번호 재설정 실패',
    '링크 만료',
    '재설정 링크를 사용할 수 없습니다.',
    `${accountFlowSummary([
      { label: '링크 상태', value: '만료', detail: '이미 사용했거나 시간이 지난 링크입니다.' },
      { label: '권장 행동', value: '재요청', detail: '새 재설정 메일을 받아 다시 진행합니다.' },
      { label: '보안', value: '확인', detail: '원치 않는 요청이면 비밀번호를 바꾸지 않아도 됩니다.' }
    ])}
    ${accountFlowGuide('다시 요청하는 순서', [
      '비밀번호 찾기 화면에서 이메일을 다시 입력합니다.',
      '새로 받은 재설정 메일의 링크만 사용합니다.',
      '반복 실패하면 계정 도움말을 확인합니다.'
    ])}
    <p class="auth-message">링크가 잘못되었거나 만료되었습니다. 다시 요청해 주세요.</p>
     <div class="auth-actions"><a class="button" href="/forgot-password">다시 요청</a></div>`
  );
}

export function turnstileErrorPage(user: CurrentUser | null) {
  return messagePage('자동 검증 실패', 'Cloudflare Turnstile 확인에 실패했습니다. 페이지를 새로고침한 뒤 다시 시도하세요.', user, {
    tone: 'error'
  });
}

export function turnstileWidget(action: string) {
  if (!config.turnstile.siteKey || !config.baseUrl.startsWith('https://')) return '';
  return `<div class="turnstile-box">
    <div class="cf-turnstile" data-sitekey="${escapeHtml(config.turnstile.siteKey)}" data-action="${escapeHtml(action)}"></div>
  </div>`;
}

function renderSidebarTree(items: any[], namespace: NamespaceCode) {
  const children = new Map<string, any[]>();
  const ids = new Set(items.map((item) => String(item.id)));
  for (const item of items) {
    const parentId = item.parent_id ? String(item.parent_id) : '';
    const key = parentId && ids.has(parentId) ? parentId : 'root';
    children.set(key, [...(children.get(key) ?? []), item]);
  }
  const renderBranch = (parentKey: string, level: number, trail: Set<string>): string => {
    const rows = children.get(parentKey) ?? [];
    if (!rows.length) return '';
    const listClass = `sidebar-tree-list sidebar-tree-level-${Math.min(level, 6)}`;
    return `<ul class="${listClass}">${rows
      .map((item) => {
        const id = String(item.id);
        const nextTrail = new Set(trail);
        const isCycle = nextTrail.has(id);
        if (!isCycle) nextTrail.add(id);
        const href = sidebarItemHref(item, namespace);
        const label = escapeHtml(item.label ?? item.display_title ?? item.target_title ?? item.title ?? '문서');
        const link = `<a class="sidebar-tree-link sidebar-tree-depth-${Math.min(level, 6)}" href="${href}">
          <span class="sidebar-tree-marker" aria-hidden="true"></span>
          <span class="sidebar-tree-label">${label}</span>
        </a>`;
        const childHtml = isCycle ? '' : renderBranch(id, level + 1, nextTrail);
        if (!childHtml) return `<li class="sidebar-tree-item is-leaf">${link}</li>`;
        return `<li class="sidebar-tree-item has-children"><details class="sidebar-tree-branch" open><summary>${link}</summary><div class="sidebar-tree-children">${childHtml}</div></details></li>`;
      })
      .join('')}</ul>`;
  };
  const treeHtml = renderBranch('root', 0, new Set());
  return `<nav class="sidebar-tree-root" aria-label="문서 트리"><details class="sidebar-tree-root-details" open><summary>문서 트리</summary>${treeHtml}</details></nav>`;
}

function sidebarItemHref(item: any, namespace: NamespaceCode) {
  const targetUrl = safeSidebarHref(item.target_url);
  if (targetUrl) return targetUrl;
  return wikiUrl(namespace, item.target_title ?? item.label);
}

function categoryUrl(title: string) {
  return `/category/${encodeURIComponent(title.replace(/ /g, '_'))}`;
}

function safeSidebarHref(value: unknown) {
  const href = String(value ?? '').trim();
  if (!href) return '';
  if (href.startsWith('/') && !href.startsWith('//') && !/[\u0000-\u001f\u007f]/.test(href)) return escapeHtml(href);
  try {
    const url = new URL(href);
    return ['http:', 'https:'].includes(url.protocol) ? escapeHtml(url.toString()) : '';
  } catch {
    return '';
  }
}

function safeLocalHref(value: unknown, fallback = '/') {
  const href = String(value ?? fallback).trim() || fallback;
  if (!href.startsWith('/') || href.startsWith('//') || /[\u0000-\u001f\u007f]/.test(href)) return fallback;
  return escapeHtml(href);
}

function publicSectionLinks(namespace: NamespaceCode) {
  const items: Array<[NamespaceCode, string, string]> = [
    ['main', '위키', '/wiki'],
    ['mod', '모드', '/mods'],
    ['server', '서버', '/servers'],
    ['dev', '개발', '/dev']
  ];
  return items.map(([code, label, href]) => `<a${code === namespace ? ' class="current"' : ''} href="${href}">${label}</a>`).join('');
}

function isUserWikiTitle(title: unknown) {
  return String(title ?? '').startsWith('사용자:');
}

function userWikiDisplayTitle(title: unknown, fallback: unknown = '') {
  const value = String(title ?? fallback ?? '');
  if (!isUserWikiTitle(value)) return String(fallback || value);
  const subPath = value.slice('사용자:'.length).split('/').slice(1).join('/');
  return subPath || '사용자 문서';
}

function publicDocumentTitle(namespace: unknown, title: unknown, displayTitle: unknown = '') {
  const namespaceCode = String(namespace ?? '');
  const canonical = String(title ?? '');
  if (namespaceCode === 'main' && isUserWikiTitle(canonical)) return userWikiDisplayTitle(canonical, displayTitle);
  return String(displayTitle || canonical);
}

function protectionBadges(page: any) {
  const level = String(page.protection_level ?? 'open');
  const namespace = String(page.namespace_code ?? 'main');
  const badges: Array<{ label: string; detail: string; tone?: string }> = [];
  if (level === 'open') badges.push({ label: '누구나 편집 가능', detail: '로그인한 사용자는 이 문서를 바로 편집할 수 있습니다.' });
  else if (level === 'login_required') badges.push({ label: '로그인 필요', detail: '비회원 편집은 허용하지 않습니다.' });
  else if (level === 'review_required') badges.push({ label: '검토 후 반영', detail: '편집은 가능하지만 공개 전 운영자 검토를 거칩니다.', tone: 'review' });
  else if (level === 'autoconfirmed_only') badges.push({ label: '자동 인증 사용자 이상', detail: '자동 인증 사용자 이상은 즉시 반영되고, 신규 사용자는 검토가 필요합니다.', tone: 'review' });
  else if (level === 'trusted_only') badges.push({ label: '보호됨', detail: '신뢰 사용자 이상만 편집할 수 있습니다.', tone: 'locked' });
  else if (namespace === 'main' && isUserWikiTitle(page.title)) badges.push({ label: '사용자 문서', detail: '본인과 관리자만 수정할 수 있습니다.', tone: 'locked' });
  else if (level === 'official_only' || level === 'owner_only') badges.push({ label: '공식 영역', detail: '인증된 담당자는 바로 수정할 수 있고, 일반 사용자의 수정은 검토가 필요합니다.', tone: 'official' });
  else if (level === 'admin_only') badges.push({ label: '관리자 전용', detail: '관리자만 수정할 수 있습니다.', tone: 'locked' });
  else if (level === 'locked') badges.push({ label: '보호됨', detail: '현재 읽기 전용으로 잠겨 있습니다.', tone: 'locked' });
  if (namespace === 'dev') badges.push({ label: '개발 위키', detail: '버전 기준과 출처 확인이 필요한 개발 문서입니다.' });
  if (namespace === 'main' && String(page.title ?? '').startsWith('사용자:')) {
    badges.push({ label: '사용자 위키', detail: '이 문서는 사용자의 개인 작업 공간이며 공식 문서가 아닙니다.', tone: 'review' });
  }
  if (namespace === 'main' && /\/(연습장|작업목록|초안|메모)(\/|$)/.test(String(page.title ?? ''))) {
    badges.push({ label: '검색 제한', detail: '연습장, 초안, 메모 문서는 기본 검색에서 낮은 우선순위로 처리됩니다.', tone: 'review' });
  }
  if (namespace === 'server' && String(page.title ?? '').includes('/')) badges.push({ label: '공식 영역', detail: '서버 운영자가 통제할 수 있는 서버 위키 문서입니다.', tone: 'official' });
  if (String(page.status ?? '') === 'protected' && ['review_required', 'autoconfirmed_only'].includes(level)) badges.push({ label: '반달 대응 강화', detail: '최근 문제 편집 대응을 위해 편집 제한이 강화될 수 있습니다.', tone: 'vandal' });
  return `<div class="permission-badges">${badges
    .map(
      (badge) => `<details class="permission-badge ${badge.tone ?? ''}"><summary>${escapeHtml(badge.label)}</summary><div>${escapeHtml(badge.detail)}<br><a href="${wikiUrl(page.namespace_code, page.title)}/acl">ACL 보기</a></div></details>`
    )
    .join('')}</div>`;
}

function articleActionTabs(namespace: NamespaceCode, title: string, active: 'read' | 'edit' | 'history' | 'discussion' | 'acl' | 'raw' | 'new', isSubwikiRoot = false) {
  const { rootPrefix } = subwikiRootInfo(namespace, title);
  const pagePath = isSubwikiRoot && rootPrefix ? wikiUrl(namespace, rootPrefix) : wikiUrl(namespace, title);
  const sectionActive = active === 'discussion' ? 'discussion' : 'read';
  const link = (key: typeof active, href: string, label: string, isActive = active === key) => `<a${isActive ? ' class="active"' : ''} href="${href}">${label}</a>`;
  const readLabel = isSubwikiRoot ? '대문' : '문서';
  const identityLinks = [
    link('read', pagePath, readLabel, sectionActive === 'read'),
    link('discussion', `${pagePath}/discussion`, '토론', sectionActive === 'discussion')
  ];
  const toolLinks = [
    link('edit', `${pagePath}/edit`, '편집'),
    link('history', `${pagePath}/history`, '역사'),
    link('raw', `${pagePath}/raw`, '원문')
  ];
  if (isSubwikiRoot) toolLinks.push(link('new', `${pagePath}/new`, '새 문서'));
  toolLinks.push(link('acl', `${pagePath}/acl`, 'ACL'));
  return `<span class="document-mode-tabs">${identityLinks.join('')}</span><span class="document-tool-links">${toolLinks.join('')}</span>`;
}

function articleWatchControl(page: any, user: CurrentUser | null) {
  const pageId = Number(page?.id ?? 0);
  if (!user || !pageId) return '';
  const nextPath = wikiUrl((page.namespace_code ?? 'main') as NamespaceCode, String(page.title ?? ''));
  const watched = Boolean(page.is_watched);
  const watchDiscussion = Boolean(page.watch_discussion);
  if (!watched) {
    return `<span class="article-watch-control"><form method="post" action="/watchlist/${escapeHtml(String(pageId))}">
      <input type="hidden" name="watchDiscussion" value="1">
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}">
      <button type="submit">감시</button>
    </form></span>`;
  }
  return `<span class="article-watch-control is-watched">
    <form method="post" action="/watchlist/${escapeHtml(String(pageId))}">
      <input type="hidden" name="watchDiscussion" value="${watchDiscussion ? '0' : '1'}">
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}">
      <button type="submit">${watchDiscussion ? '토론 끄기' : '토론 포함'}</button>
    </form>
    <form method="post" action="/watchlist/${escapeHtml(String(pageId))}/remove">
      <input type="hidden" name="next" value="${escapeHtml(nextPath)}">
      <button class="button ghost" type="submit">감시 해제</button>
    </form>
  </span>`;
}

function documentToolTabs(namespace: NamespaceCode, title: string, active: 'read' | 'edit' | 'history' | 'discussion' | 'acl' | 'raw' | 'new') {
  const { isSubwikiRoot } = subwikiRootInfo(namespace, title);
  return `<div class="article-actions document-tool-tabs">
          ${articleActionTabs(namespace, title, active, isSubwikiRoot)}
        </div>`;
}

type EditorTemplateItem = { key: string; label: string; form?: boolean };
type EditorTemplateGroup = { title: string; items: EditorTemplateItem[] };

function editorTemplateTools(namespace: NamespaceCode, pageType: string): EditorTemplateGroup[] {
  const common: EditorTemplateGroup = {
    title: '공통',
    items: [
      { key: 'document_status', label: '문서 상태' },
      { key: 'warning_box', label: '경고 박스' },
      { key: 'official_doc_link', label: '공식 문서 링크', form: true }
    ]
  };
  const minecraft: EditorTemplateGroup = {
    title: 'Minecraft',
    items: [
      { key: 'block_info', label: '블록 정보', form: true },
      { key: 'item_info', label: '아이템 정보', form: true },
      { key: 'mob_info', label: '몹 정보', form: true },
      { key: 'crafting_recipe', label: '조합법', form: true },
      { key: 'smelting_recipe', label: '제련법', form: true },
      { key: 'drop_table', label: '드롭 표', form: true },
      { key: 'villager_trade', label: '주민 거래', form: true },
      { key: 'edition_diff', label: '에디션 차이', form: true },
      { key: 'version_history', label: '버전 역사', form: true },
      { key: 'command_info', label: '명령어 정보', form: true }
    ]
  };
  const mod: EditorTemplateGroup = {
    title: '모드',
    items: [
      { key: 'mod_info', label: '모드 정보', form: true },
      { key: 'mod_version_table', label: '모드 버전표', form: true },
      { key: 'dependency_info', label: '의존성 정보', form: true },
      { key: 'version_support', label: '버전 지원표', form: true }
    ]
  };
  const server: EditorTemplateGroup = {
    title: '서버',
    items: [
      { key: 'server_info', label: '서버 정보', form: true },
      { key: 'version_support', label: '버전 지원표', form: true }
    ]
  };
  const developer: EditorTemplateGroup = {
    title: '개발',
    items: [
      { key: 'develop_status', label: '개발 문서 상태', form: true },
      { key: 'api_info', label: 'API 정보', form: true },
      { key: 'packet_info', label: '패킷 정보', form: true },
      { key: 'data_type_info', label: '데이터 타입', form: true },
      { key: 'code_example', label: '코드 예제', form: true },
      { key: 'gradle_setup', label: 'Gradle', form: true },
      { key: 'maven_setup', label: 'Maven', form: true },
      { key: 'nbt_structure', label: 'NBT 구조', form: true },
      { key: 'protocol_fields', label: '프로토콜 필드', form: true },
      { key: 'dependency_info', label: '의존성 정보', form: true }
    ]
  };
  if (namespace === 'dev' || pageType === 'dev') return [common, developer];
  if (namespace === 'data' || pageType === 'data') {
    return [common, {
      title: '데이터',
      items: [
        { key: 'data_type_info', label: '데이터 타입', form: true },
        { key: 'version_support', label: '버전 지원표', form: true },
        { key: 'nbt_structure', label: 'NBT 구조', form: true },
        { key: 'protocol_fields', label: '프로토콜 필드', form: true }
      ]
    }];
  }
  if (namespace === 'mod' || namespace === 'modpack' || pageType === 'mod') return [common, mod];
  if (namespace === 'server' || pageType === 'server') return [common, server];
  if (namespace === 'template' || pageType === 'policy') return [common];
  return [common, minecraft];
}

function editorTemplateToolsHtml(namespace: NamespaceCode, pageType: string) {
  const groups = editorTemplateTools(namespace, pageType);
  const formKeys = groups.flatMap((group) => group.items).filter((item) => item.form).map((item) => item.key);
  const groupsHtml = groups
    .map((group) => `<section class="component-tool-group">
      <strong>${escapeHtml(group.title)}</strong>
      <div>${group.items.map((item) => `<button type="button" data-template="${escapeHtml(item.key)}">${escapeHtml(item.label)}</button>`).join('')}</div>
    </section>`)
    .join('');
  return {
    groupsHtml,
    formKeys
  };
}

function componentTableMarkup(content: string, extraClass = '') {
  const classes = ['component-table', extraClass].filter(Boolean).join(' ');
  return `<div class="data-table-wrap"><table class="${classes}">${content}</table></div>`;
}

function emptyTableRow(colspan: number, title: string, detail: string, actionHref = '', actionLabel = '') {
  const action = actionHref && actionLabel ? `<a class="empty-table-action" href="${escapeHtml(actionHref)}">${escapeHtml(actionLabel)}</a>` : '';
  return `<tr><td class="empty-table-cell" colspan="${colspan}"><strong>${escapeHtml(title)}</strong><span> ${escapeHtml(detail)}</span>${action ? ` ${action}` : ''}</td></tr>`;
}

function subwikiRootInfo(namespace: NamespaceCode, title: unknown) {
  const rawTitle = String(title ?? '');
  const rootPrefix = ['mod', 'server'].includes(namespace) ? rawTitle.split('/')[0] : '';
  const normalizedTitle = normalizeTitle(rawTitle);
  const normalizedRoot = normalizeTitle(rootPrefix);
  const normalizedRootHome = normalizeTitle(`${rootPrefix}/대문`);
  return {
    rootPrefix,
    isSubwikiRoot: Boolean(rootPrefix && (normalizedTitle === normalizedRoot || normalizedTitle === normalizedRootHome))
  };
}

function recentScopeHref(namespace: NamespaceCode, rootPrefix: string) {
  if (!rootPrefix) return '/recent';
  return `/recent?namespace=${encodeURIComponent(namespace)}&prefix=${encodeURIComponent(rootPrefix)}`;
}

function recentSidebarBlock(recentRows: any[], namespace: NamespaceCode, rootPrefix: string, moreHref: string, moreLabel: string) {
  const recentLinks = recentRows
    .filter((row: any) => {
      const title = String(row.title ?? '');
      return !rootPrefix || (row.namespace_code === namespace && (title === rootPrefix || title.startsWith(`${rootPrefix}/`)));
    })
    .slice(0, rootPrefix ? 3 : 12)
    .map((row: any) => `<a class="recent-item" href="${wikiUrl(row.namespace_code, row.title)}">[${escapeHtml(formatDateTime(row.created_at, ''))}] ${escapeHtml(publicDocumentTitle(row.namespace_code, row.title, row.display_title))}</a>`)
    .join('');
  return `<section class="sidebar-section sidebar-recent" aria-label="최근 변경">
    <strong>최근 변경</strong>
    <div class="sidebar-recent-list">${recentLinks || '<span class="sidebar-muted">최근 변경 없음</span>'}</div>
    <a class="live-recent-more" href="${escapeHtml(moreHref)}">${escapeHtml(moreLabel)}</a>
  </section>`;
}

function renderArticleToc(headings: Array<{ level: number; id?: string; anchor?: string; text?: string; title?: string }>, lockMap: Map<string, any>) {
  type TocNode = {
    level: number;
    anchor: string;
    label: string;
    lock: any;
    children: TocNode[];
  };
  const roots: TocNode[] = [];
  const stack: TocNode[] = [];
  for (const heading of headings) {
    const anchor = String(heading.id ?? heading.anchor ?? '');
    const label = String(heading.text ?? heading.title ?? '').trim();
    if (!anchor || !label) continue;
    const level = Math.min(6, Math.max(1, Number(heading.level) || 1));
    const node: TocNode = {
      level,
      anchor,
      label,
      lock: lockMap.get(anchor),
      children: []
    };
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else roots.push(node);
    stack.push(node);
  }
  const renderNodes = (nodes: TocNode[], level: number, prefix: number[] = []): string => `<ol class="article-toc-list article-toc-level-${Math.min(level, 6)}">${nodes
    .map((node, index) => {
      const ordinalParts = [...prefix, index + 1];
      const ordinal = `${ordinalParts.join('.')}.`;
      return `<li class="article-toc-item toc-l${node.level}${node.children.length ? ' has-children' : ''}">
      <a class="toc-l${node.level} article-toc-link" href="#${escapeHtml(node.anchor)}">
        <span class="article-toc-number" aria-hidden="true">${escapeHtml(ordinal)}</span>
        <span class="article-toc-label">${escapeHtml(node.label)}${node.lock ? ` <span class="lock-badge">${escapeHtml(sectionLockLabel(node.lock.lock_type))}</span>` : ''}</span>
      </a>
      ${node.children.length ? `<div class="article-toc-children">${renderNodes(node.children, node.level + 1, ordinalParts)}</div>` : ''}
    </li>`;
    })
    .join('')}</ol>`;
  return roots.length ? `<nav class="article-toc-tree" aria-label="문서 목차">${renderNodes(roots, roots[0]?.level ?? 2)}</nav>` : '<span class="sidebar-muted">목차 없음</span>';
}

function wikiSidebarHtml(page: any, namespace: NamespaceCode, profile: ReturnType<typeof spaceProfile>, rootPrefix: string, pagePath: string) {
  const recentRows = Array.isArray(page.recentRows) ? page.recentRows : [];
  const spaceLinks = page.sidebarItems?.length
    ? `<strong>${escapeHtml(profile.label)}</strong>${renderSidebarTree(page.sidebarItems, namespace)}`
    : `<strong>${escapeHtml(profile.label)}</strong><span class="sidebar-muted">이 공간의 문서를 탐색합니다.</span>`;
  const devSearch = namespace === 'dev'
    ? `<strong>개발 문서 검색</strong>
        <form class="sidebar-search" action="/search" method="get">
          <input name="q" placeholder="Paper API, NBT, VarInt">
          <input type="hidden" name="space" value="dev">
          <button>검색</button>
        </form>`
    : '';
  const localSearch = rootPrefix
    ? `<strong>이 위키 검색</strong>
        <form class="sidebar-search" action="/search" method="get">
          <input name="q" placeholder="${escapeHtml(rootPrefix)} 검색">
          <input type="hidden" name="space" value="${escapeHtml(namespace)}">
          <input type="hidden" name="prefix" value="${escapeHtml(rootPrefix)}">
          <button>검색</button>
        </form>`
    : '';
  return `<aside class="wiki-sidebar">
        ${rootPrefix ? '' : recentSidebarBlock(recentRows, namespace, rootPrefix, '/recent', '더 보기')}
        ${rootPrefix ? '' : '<strong>탐색</strong>'}
        ${rootPrefix ? '' : publicSectionLinks(namespace)}
        ${spaceLinks}
        ${devSearch}
        ${localSearch}
        ${rootPrefix ? recentSidebarBlock(recentRows, namespace, rootPrefix, recentScopeHref(namespace, rootPrefix), '더 보기') : ''}
      </aside>`;
}

function wikiPageContext(page: any) {
  const namespace = (page.namespace_code ?? 'main') as NamespaceCode;
  const profile = spaceProfile(namespace, page.title);
  const { rootPrefix, isSubwikiRoot } = subwikiRootInfo(namespace, page.title);
  const displayTitle = namespace === 'main' && isUserWikiTitle(page.title) ? userWikiDisplayTitle(page.title, page.display_title) : String(page.display_title ?? page.title ?? '');
  const titleLooksLikeRootHome = rootPrefix && normalizeTitle(String(page.title ?? '')) === normalizeTitle(`${rootPrefix}/대문`);
  const rootDisplayTitle = titleLooksLikeRootHome && (!displayTitle || normalizeTitle(displayTitle) === normalizeTitle('대문') || normalizeTitle(displayTitle) === normalizeTitle(String(page.title ?? '')))
    ? rootPrefix
    : displayTitle || rootPrefix;
  const visibleTitle = isSubwikiRoot
    ? `${rootDisplayTitle} 위키`
    : rootPrefix && displayTitle.includes('/')
      ? displayTitle.split('/').pop() || displayTitle
      : displayTitle;
  const pagePath = isSubwikiRoot && rootPrefix ? wikiUrl(namespace, rootPrefix) : wikiUrl(namespace, page.title);
  return {
    namespace,
    profile,
    rootPrefix,
    isSubwikiRoot,
    displayTitle,
    visibleTitle,
    pagePath,
    wikiSidebar: wikiSidebarHtml(page, namespace, profile, rootPrefix, pagePath),
    serverTheme: serverThemeChrome(page.subwikiTheme)
  };
}

function documentToolChrome(page: any, className: string) {
  const { namespace, profile, rootPrefix, wikiSidebar, serverTheme } = wikiPageContext(page);
  if (!rootPrefix) {
    return {
      namespace,
      profile,
      serverTheme,
      open: `<main class="narrow ${className}">`,
      close: '</main>'
    };
  }
  return {
    namespace,
    profile,
    serverTheme,
    open: `<main class="wiki-shell skin-space space-${profile.key} tool-shell">
      ${wikiSidebar}
      <article class="article tool-article ${className}">`,
    close: '</article></main>'
  };
}

export function articlePage(page: any, user: CurrentUser | null) {
  const { namespace, profile, rootPrefix, isSubwikiRoot, visibleTitle, pagePath, wikiSidebar, serverTheme } = wikiPageContext(page);
  const categories = safeJson<string>(page.categories_json).map((category) => `<a href="${categoryUrl(category)}">${escapeHtml(category)}</a>`).join('');
  const headings = safeJson<{ level: number; id?: string; anchor?: string; text?: string; title?: string }>(page.toc_json);
  const components = safeJson<{ name: string; props: Record<string, string> }>(page.components_json);
  const locks = Array.isArray(page.sectionLocks) ? page.sectionLocks : [];
  const lockMap = new Map<string, any>(locks.map((lock: any) => [String(lock.anchor), lock]));
  const toc = renderArticleToc(headings, lockMap);
  const aclPath = `${pagePath}/acl`;
  const rollbackForm = user && page.view_revision_id
    ? `<form method="post" action="${pagePath}/rollback">
        <input type="hidden" name="revisionId" value="${escapeHtml(String(page.view_revision_id))}">
        <button type="submit">이 판으로 되돌리기</button>
      </form>`
    : '';
  const oldRevisionNotice = page.view_revision_id
    ? `<aside class="doc-status old-revision"><strong>과거 판</strong><span>r${escapeHtml(String(page.view_revision_no))} · ${escapeHtml(formatDateTime(page.view_revision_created_at))} 저장본입니다.</span><div class="quick-actions">${page.previous_revision_id ? `<a class="button ghost" href="${pagePath}?oldid=${escapeHtml(String(page.previous_revision_id))}">이전 판</a>` : ''}${page.next_revision_id ? `<a class="button ghost" href="${pagePath}?oldid=${escapeHtml(String(page.next_revision_id))}">다음 판</a>` : ''}<a class="button ghost" href="${pagePath}/diff?from=${escapeHtml(String(page.view_revision_id))}&to=${escapeHtml(String(page.current_revision_id ?? page.view_revision_id))}">현재 판과 비교</a><a class="button" href="${pagePath}">현재 판 보기</a>${rollbackForm}</div></aside>`
    : '';
  const canProtect = Boolean(user?.permissions.includes('page.protect') || user?.groups.includes('developer'));
  const canDelete = Boolean(user?.permissions.includes('page.delete') || user?.groups.includes('developer'));
  const canMove = Boolean(user?.permissions.includes('page.move') || user?.groups.includes('developer'));
  const lockRows = locks
    .map(
      (lock: any) => `<tr><td>${escapeHtml(lock.heading)}</td><td>${escapeHtml(sectionLockLabel(lock.lock_type))}</td><td>${escapeHtml(lock.reason ?? '')}</td><td><form method="post" action="/admin/pages/${escapeHtml(String(page.id))}/section-locks/${encodeURIComponent(lock.anchor)}/unlock"><button>해제</button></form></td></tr>`
    )
    .join('');
  const lockOptions = headings
    .map((heading) => {
      const anchor = String(heading.id ?? heading.anchor ?? '');
      return `<option value="${escapeHtml(anchor)}">${escapeHtml(heading.text ?? heading.title ?? anchor)}</option>`;
    })
    .join('');
  const lockPanel = canProtect
    ? `<details class="sidebar-admin-tools">
        <summary>문단 잠금</summary>
        <div class="section-lock-panel">
          <form method="post" action="/admin/pages/${escapeHtml(String(page.id))}/section-locks">
            <select name="anchor">${lockOptions}</select>
            <select name="lockType"><option value="admin_only">${sectionLockLabel('admin_only')}</option><option value="owner_only">${sectionLockLabel('owner_only')}</option><option value="trusted_only">${sectionLockLabel('trusted_only')}</option><option value="locked">${sectionLockLabel('locked')}</option></select>
            <input name="reason" placeholder="사유">
            <button>잠금</button>
          </form>
          ${componentTableMarkup(`<tbody>${lockRows || '<tr><td>잠긴 문단 없음</td></tr>'}</tbody>`)}
        </div>
      </details>`
    : locks.length
      ? `<strong>문단 잠금</strong>${locks.map((lock: any) => `<span>${escapeHtml(lock.heading)} · ${escapeHtml(sectionLockLabel(lock.lock_type))}</span>`).join('')}`
      : '';
  const pageManagePanel = canMove
    ? `<details class="sidebar-admin-tools">
        <summary>문서 정리</summary>
        <div class="section-lock-panel">
          <form method="post" action="/admin/pages/${escapeHtml(String(page.id))}/split-section">
            <select name="anchor">${lockOptions}</select>
            <input name="targetTitle" placeholder="분리할 문서명">
            <label><input type="checkbox" name="removeOriginal" value="1"> 원문에서 제거</label>
            <button>문단 분리</button>
          </form>
          <form method="post" action="/admin/pages/${escapeHtml(String(page.id))}/merge">
            <input name="sourcePageRef" placeholder="병합할 문서 제목 또는 번호">
            <input name="sectionTitle" placeholder="문단 제목">
            <label><input type="checkbox" name="deleteSource" value="1"> 원본 삭제</label>
            <button>문서 병합</button>
          </form>
        </div>
      </details>`
    : '';
  const pageSecurityPanel = (canProtect || canDelete) && page.id
    ? `<details class="sidebar-admin-tools">
        <summary>문서 관리</summary>
        <div class="section-lock-panel">
          ${canProtect ? `<form method="post" action="/admin/pages/${escapeHtml(String(page.id))}/protect">
            <strong>보호 수준</strong>
            <select name="level">${['open', 'login_required', 'review_required', 'autoconfirmed_only', 'trusted_only', 'official_only', 'admin_only', 'locked'].map((level) => option(level, page.protection_level, protectionLabel(level))).join('')}</select>
            <input name="reason" placeholder="변경 사유">
            <button>보호 저장</button>
          </form>` : ''}
          ${canDelete ? `<form method="post" action="/admin/pages/${escapeHtml(String(page.id))}/delete">
            <strong>문서 삭제</strong>
            <input name="confirmTitle" placeholder="${escapeHtml(visibleTitle)}">
            <input name="reason" placeholder="삭제 사유">
            <button class="danger-button">삭제</button>
          </form>` : ''}
        </div>
      </details>`
    : '';
  const articleActionLinks = articleActionTabs(namespace, page.title, 'read', isSubwikiRoot);
  const watchControl = articleWatchControl(page, user);
  const serverDirectoryLink = namespace === 'server' && rootPrefix
    ? `<a href="/servers/${encodeURIComponent(rootPrefix)}">투표/리뷰 보기</a>`
    : '';
  const desktopInlineToc = isSubwikiRoot
    ? ''
    : `<section class="article-inline-toc desktop-inline-toc" aria-label="문서 목차">
        <strong>목차</strong>
        ${toc}
      </section>`;
  const mobileInlineToc = isSubwikiRoot
    ? ''
    : `<details class="article-inline-toc mobile-inline-toc">
        <summary>목차</summary>
        ${toc}
      </details>`;
  const articleAdminTools = [pageSecurityPanel, pageManagePanel, lockPanel].filter(Boolean).join('');
  return layout(
    visibleTitle,
    `<main class="wiki-shell skin-${isSubwikiRoot ? 'space' : 'article'} space-${profile.key}${isSubwikiRoot ? ' subwiki-clean-shell' : ''}">
      ${wikiSidebar}
      <article class="article${namespace === 'main' && page.title === '대문' ? ' front-page' : ''}">
        <header class="article-head">
          <div class="article-title-row">
            <h1>${escapeHtml(visibleTitle)}</h1>
            <div class="article-actions${isSubwikiRoot ? ' quiet-actions' : ''}">
              ${serverDirectoryLink}
              ${articleActionLinks}
              ${watchControl}
            </div>
          </div>
          <p class="article-summary"><span class="space-badge">${escapeHtml(profile.badge)}</span>${escapeHtml(isSubwikiRoot ? subwikiRootSummary(namespace, rootPrefix, components) : profile.summary)}</p>
          ${protectionBadges(page)}
        </header>
        <div class="article-main">
          ${oldRevisionNotice}
          ${page.status === 'protected' ? '<aside class="doc-status"><strong>보호됨</strong><span>관리자 정책에 따라 편집이 제한됩니다.</span></aside>' : ''}
          ${isSubwikiRoot ? '' : profile.notice}
          ${isSubwikiRoot ? subwikiRootLanding(namespace, rootPrefix, components) : ''}
          ${namespace === 'dev' ? developDocPanel(components) : ''}
          ${desktopInlineToc}
          ${mobileInlineToc}
          ${articleAdminTools ? `<aside class="article-admin-tools" aria-label="문서 관리 도구">${articleAdminTools}</aside>` : ''}
          ${isSubwikiRoot ? '' : `<div class="article-body">${articleHtmlWithMissingLinks(page)}</div>`}
          ${page.modDetails && !isSubwikiRoot ? modDetailsHtml(page.modDetails) : ''}
        </div>
        <footer class="categories">${categories}</footer>
      </article>
    </main>`,
    user,
    profile.key,
    {
      canonicalPath: wikiUrl(namespace, page.title),
      description: articleDescription(page, profile.summary),
      headHtml: serverTheme.headHtml,
      bodyClass: serverTheme.bodyClass,
      hideIntentStrip: true
    }
  );
}

export function discussionPage(page: any, user: CurrentUser | null) {
  const { namespace, profile, isSubwikiRoot, visibleTitle, pagePath, wikiSidebar, serverTheme } = wikiPageContext(page);
  return layout(
    `${visibleTitle} 토론`,
    `<main class="wiki-shell skin-article discussion-shell space-${profile.key}">
      ${wikiSidebar}
      <article class="article discussion-page">
        <header class="article-head">
          <div class="article-title-row">
            <h1>${escapeHtml(visibleTitle)} 토론</h1>
            <div class="article-actions${isSubwikiRoot ? ' quiet-actions' : ''}">
              ${articleActionTabs(namespace, page.title, 'discussion', isSubwikiRoot)}
            </div>
          </div>
          <p class="article-summary"><span class="space-badge">${escapeHtml(profile.badge)}</span>${escapeHtml(profile.summary)}</p>
          ${protectionBadges(page)}
        </header>
        <div class="article-main">
          ${discussionPanel(page, pagePath, `${pagePath}/discussion`, user)}
        </div>
      </article>
    </main>`,
    user,
    profile.key,
    {
      canonicalPath: `${pagePath}/discussion`,
      description: `${visibleTitle} 문서의 토론입니다.`,
      headHtml: serverTheme.headHtml,
      bodyClass: serverTheme.bodyClass,
      hideIntentStrip: true
    }
  );
}

function serverThemeChrome(theme: any) {
  if (!theme) return { headHtml: '', bodyClass: '' };
  const primary = safeThemeColor(theme.primary_color);
  const accent = safeThemeColor(theme.accent_color);
  const key = safeThemeToken(theme.theme_key, ['default', 'clean', 'dark-server', 'rpg', 'economy', 'minimal-docs', 'pixel-classic'], 'default');
  const branding = safeThemeToken(theme.branding_mode, ['minewiki', 'compact', 'white_label'], 'minewiki');
  const background = safeThemeToken(theme.background_mode, ['light', 'dark', 'system'], 'system');
  const vars = [
    primary ? `--server-primary:${primary};--server-readable:color-mix(in srgb,var(--server-primary) 72%,black);--brand-0:var(--server-readable);--brand-1:color-mix(in srgb,var(--server-primary) 62%,black);--link:var(--server-readable);--accent:var(--server-readable);` : '',
    accent ? `--tertiary-0:${accent};--notice-1:${accent};` : ''
  ].join('');
  const baseCss = vars
    ? `body.server-themed{${vars}}:root[data-theme="dark"] body.server-themed{--server-readable:color-mix(in srgb,var(--server-primary) 45%,white);--brand-0:var(--server-readable);--brand-1:color-mix(in srgb,var(--server-primary) 58%,white);--link:var(--server-readable);--accent:var(--server-readable)}body.server-themed .article h1{box-shadow:inset 0 -8px 0 color-mix(in srgb,var(--brand-0) 18%,transparent)}body.server-themed .article-actions a.active{border-bottom-color:var(--brand-0)}`
    : '';
  const customCss = theme.custom_css_status === 'approved' ? safeServerCustomCss(theme.custom_css) : '';
  const css = [baseCss, customCss ? `body.server-themed ${customCss}` : ''].filter(Boolean).join('\n');
  return {
    bodyClass: `server-themed server-theme-${key} server-branding-${branding} server-bg-${background}`,
    headHtml: css ? `<style id="server-subwiki-theme">${css}</style>` : ''
  };
}

function safeThemeColor(value: unknown) {
  const color = String(value ?? '').trim();
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : '';
}

function safeThemeToken(value: unknown, allowed: string[], fallback: string) {
  const token = String(value ?? '').trim();
  return allowed.includes(token) ? token : fallback;
}

function safeServerCustomCss(value: unknown) {
  const css = String(value ?? '').trim();
  if (!css || css.length > 8000) return '';
  const lowered = css.toLowerCase();
  const forbidden = ['<script', '</script', '@import', 'javascript:', 'expression(', 'url(', 'iframe', 'display:none', 'position:fixed', 'position: fixed'];
  if (forbidden.some((token) => lowered.includes(token))) return '';
  return css.replace(/<\/?style/gi, '');
}

function discussionPanel(page: any, pagePath: string, currentPath = pagePath, user: CurrentUser | null = null) {
  const rows = Array.isArray(page.discussionThreads) ? page.discussionThreads : [];
  const selectedStatus = discussionTabStatus(page.discussionStatus);
  const renderThreads = (items: any[], emptyLabel: string) =>
    items.length
      ? items
          .map((row: any) => {
          const status = String(row.status ?? 'open');
          const canOwnThread = Boolean(user && Number(row.created_by) === Number(user.id));
          const canModerateThread = Boolean(user?.permissions.includes('report.handle') || user?.groups.includes('developer'));
          const canChangeStatus = canOwnThread || canModerateThread;
          const nextStatus = status === 'resolved' ? 'open' : 'resolved';
          const statusForm = canChangeStatus
            ? `<form class="discussion-status-form" method="post" action="/discussion/${escapeHtml(String(row.id))}/status">
                <input type="hidden" name="status" value="${escapeHtml(nextStatus)}">
                <button class="button ghost" type="submit">${status === 'resolved' ? '다시 열기' : '해결로 표시'}</button>
              </form>`
            : '';
          const lockForm = canModerateThread && status !== 'locked'
            ? `<form class="discussion-status-form" method="post" action="/discussion/${escapeHtml(String(row.id))}/status">
                <input type="hidden" name="status" value="locked">
                <button class="button ghost" type="submit">잠금</button>
              </form>`
            : '';
          const comments = Array.isArray(row.comments) ? row.comments : [];
          const commentHtml = comments.length
            ? comments
                .map((comment: any) => `<div class="discussion-comment" id="discussion-comment-${escapeHtml(String(comment.id))}">
                  <div class="discussion-comment-meta">${escapeHtml(comment.actor_name ?? '익명')} · ${escapeHtml(formatDateTime(comment.created_at, ''))}</div>
                  <p>${escapeHtml(String(comment.body ?? '')).replace(/\n/g, '<br>')}</p>
                </div>`)
                .join('')
            : '<p class="empty-discussion">아직 댓글이 없습니다.</p>';
          const canComment = page.canWriteDiscussion !== false && String(row.status ?? 'open') !== 'locked';
          const commentForm = canComment
            ? `<form class="discussion-comment-form" method="post" action="/discussion/${escapeHtml(String(row.id))}/comments">
                <label>댓글<textarea name="body" rows="3" maxlength="4000" placeholder="의견을 이어서 남기세요" required></textarea></label>
                ${turnstileWidget('discussion_comment')}
                <button type="submit">댓글 쓰기</button>
              </form>`
            : '<p class="empty-discussion">이 토론에는 새 댓글을 남길 수 없습니다.</p>';
          return `<article class="discussion-thread" id="discussion-thread-${escapeHtml(String(row.id))}">
          <div>
            <strong>${escapeHtml(row.title ?? '토론')}</strong>
            <span>${escapeHtml(genericStatusLabel(status))} · 댓글 ${escapeHtml(String(row.comment_count ?? 0))}개 · ${escapeHtml(formatDateTime(row.updated_at ?? row.created_at, ''))}</span>
          </div>
          ${statusForm || lockForm ? `<div class="discussion-thread-actions">${statusForm}${lockForm}</div>` : ''}
          <div class="discussion-comments">${commentHtml}</div>
          ${commentForm}
        </article>`;
          })
          .join('')
      : `<p class="empty-discussion">${escapeHtml(emptyLabel)}</p>`;
  const statusTabs = discussionStatusTabs();
  const statusCounts = new Map(statusTabs.map((tab) => [tab.key, 0]));
  for (const row of rows) {
    const status = discussionTabStatus(row.status);
    if (status !== 'new') statusCounts.set(status, (statusCounts.get(status) ?? 0) + 1);
  }
  const discussionSummary = `<section class="discussion-summary" aria-label="토론 요약">
    <span><strong>${escapeHtml(String(statusCounts.get('open') ?? 0))}</strong>열린 토론<small>지금 의견을 이어갈 수 있는 주제입니다.</small></span>
    <span><strong>${escapeHtml(String(statusCounts.get('resolved') ?? 0))}</strong>닫힌 토론<small>합의가 끝나 기록으로 남은 주제입니다.</small></span>
    <span><strong>${escapeHtml(String(statusCounts.get('locked') ?? 0))}</strong>잠긴 토론<small>운영자 조치로 더 쓸 수 없는 주제입니다.</small></span>
  </section>`;
  const discussionTabs = `<nav class="discussion-tabs" aria-label="토론 상태">
    ${statusTabs
      .map((tab) => {
        const count = tab.key === 'new' ? '' : `<span>${statusCounts.get(tab.key) ?? 0}</span>`;
        const active = selectedStatus === tab.key ? ' class="active" aria-current="page"' : '';
        return `<a${active} href="${escapeHtml(`${currentPath}?status=${tab.hrefKey ?? tab.key}#discussion`)}">${tab.label}${count}</a>`;
      })
      .join('')}
  </nav>`;
  const selectedTab = statusTabs.find((tab) => tab.key === selectedStatus) ?? statusTabs[0];
  const selectedRows = rows.filter((row: any) => discussionTabStatus(row.status) === selectedStatus);
  const threadHtml = selectedStatus !== 'new'
    ? `<section class="discussion-thread-group" id="${selectedTab.id}">
        ${renderThreads(selectedRows, selectedTab.emptyLabel)}
      </section>`
    : '';
  const formHtml = page.canCreateDiscussion === false
    ? '<p class="empty-discussion">이 문서에는 새 토론을 열 권한이 없습니다.</p>'
    : `<form class="discussion-form" id="discussion-new" method="post" action="${escapeHtml(pagePath)}/discussion">
        <label>토론 제목<input name="title" maxlength="160" required placeholder="토론 주제를 입력하세요"></label>
        <label>첫 의견<textarea name="body" rows="4" maxlength="4000" placeholder="의견을 남기세요"></textarea></label>
        ${turnstileWidget('discussion_create')}
        <button type="submit">토론 열기</button>
      </form>`;
  return `<section class="discussion-panel" id="discussion">
    <div class="discussion-head">
      <h2>${escapeHtml(selectedTab.label)}</h2>
    </div>
    ${discussionSummary}
    ${discussionTabs}
    <section class="discussion-guide-panel">
      <strong>토론 이용 순서</strong>
      <ol>
        <li><span>열린 토론에서 이미 논의 중인 주제가 있는지 먼저 확인합니다.</span></li>
        <li><span>새 주제는 새 토론 탭에서 제목과 첫 의견을 분명히 적어 엽니다.</span></li>
        <li><span>합의가 끝난 주제는 발제자나 운영자가 해결로 표시해 닫습니다.</span></li>
      </ol>
    </section>
    <div class="discussion-list">${selectedStatus === 'new' ? '' : threadHtml}</div>
    ${selectedStatus === 'new' ? formHtml : ''}
  </section>`;
}

function discussionStatusTabs() {
  return [
    { key: 'open', hrefKey: 'open', id: 'discussion-open', label: '열린 토론', emptyLabel: '열린 토론이 없습니다.' },
    { key: 'resolved', hrefKey: 'closed', id: 'discussion-resolved', label: '닫힌 토론', emptyLabel: '닫힌 토론이 없습니다.' },
    { key: 'locked', hrefKey: 'locked', id: 'discussion-locked', label: '잠긴 토론', emptyLabel: '잠긴 토론이 없습니다.' },
    { key: 'new', hrefKey: 'new', id: 'discussion-new', label: '새 토론', emptyLabel: '' }
  ];
}

function discussionTabStatus(value: unknown) {
  const key = String(value ?? 'open').trim();
  if (key === 'closed' || key === 'close') return 'resolved';
  return ['open', 'resolved', 'locked', 'new'].includes(key) ? key : 'open';
}

function subwikiRootSummary(namespace: NamespaceCode, root: string, components: Array<{ name: string; props: Record<string, string> }>) {
  if (namespace === 'server') {
    const info = components.find((component) => component.name === 'server_info')?.props ?? {};
    const meta = [serverEditionLabel(String(info['에디션'] ?? '')), info['지원 버전'], info['장르']].filter(Boolean).join(' · ');
    return meta || `${root} 서버 공식 문서와 공지를 모은 위키입니다.`;
  }
  const info = components.find((component) => component.name === 'mod_info')?.props ?? {};
  if (/create/i.test(root)) return 'Create는 회전력 기반 장치와 자동화를 다루는 기술 모드입니다.';
  return [info['분류'], info['로더'], info['지원 버전']].filter(Boolean).join(' · ') || `${root} 모드 문서를 모은 위키입니다.`;
}

function subwikiRootLanding(namespace: NamespaceCode, root: string, components: Array<{ name: string; props: Record<string, string> }>) {
  const quickLinks = namespace === 'server'
    ? [
        { label: '규칙', target: '서버 규칙' },
        { label: '공지', target: '공지' }
      ]
    : ['시작하기', '기본 시스템', '아이템', '블록', '기계', '설정', '호환성', '문제 해결', 'FAQ'].map((item) => ({ label: item, target: item }));
  const categories = namespace === 'server'
    ? [
        { label: '공지', target: '공지' },
        { label: '규칙', target: '서버 규칙' }
      ]
    : ['기본 시스템', '아이템', '블록', '기계', '호환성', '문제 해결'].map((item) => ({ label: item, target: item }));
  const info = components.find((component) => component.name === (namespace === 'server' ? 'server_info' : 'mod_info'))?.props ?? {};
  const statusTags = (namespace === 'server'
    ? [
        meaningfulInfoText(info['인증'] || info['인증 상태']) ? serverVerificationLabel(info['인증'] || info['인증 상태']) : '',
        info['상태 확인'] ? '상태 확인 필요' : '',
        meaningfulInfoText(serverEditionLabel(String(info['에디션'] ?? ''))),
        meaningfulInfoText(info['지원 버전']),
        meaningfulInfoText(info['장르'])
      ]
    : [
        ...splitTagText(info['로더']).map(meaningfulInfoText),
        meaningfulInfoText(info['지원 버전']) ? `지원 버전: ${meaningfulInfoText(info['지원 버전'])}` : '',
        meaningfulInfoText(requiredValueLabel(info['서버 필요'])) ? `서버 필요: ${meaningfulInfoText(requiredValueLabel(info['서버 필요']))}` : '',
        meaningfulInfoText(info['상태'])
      ]).filter(Boolean);
  const statusRow = statusTags.length
    ? `<div class="subwiki-status-row">${statusTags.map((item) => tag(item)).join('')}</div>`
    : '';
  const infoRows = Object.entries(info)
    .filter(([, value]) => meaningfulInfoText(value))
    .slice(0, 8)
    .map(([key, value]) => `<tr><th>${escapeHtml(key)}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join('');
  return `<section class="subwiki-home">
    ${statusRow}
    <section>
      <h2>처음이라면</h2>
      <ol>${quickLinks.slice(0, 3).map((link) => `<li>${subwikiLandingLink(namespace, root, link)}</li>`).join('')}</ol>
    </section>
    <section>
      <h2>문서 분류</h2>
      <div class="subwiki-category-grid">${categories.map((link) => subwikiLandingLink(namespace, root, link)).join('')}</div>
    </section>
    ${infoRows ? `<aside class="subwiki-info"><h2>${escapeHtml(root)} 정보</h2>${componentTableMarkup(`<tbody>${infoRows}</tbody>`)}</aside>` : ''}
  </section>`;
}

function subwikiLandingLink(namespace: NamespaceCode, root: string, link: { label: string; target: string }) {
  return `<a href="${wikiUrl(namespace, `${root}/${link.target}`)}">${escapeHtml(link.label)}</a>`;
}

function splitTagText(value: unknown) {
  return String(value ?? '')
    .split(/[·,]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function meaningfulInfoText(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return '';
  const normalized = text.toLowerCase();
  const placeholders = new Set(['문서 참조', '알 수 없음', '확인 필요', '미정', '정보 없음', 'unknown', 'none', 'n/a']);
  return placeholders.has(normalized) ? '' : text;
}

function requiredValueLabel(value: unknown) {
  const text = String(value ?? '').trim().toLowerCase();
  const labels: Record<string, string> = {
    yes: '필요',
    no: '불필요',
    optional: '선택',
    unknown: '알 수 없음',
    true: '필요',
    false: '불필요'
  };
  return labels[text] ?? String(value ?? '').trim();
}

function articleHtmlWithMissingLinks(page: any) {
  let html = normalizeRenderedDateTimes(page.html ?? '<p>렌더 캐시가 없습니다.</p>');
  html = normalizeFrontComponentLinks(page, html);
  for (const link of safeJson<{ namespace_code: NamespaceCode; title: string }>(page.missing_links_json)) {
    const href = wikiUrl(link.namespace_code, link.title);
    html = html.replaceAll(`<a class="wiki-link" href="${href}">`, `<a class="wiki-link missing" href="${href}" title="문서 없음">`);
  }
  return html;
}

function normalizeFrontComponentLinks(page: any, html: string) {
  const components = safeJson<{ name: string; props: Record<string, string> }>(page.components_json);
  if (!components.some((component) => component.name === 'front_card')) return html;
  let normalized = html;
  for (const component of components) {
    if (component.name !== 'front_card') continue;
    for (const [key, value] of Object.entries(component.props ?? {})) {
      if (!/^링크\d+$/.test(key) || !value) continue;
      const label = escapeHtml(value);
      const searchHref = `/search?q=${encodeURIComponent(value)}`;
      for (const namespace of ['main', 'mod', 'server', 'dev', 'help', 'project'] as NamespaceCode[]) {
        const wikiHref = wikiUrl(namespace, value);
        normalized = normalized.replaceAll(`<a class="wiki-link" href="${wikiHref}">${label}</a>`, `<a class="wiki-link" href="${searchHref}">${label}</a>`);
      }
    }
  }
  return normalized;
}

function normalizeRenderedDateTimes(html: string) {
  return html
    .replace(/\b(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) [A-Z][a-z]{2} \d{2} \d{4} \d{2}:\d{2}:\d{2} GMT[+-]\d{4} \([^)]*\)/g, (match) => formatDateTime(match))
    .replace(/(\d{4})\.(\d{2})\.(\d{2})\.\s+(\d{2}):(\d{2})(?::(\d{2}))?/g, '$1.$2.$3. $4:$5')
    .replace(/(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2})(?::(\d{2}))?)?/g, (_match, year, month, day, hour, minute) =>
      hour ? `${year}.${month}.${day}. ${hour}:${minute}` : `${year}.${month}.${day}. 00:00`
    );
}

function currentSpaceForNamespace(namespace: NamespaceCode | string) {
  return namespace === 'modpack' ? 'modpack' : String(namespace || '');
}

function articleDescription(page: any, fallback: string) {
  const firstSentence = String(page.content_raw ?? '')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/\[\[분류:[^\]]+\]\]/g, ' ')
    .replace(/'{2,}/g, '')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_match, target, label) => label || target)
    .replace(/<[^>]+>/g, ' ')
    .replace(/==[^=]+==/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .split(/(?<=[.!?。！？다요음임)])\s+/)[0];
  const summary = componentSeoSummary(safeJson<{ name: string; props: Record<string, string> }>(page.components_json));
  return [firstSentence, summary].filter(Boolean).join(' ').slice(0, 155) || fallback;
}

function componentSeoSummary(components: Array<{ name: string; props: Record<string, string> }>) {
  const component = components.find((item) => ['mob_info', 'block_info', 'item_info', 'mod_info', 'server_info', 'develop_status', 'api_info', 'packet_info', 'data_type_info'].includes(item.name));
  if (!component) return '';
  const keyMap: Record<string, string[]> = {
    mob_info: ['분류', '체력', '에디션'],
    block_info: ['종류', '경도', '도구'],
    item_info: ['종류', '중첩', '획득'],
    mod_info: ['분류', '로더', '지원 버전', '클라이언트 필요', '서버 필요'],
    server_info: ['주소', '에디션', '지원 버전', '장르', '인증'],
    develop_status: ['대상', '버전', '검증', '출처'],
    api_info: ['종류', '대상', '언어', '지원', '기준 버전', '버전'],
    packet_info: ['방향', '상태', 'ID', '버전'],
    data_type_info: ['종류', '크기', '범위']
  };
  const parts = (keyMap[component.name] ?? [])
    .map((key) => {
      const value = meaningfulInfoText(component.props[key]);
      return value ? `${key} ${value}` : '';
    })
    .filter(Boolean)
    .slice(0, 5);
  return parts.length ? `핵심 정보: ${parts.join(', ')}.` : '';
}

export function modIndexPage(rows: any[], filters: Record<string, string>, user: CurrentUser | null) {
  const totalDocs = rows.reduce((sum, row) => sum + Number(row.doc_count ?? 0), 0);
  const verifiedCount = rows.filter((row) => Boolean(row.creator_verified)).length;
  const checkCount = rows.filter((row) => !row.creator_verified || ['needs_check', 'outdated', 'needs_maintainer'].includes(String(row.wiki_status ?? ''))).length;
  const filterSummary = activeDirectoryFilters(filters, {
    q: '검색어',
    loader: '로더',
    category: '분류',
    version: '버전'
  });
  const cards = rows
    .map(
      (row) => {
        const href = `/mod/${encodeURIComponent(row.wiki_slug ?? row.title)}`;
        const title = `${row.title} 위키`;
        const status = row.creator_verified ? '확인됨' : modWikiStatusLabel(row.wiki_status);
        const description = modDirectoryDescription(row);
        const lastChecked = formatDateOnly(row.last_checked, '미확인');
        const loaderTags = splitTagText(row.loaders);
        return `<article class="result-card directory-card mod-directory-card">
          <header class="directory-card-main">
            <a class="result-title" href="${href}">${escapeHtml(title)}</a>
            <p>${escapeHtml(description)}</p>
          </header>
          <div class="tag-row">
            ${tag(status)}
            ${tag(row.last_checked ? '최근 확인' : '확인 대기')}
            ${loaderTags.map((item) => tag(item)).join('')}
            ${splitTagText(row.supported_versions).slice(0, 2).map((item) => tag(item)).join('')}
            ${tag(row.category)}
            ${tag(`문서 ${row.doc_count ?? 0}개`)}
          </div>
          <small>마지막 확인: ${escapeHtml(lastChecked)}</small>
          <a class="button ghost" href="${href}">위키 보기</a>
        </article>`;
      }
    )
    .join('');
  const empty = `<section class="empty-state directory-empty-state">
    <h2>조건에 맞는 모드가 없습니다</h2>
    <p>필터를 줄이거나 새 모드 위키를 만들어 문서 공간을 시작하세요.</p>
    <div class="quick-actions"><a class="button" href="/mods">전체 보기</a><a class="button ghost" href="/mods/new">새 모드 위키 만들기</a></div>
  </section>`;
  return layout(
    '모드',
    `<main class="directory space-mod">
      <section class="directory-head">
        <h1>모드</h1>
        <p>모드별 위키를 찾거나 새로 만들 수 있습니다.</p>
        <form class="filter-bar" method="get">
          <input name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="모드 위키 검색">
          <select name="loader"><option value="">로더 전체</option>${option('fabric', filters.loader)}${option('forge', filters.loader)}${option('neoforge', filters.loader)}${option('quilt', filters.loader)}</select>
          <input name="category" value="${escapeHtml(filters.category ?? '')}" placeholder="최적화, 기술, 라이브러리">
          <input name="version" value="${escapeHtml(filters.version ?? '')}" placeholder="1.20.1, 1.21.x">
          <button>필터</button>
        </form>
        <div class="filter-chips"><a href="/mods">전체</a><a href="/mods?loader=fabric">Fabric</a><a href="/mods?loader=forge">Forge</a><a href="/mods?loader=neoforge">NeoForge</a><a href="/mods?loader=quilt">Quilt</a><a href="/mods?category=최적화">최적화</a><a href="/mods?category=기술">기술</a></div>
        <div class="quick-actions"><a class="button" href="/mods/new">새 모드 위키 만들기</a><a class="button ghost" href="/new/mod-page">기존 모드 위키에 문서 추가</a></div>
      </section>
      <section class="directory-summary" aria-label="모드 위키 요약">
        <span><strong>${escapeHtml(String(rows.length))}</strong><small>모드 위키</small></span>
        <span><strong>${escapeHtml(String(totalDocs))}</strong><small>문서</small></span>
        <span><strong>${escapeHtml(String(verifiedCount))}</strong><small>확인됨</small></span>
        <span><strong>${escapeHtml(String(checkCount))}</strong><small>확인 필요</small></span>
      </section>
      <section class="directory-layout">
        <div class="directory-main-panel">
          <h2 class="directory-section-title">모드 위키</h2>
          <section class="result-list">${cards || empty}</section>
        </div>
        <aside class="directory-guide-panel">
          <strong>필터 기준</strong>
          <p>${escapeHtml(filterSummary || '전체 모드 위키를 표시 중입니다.')}</p>
          <strong>다음 행동</strong>
          <div class="quick-actions"><a class="button ghost" href="/special/old-mods">오래된 모드 문서</a><a class="button ghost" href="/tasks">정비 작업</a></div>
        </aside>
      </section>
    </main>`,
    user,
    'mod'
  );
}

function activeDirectoryFilters(filters: Record<string, string>, labels: Record<string, string>) {
  return Object.entries(labels)
    .map(([key, label]) => {
      const value = String(filters[key] ?? '').trim();
      return value ? `${label}: ${value}` : '';
    })
    .filter(Boolean)
    .join(' · ');
}

function modDirectoryDescription(row: any) {
  const category = String(row.category ?? '').trim();
  if (/create/i.test(String(row.title ?? ''))) return '회전력 기반 자동화 모드';
  if (/sodium/i.test(String(row.title ?? ''))) return '렌더링 최적화 모드';
  if (/iris/i.test(String(row.title ?? ''))) return '셰이더 로더 모드';
  return category ? `${category} 모드` : '모드별 문서와 설정을 모은 위키';
}

function modWikiStatusLabel(status: string) {
  const labels: Record<string, string> = {
    active: '운영 중',
    needs_check: '확인 필요',
    outdated: '오래됨',
    readonly: '읽기 전용',
    needs_maintainer: '관리자 필요'
  };
  return labels[status] ?? '확인 필요';
}

export function fileDetailPage(file: any, user: CurrentUser | null) {
  const usages = (file.usages ?? [])
    .map(
      (row: any) => {
        const title = publicDocumentTitle(row.namespace_code, row.title, row.display_title);
        return `<tr><td><a href="${wikiUrl(row.namespace_code, row.title)}">${escapeHtml(title)}</a></td><td>${escapeHtml(spaceLabel(String(row.namespace_code ?? 'main')))}</td><td>${escapeHtml(fileUsageLabel(row.usage_context))}</td></tr>`;
      }
    )
    .join('');
  const reports = (file.reports ?? [])
    .map((row: any) => `<tr><td>#${escapeHtml(String(row.id))}</td><td>${escapeHtml(row.reason)}</td><td>${escapeHtml(genericStatusLabel(String(row.status ?? 'open')))}</td><td>${escapeHtml(formatDateTime(row.created_at))}</td></tr>`)
    .join('');
  const licenseStatus = fileLicenseLabel(file.license);
  const source = fileSourceHtml(file.source_text, file.source_url);
  const usageCount = (file.usages ?? []).length;
  const reportCount = (file.reports ?? []).length;
  const canManageFiles = canAccessAdminTools(user);
  const emptyUsageAction = canManageFiles
    ? { href: '/admin/files', label: '파일 관리' }
    : { href: '/help/파일_업로드', label: '파일 사용법' };
  const fileSummaryPanel = `<section class="file-detail-summary" aria-label="파일 요약">
    <span><strong>${escapeHtml(licenseStatus)}</strong>라이선스<small>${file.license ? '출처 표기와 사용 조건을 확인합니다.' : '업로드 후 라이선스 확인이 필요합니다.'}</small></span>
    <span><strong>${escapeHtml(fileStatusLabel(file.status))}</strong>상태<small>${file.status === 'hidden' ? '일반 문서에서는 표시가 제한됩니다.' : '문서에서 사용할 수 있는 파일 상태입니다.'}</small></span>
    <span><strong>${escapeHtml(String(usageCount))}개</strong>사용 문서<small>본문에서 이 파일을 참조한 문서 수입니다.</small></span>
    <span><strong>${escapeHtml(String(reportCount))}건</strong>신고<small>열린 검토 요청과 처리 기록을 확인합니다.</small></span>
  </section>`;
  const fileGuidePanel = `<section class="file-detail-guide">
    <strong>파일 확인 순서</strong>
    <ol>
      <li><span>라이선스와 출처가 문서 사용 조건에 맞는지 먼저 확인합니다.</span></li>
      <li><span>사용 문서 목록에서 이 파일이 실제로 필요한 위치를 확인합니다.</span></li>
      <li><span>문제가 있으면 파일 신고를 남기고, 관리자는 파일 관리에서 상태를 정리합니다.</span></li>
    </ol>
  </section>`;
  const reportForm = ['normal', 'license_needed'].includes(String(file.status ?? 'normal'))
    ? `<section class="file-report-panel">
        <h2>파일 신고</h2>
        <p>라이선스, 출처, 개인정보, 저작권 문제가 보이면 검토 요청을 남깁니다.</p>
        <form class="stack-form compact-form" method="post" action="/files/${escapeHtml(String(file.id))}/report">
          <label>사유<select name="reason">
            <option value="license">라이선스/출처 문제</option>
            <option value="privacy">개인정보 또는 민감 정보</option>
            <option value="copyright">저작권 문제</option>
            <option value="other">기타</option>
          </select></label>
          <label>상세<textarea name="detail" rows="3" maxlength="4000" placeholder="검토가 필요한 이유를 적어 주세요."></textarea></label>
          ${user ? '' : turnstileWidget('file_report')}
          <button>신고하기</button>
        </form>
      </section>`
    : '';
  return layout(
    `파일:${file.file_name}`,
    `<main class="wiki-shell space-file file-detail-page">
      <article class="article">
        <header class="article-head">
          <span class="space-badge">파일</span>
          <h1>${escapeHtml(file.file_name)}</h1>
          <p class="article-summary">${escapeHtml(fileSummary(file))}</p>
          <div class="quick-actions">
            <a class="button ghost" href="/file">파일 홈</a>
            <a class="button ghost" href="/file/upload">파일 업로드</a>
            ${canManageFiles ? '<a class="button ghost" href="/admin/files">파일 관리</a>' : ''}
          </div>
        </header>
        ${file.status === 'hidden' ? '<aside class="warning">이 파일은 관리자에 의해 숨김 처리되었습니다.</aside>' : ''}
        ${fileSummaryPanel}
        ${fileGuidePanel}
        <figure class="wiki-file"><img src="${escapeHtml(file.url)}" alt="${escapeHtml(file.original_name)}" loading="lazy"></figure>
        <section>
          <h2>파일 정보</h2>
          ${componentTableMarkup(`<tbody>
            <tr><th>라이선스</th><td>${escapeHtml(licenseStatus)}</td></tr>
            <tr><th>출처</th><td>${source}</td></tr>
            <tr><th>업로드 사용자</th><td>${escapeHtml(file.uploader_display_name ?? file.uploader_username ?? '알 수 없음')}</td></tr>
            <tr><th>상태</th><td>${escapeHtml(fileStatusLabel(file.status))}</td></tr>
          </tbody>`)}
        </section>
        <details class="public-log-section">
          <summary>검증 정보</summary>
          ${componentTableMarkup(`<tbody><tr><th>SHA-256</th><td><code>${escapeHtml(file.sha256)}</code></td></tr></tbody>`)}
        </details>
        <section>
          <h2>사용 문서</h2>
          ${componentTableMarkup(`<thead><tr><th>문서</th><th>공간</th><th>사용</th></tr></thead><tbody>${usages || emptyTableRow(3, '사용 중인 문서 없음', '이 파일을 본문에서 사용한 문서가 생기면 이곳에 표시됩니다.', emptyUsageAction.href, emptyUsageAction.label)}</tbody>`)}
        </section>
        ${reportForm}
        ${reports ? `<section><h2>최근 신고</h2>${componentTableMarkup(`<tbody>${reports}</tbody>`)}</section>` : ''}
      </article>
    </main>`,
    user,
    'file',
    { description: `${file.file_name} 파일 설명과 사용 문서 목록입니다.`, canonicalPath: `/file/${encodeURIComponent(file.file_name)}` }
  );
}

export function fileUploadPage(user: CurrentUser | null, canUpload = false, errorMessage = '') {
  const contextLinks = fileUploadContextLinks(user);
  const form = canUpload
    ? `<form class="new-doc-form file-upload-form" method="post" action="/file/upload" enctype="multipart/form-data">
        ${errorMessage ? `<p class="auth-message error">${escapeHtml(errorMessage)}</p>` : ''}
        <label>이미지 파일<input type="file" name="file" accept="image/png,image/jpeg,image/webp,image/gif" required></label>
        <label>라이선스<select name="license">
          <option value="">나중에 확인</option>
          <option value="cc-by">CC BY</option>
          <option value="cc-by-sa">CC BY-SA</option>
          <option value="public-domain">퍼블릭 도메인</option>
          <option value="own-work">직접 제작</option>
          <option value="logo-fair-use">로고/상표 공정 이용</option>
        </select></label>
        <label>출처 URL<input name="sourceUrl" placeholder="https://example.com/source"></label>
        <label>출처 설명<textarea name="sourceText" rows="3" placeholder="직접 촬영, 공식 배포 페이지, 서버 로고 사용 허가 등"></textarea></label>
        <div class="quick-actions"><button>파일 업로드</button><a class="button ghost" href="/file">파일 홈</a></div>
      </form>`
    : `<section class="auth-card file-upload-locked">
        ${errorMessage ? `<p class="auth-message error">${escapeHtml(errorMessage)}</p>` : ''}
        <h2>${user ? '업로드 권한 필요' : '로그인 필요'}</h2>
        <p class="auth-message">${user ? '파일 업로드는 자동 인증 사용자 또는 업로드 권한이 있는 사용자에게 열려 있습니다.' : '파일을 올리려면 먼저 로그인해야 합니다.'}</p>
        <div class="quick-actions">${user ? '<a class="button" href="/help/파일_업로드">업로드 기준 보기</a>' : '<a class="button" href="/login?next=%2Ffile%2Fupload">로그인</a>'}<a class="button ghost" href="/file">파일 홈</a></div>
      </section>`;
  return layout(
    '파일 업로드',
    `<main class="new-doc-shell file-upload-page">
      <section class="directory-head">
        <h1>파일 업로드</h1>
        <p>문서에 넣을 스크린샷, 서버 로고, 아이콘을 올리고 라이선스와 출처를 함께 기록합니다.</p>
      </section>
      <section class="doc-status">
        <strong>업로드 기준</strong>
        <span>PNG, JPEG, WebP, GIF 이미지만 허용됩니다. 라이선스를 비워 두면 검토 대기 파일로 표시됩니다.</span>
      </section>
      <section class="file-upload-layout">
        ${form}
        <aside class="auth-context">
          <h2>업로드 후 할 일</h2>
          <nav>${contextLinks}</nav>
        </aside>
      </section>
    </main>`,
    user,
    'file'
  );
}

function fileUploadContextLinks(user: CurrentUser | null) {
  const links = [
    { href: '/help/파일_업로드', label: '파일 사용법', desc: '문서 삽입 문법' },
    { href: '/project/파일_라이선스_정책', label: '라이선스 정책', desc: '출처와 저작권' },
    user
      ? { href: '/file', label: '파일 홈', desc: '업로드 파일 목록' }
      : { href: '/login?next=%2Ffile%2Fupload', label: '로그인', desc: '업로드 권한 확인' }
  ];
  if (canAccessAdminTools(user)) {
    links.push({ href: '/admin/files', label: '파일 검토', desc: '관리자용' });
  }
  return links
    .map((link) => `<a href="${escapeHtml(link.href)}"><strong>${escapeHtml(link.label)}</strong><span>${escapeHtml(link.desc)}</span></a>`)
    .join('');
}

function fileSummary(file: any) {
  const fileName = String(file.file_name ?? '').trim();
  const originalName = String(file.original_name ?? '').trim();
  const parts = [
    originalName && originalName !== fileName ? originalName : '',
    file.mime_type,
    file.width && file.height ? `${file.width}x${file.height}px` : '',
    formatBytes(Number(file.size_bytes ?? 0))
  ].filter(Boolean);
  return parts.join(' · ');
}

function modVerificationLabel(status: string) {
  const labels: Record<string, string> = {
    confirmed: '확인됨',
    needs_check: '확인 필요',
    partial_old: '일부 오래됨',
    link_broken: '링크 깨짐',
    version_unknown: '버전 불명'
  };
  return labels[status] ?? '확인 필요';
}

function modTaskLabels(value: string) {
  const labels: Record<string, string> = {
    version_check: '버전',
    link_check: '링크',
    dependency_check: '의존성',
    loader_check: '로더'
  };
  return value
    .split(',')
    .map((item) => labels[item] ?? item)
    .join(', ');
}

export function formatDateTime(value: unknown, fallback = '') {
  const parts = dateParts(value);
  if (!parts) return fallback;
  return `${parts.year}.${parts.month}.${parts.day}. ${parts.hour}:${parts.minute}`;
}

function formatDateOnly(value: unknown, fallback = '미확인') {
  const parts = dateParts(value);
  if (!parts) return fallback;
  return `${parts.year}.${parts.month}.${parts.day}. 00:00`;
}

export function formatDisplayValue(key: string, value: unknown) {
  if (value === null || value === undefined || value === '') return '';
  if (key === 'namespace_code') return spaceLabel(String(value));
  if (key === 'issue_type') return qualityIssueLabel(String(value));
  if (key === 'severity') return severityLabel(String(value));
  if (key === 'status') return genericStatusLabel(String(value));
  if (value instanceof Date || /(^|_)(created|updated|reviewed|checked|published|started|resolved|expires|granted|completed|audited|tested|effective)_at$/.test(key)) {
    return formatDateTime(value, String(value));
  }
  if (/(^|_)(date|day)$/.test(key) || /last_checked|week_start|stat_date/.test(key)) {
    return formatDateOnly(value, String(value));
  }
  return String(value);
}

function qualityIssueLabel(value: string) {
  const labels: Record<string, string> = {
    stub: '토막글',
    missing_status: '문서 상태 없음',
    missing_infobox: '정보상자 없음',
    no_internal_links: '내부 링크 없음',
    needs_source: '출처 필요',
    outdated: '오래된 내용',
    mod_missing_check_date: '모드 확인일 없음',
    server_missing_address: '서버 주소 없음'
  };
  return labels[value] ?? value.replace(/_/g, ' ');
}

function qualityStatusLabel(value: unknown) {
  const key = String(value ?? 'unknown');
  const labels: Record<string, string> = {
    good: '양호',
    normal: '정상',
    needs_check: '검토 필요',
    review_required: '검토 필요',
    stub: '토막글',
    outdated: '오래됨',
    partial_old: '일부 오래됨',
    unknown: '알 수 없음'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function roleLabel(value: unknown) {
  const raw = String(value ?? '').replace(/^role:/, '');
  const labels: Record<string, string> = {
    owner: '소유자',
    manager: '관리자',
    editor: '편집자',
    reviewer: '검토자',
    server_owner: '서버 운영자',
    server_manager: '서버 관리자',
    server_editor: '서버 편집자',
    mod_wiki_manager: '모드 위키 관리자',
    mod_wiki_editor: '모드 위키 편집자'
  };
  return labels[raw] ?? raw.replace(/_/g, ' ');
}

function importSourceLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    gitbook: 'GitBook',
    markdown: 'Markdown',
    archive: '압축 파일',
    manual: '직접 입력',
    upload: '파일 업로드'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function fileStatusLabel(value: unknown) {
  const key = String(value ?? 'normal');
  const labels: Record<string, string> = {
    normal: '정상',
    license_needed: '라이선스 필요',
    hidden: '숨김',
    deleted: '삭제'
  };
  return labels[key] ?? genericStatusLabel(key);
}

function fileLicenseLabel(value: unknown) {
  const key = String(value ?? '').trim();
  const labels: Record<string, string> = {
    '': '라이선스 확인 필요',
    license_needed: '라이선스 확인 필요',
    unknown: '라이선스 확인 필요',
    none: '라이선스 확인 필요'
  };
  return labels[key] ?? key;
}

function fileSourceHtml(sourceText: unknown, sourceUrl: unknown) {
  const text = String(sourceText ?? '').trim();
  const url = String(sourceUrl ?? '').trim();
  if (!text && !url) return '출처 미입력';
  const parts: string[] = [];
  if (text && text !== url) parts.push(escapeHtml(text));
  if (url) {
    const label = text && text === url ? '출처 링크' : url;
    if (/^https?:\/\//i.test(url)) parts.push(`<a href="${escapeHtml(url)}" rel="nofollow noopener" target="_blank">${escapeHtml(label)}</a>`);
    else if (url !== text) parts.push(escapeHtml(url));
  }
  return parts.join(' · ') || escapeHtml(text);
}

function fileUsageLabel(value: unknown) {
  const key = String(value ?? 'document');
  const labels: Record<string, string> = {
    document: '문서 본문',
    infobox: '정보상자',
    gallery: '갤러리',
    thumbnail: '썸네일'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function domainStatusLabel(value: unknown) {
  const key = String(value ?? 'pending');
  const labels: Record<string, string> = {
    pending: '확인 대기',
    verified: '확인됨',
    active: '활성',
    disabled: '해제됨',
    failed: '실패'
  };
  return labels[key] ?? genericStatusLabel(key);
}

function domainActionForms(slug: string, domain: any) {
  const status = String(domain.status ?? 'pending');
  const base = `/server/${encodeURIComponent(slug)}/manage/custom-domain/${escapeHtml(String(domain.id))}`;
  const forms: string[] = [];
  if (status === 'pending' || status === 'failed') forms.push(`<form method="post" action="${base}/verify"><button>DNS 확인</button></form>`);
  if (status === 'verified') forms.push(`<form method="post" action="${base}/activate"><button>활성화</button></form>`);
  if (status === 'active' || status === 'verified') forms.push(`<form method="post" action="${base}/disable"><button>해제</button></form>`);
  return forms.join('') || '<span class="muted">작업 없음</span>';
}

function sslStatusLabel(value: unknown) {
  const key = String(value ?? 'pending');
  const labels: Record<string, string> = {
    pending: '대기',
    issued: '발급됨',
    active: '활성',
    failed: '실패',
    disabled: '해제됨'
  };
  return labels[key] ?? genericStatusLabel(key);
}

function severityLabel(value: string) {
  const labels: Record<string, string> = {
    critical: '긴급',
    high: '높음',
    medium: '보통',
    low: '낮음',
    major: '높음',
    minor: '낮음'
  };
  return labels[value] ?? value;
}

function genericStatusLabel(value: string) {
  const labels: Record<string, string> = {
    open: '열림',
    normal: '정상',
    needs_check: '검증 필요',
    stub: '토막글',
    outdated: '오래됨',
    partial_old: '일부 오래됨',
    resolved: '해결',
    rejected: '반려',
    pending: '대기',
    reviewing: '검토 중',
    closed: '닫힘',
    done: '완료',
    assigned: '배정됨',
    blocked: '막힘',
    dismissed: '종료',
    skipped: '건너뜀',
    invite: '초대',
    verified_or_owner: '인증 또는 운영자',
    verified_only: '인증 서버만',
    all: '전체',
    active: '활성',
    inactive: '비활성',
    paused: '일시 중지',
    planned: '예정',
    draft: '초안',
    beta: '베타',
    deprecated: '사용 중단',
    completed: '완료',
    archived: '보관됨',
    disabled: '사용 안 함',
    unknown: '알 수 없음',
    passed: '통과',
    failed: '실패',
    waived: '면제',
    checking: '확인 중',
    mapping: '매핑 중',
    review: '검토',
    imported: '가져옴',
    not_started: '시작 전',
    fixed: '수정됨',
    duplicate: '중복',
    in_progress: '진행 중',
    triaged: '분류됨',
    wontfix: '처리 안 함',
    needs_alias: '별칭 필요',
    needs_page: '문서 필요',
    bad_ranking: '검색 순위 조정 필요',
    needs_work: '작업 필요',
    needs_fix: '수정 필요',
    investigating: '조사 중',
    identified: '원인 확인',
    postmortem: '사후 보고'
  };
  return labels[value] ?? value.replace(/_/g, ' ');
}

function dateParts(value: unknown) {
  if (!value) return null;
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      year: String(value.getFullYear()).padStart(4, '0'),
      month: String(value.getMonth() + 1).padStart(2, '0'),
      day: String(value.getDate()).padStart(2, '0'),
      hour: String(value.getHours()).padStart(2, '0'),
      minute: String(value.getMinutes()).padStart(2, '0'),
      second: String(value.getSeconds()).padStart(2, '0')
    };
  }
  const text = String(value).trim();
  const matched = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2}))?/);
  const dotMatched = matched ?? text.match(/^(\d{4})\.(\d{2})\.(\d{2})\.\s*(?:(\d{2}):(\d{2})(?::(\d{2}))?)?/);
  if (!dotMatched) {
    const parsed = new Date(text);
    if (!Number.isNaN(parsed.getTime())) return dateParts(parsed);
    return null;
  }
  return {
    year: dotMatched[1],
    month: dotMatched[2],
    day: dotMatched[3],
    hour: dotMatched[4] ?? '00',
    minute: dotMatched[5] ?? '00',
    second: dotMatched[6] ?? '00'
  };
}

function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return '0 B';
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(1)} MB`;
}

function rawByteLabel(content: string) {
  const size = Buffer.byteLength(content, 'utf8');
  return `${formatBytes(size)} · ${size}바이트`;
}

export function serverHubPage(rows: any[], filters: Record<string, string>, user: CurrentUser | null) {
  const totalDocs = rows.reduce((sum, row) => sum + Number(row.doc_count ?? 0), 0);
  const verifiedCount = rows.filter((row) => ['verified', '운영자 인증'].includes(String(row.verified_status ?? ''))).length;
  const liveCount = rows.filter((row) => ['active', '운영 중'].includes(String(row.wiki_status ?? ''))).length;
  const filterSummary = activeDirectoryFilters(filters, {
    q: '검색어',
    genre: '장르',
    version: '버전',
    edition: '에디션',
    verified: '인증'
  });
  const cards = rows
    .map(
      (row) => `<article class="result-card directory-card server-card">
        <header class="directory-card-main">
          <a class="result-title" href="${row.card_type === 'server_wiki' ? `/server/${encodeURIComponent(row.wiki_slug ?? row.title)}` : wikiUrl('server', row.title)}">${escapeHtml(row.card_type === 'server_wiki' ? `${row.title} 위키` : `${row.title} 위키`)}</a>
          <p>${escapeHtml(row.host ?? row.description ?? '주소 미등록')}</p>
        </header>
        <div class="tag-row">
          ${tag(serverVerificationLabel(row.verified_status))}
          ${tag(serverWikiStatusLabel(row.wiki_status))}
          ${tag(serverStatusCheckLabel(row))}
          ${tag(row.card_type === 'server_wiki' ? `문서 ${row.doc_count ?? 0}개` : '')}
        </div>
        <small>${[row.edition ? serverEditionLabel(row.edition) : '', row.supported_versions].filter(Boolean).join(' · ')}</small>
        <small>${escapeHtml(String(row.genres ?? ''))}</small>
        <a class="button ghost" href="${row.card_type === 'server_wiki' ? `/server/${encodeURIComponent(row.wiki_slug ?? row.title)}` : wikiUrl('server', row.title)}">서버 위키 보기</a>
      </article>`
    )
    .join('');
  const empty = `<section class="empty-state directory-empty-state">
    <h2>조건에 맞는 서버가 없습니다</h2>
    <p>인증, 에디션, 장르 필터를 줄이거나 서버 위키 신청으로 새 공식 공간을 열 수 있습니다.</p>
    <div class="quick-actions"><a class="button" href="/servers">전체 보기</a><a class="button ghost" href="/servers/new">서버 위키 신청</a></div>
  </section>`;
  return layout(
    '서버',
    `<main class="directory space-server">
      <section class="directory-head">
        <h1>서버</h1>
        <p>서버별 공식 위키를 찾거나 새로 만들 수 있습니다.</p>
        <form class="filter-bar" method="get">
          <input name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="서버 위키 검색">
          <input name="genre" value="${escapeHtml(filters.genre ?? '')}" placeholder="반야생, 경제, RPG">
          <input name="version" value="${escapeHtml(filters.version ?? '')}" placeholder="1.20.1, 1.21.x">
          <select name="edition"><option value="">에디션 전체</option>${option('java', filters.edition, 'Java')}${option('bedrock', filters.edition, 'Bedrock')}${option('crossplay', filters.edition, 'Crossplay')}</select>
          <select name="verified"><option value="">인증 전체</option>${option('1', filters.verified, '운영자 인증')}</select>
          <button>필터</button>
        </form>
        <div class="filter-chips"><a href="/servers">전체</a><a href="/servers?verified=1">운영자 인증</a><a href="/servers?edition=java">Java</a><a href="/servers?edition=bedrock">Bedrock</a><a href="/servers?genre=반야생">반야생</a><a href="/servers?genre=경제">경제</a><a href="/servers?genre=RPG">RPG</a></div>
        <div class="quick-actions"><a class="button" href="/servers/new">서버 위키 신청</a><a class="button ghost" href="/new/server-page">기존 서버 위키에 문서 추가</a></div>
      </section>
      <section class="directory-summary" aria-label="서버 위키 요약">
        <span><strong>${escapeHtml(String(rows.length))}</strong><small>서버 위키</small></span>
        <span><strong>${escapeHtml(String(totalDocs))}</strong><small>문서</small></span>
        <span><strong>${escapeHtml(String(verifiedCount))}</strong><small>운영자 인증</small></span>
        <span><strong>${escapeHtml(String(liveCount))}</strong><small>운영 중</small></span>
      </section>
      <section class="directory-layout">
        <div class="directory-main-panel">
          <h2 class="directory-section-title">서버 위키</h2>
          <section class="result-list">${cards || empty}</section>
        </div>
        <aside class="directory-guide-panel">
          <strong>필터 기준</strong>
          <p>${escapeHtml(filterSummary || '전체 서버 위키를 표시 중입니다.')}</p>
          <strong>다음 행동</strong>
          <div class="quick-actions"><a class="button ghost" href="/my/servers">내 서버</a><a class="button ghost" href="/help/서버_공식_위키_만들기">서버 위키 도움말</a></div>
        </aside>
      </section>
    </main>`,
    user,
    'server'
  );
}

function serverEditionLabel(value: string) {
  const labels: Record<string, string> = {
    java: 'Java Edition',
    bedrock: 'Bedrock Edition',
    crossplay: 'Crossplay',
    unknown: '에디션 미정'
  };
  return labels[value] ?? value;
}

export function serverWikiRequestPage(user: CurrentUser | null, importMode = false, values: Record<string, string> = {}, starterSets: any[] = []) {
  const starterOptions = starterSetRadioCards(starterSets, values.starterSet || 'server-basic', 'server-basic');
  return layout(
    '서버 위키 신청',
    `<main class="new-doc-shell space-server">
      <section class="directory-head">
        <h1>서버 위키 신청</h1>
        <p>서버의 공식 문서 공간을 신청하고 운영자 인증을 준비합니다.</p>
      </section>
      ${creationLoginGate(user, '서버 위키 신청과 운영자 인증은 계정에 연결됩니다. 로그인하면 이 양식을 제출할 수 있습니다.', '/servers/new')}
      ${workflowSteps('서버 위키 신청 순서', [
        ['서버 정보 입력', '서버명, 주소, 지원 버전처럼 사용자가 확인할 핵심 정보를 적습니다.'],
        ['운영자 인증 선택', 'DNS TXT 인증 또는 수동 검토로 서버 운영자임을 확인합니다.'],
        ['운영 큐 등록', '신청 후 관리자 업무 큐에서 검토되고 승인되면 서버 위키가 열립니다.']
      ])}
      <form class="new-doc-form guided-create-form form-skin" method="post" action="/servers/new">
        <section class="form-section">
          <h2>기본 정보</h2>
          <div class="form-grid">
            <label>서버명<input name="title" value="${escapeHtml(values.title ?? '')}" required placeholder="예시서버"></label>
            <label>짧은 주소<input name="slug" value="${escapeHtml(values.slug ?? '')}" required placeholder="example"></label>
            <label>서버 주소<input name="host" value="${escapeHtml(values.host ?? '')}" placeholder="play.example.kr"></label>
            <label>지원 버전<input name="supportedVersions" value="${escapeHtml(values.supportedVersions ?? '')}" placeholder="1.20.1~1.21.x"></label>
          </div>
        </section>
        <section class="form-section">
          <h2>에디션과 장르</h2>
          <div class="choice-row">
            ${radioChoice('edition', 'java', 'Java Edition', values.edition ?? 'java')}
            ${radioChoice('edition', 'bedrock', 'Bedrock Edition', values.edition)}
            ${radioChoice('edition', 'crossplay', 'Crossplay', values.edition)}
          </div>
          <label>장르<input name="genres" value="${escapeHtml(values.genres ?? '')}" placeholder="반야생, 경제, RPG"></label>
        </section>
        <section class="form-section">
          <h2>운영자 인증</h2>
          <div class="choice-row">
            ${radioChoice('claimMethod', 'dns_txt', 'DNS TXT 인증', values.claimMethod ?? 'dns_txt')}
            ${radioChoice('claimMethod', 'manual', '나중에 하기', values.claimMethod)}
          </div>
        </section>
        <section class="form-section">
          <h2>시작 문서 세트</h2>
          <div class="choice-card-grid">${starterOptions}</div>
          <small class="form-hint">서버에 맞는 기본 문서 트리를 고릅니다. 나중에 문서와 양식을 자유롭게 바꿀 수 있습니다.</small>
        </section>
        <section class="form-section">
          <h2>연락처와 이전</h2>
          <div class="form-grid">
            <label>디스코드<input name="discord" value="${escapeHtml(values.discord ?? '')}" placeholder="https://discord.gg/..."></label>
            <label>공식 사이트<input name="officialSite" value="${escapeHtml(values.officialSite ?? '')}" placeholder="https://"></label>
          </div>
          <label class="check-label"><input type="checkbox" name="needsImport" value="1"${importMode || values.needsImport ? ' checked' : ''}> GitBook/Notion/Markdown 이전도 필요합니다</label>
          <label>이전 메모<textarea name="sourceNote" rows="4" placeholder="기존 문서 주소, export 파일 상태, 원하는 사이드바 구조">${escapeHtml(values.sourceNote ?? '')}</textarea></label>
          <label>운영자 메모<textarea name="note" rows="4" placeholder="운영자 인증 방법, 신청 사유, 공개 편집 정책">${escapeHtml(values.note ?? '')}</textarea></label>
        </section>
        <section class="create-preview">
          <strong>생성될 주소</strong>
          <code>/server/${escapeHtml(values.slug || 'example')}</code>
        </section>
        <div class="form-submit-bar">
          <a class="button ghost" href="/servers">취소</a>
          <a class="button ghost" href="/help/서버_공식_위키_만들기">도움말</a>
          ${user ? '<button>서버 위키 신청</button>' : `<a class="button" href="/login?next=%2Fservers%2Fnew">로그인 후 신청</a>${disabledLoginSubmit('서버 위키 신청')}`}
        </div>
      </form>
    </main>`,
    user,
    'server'
  );
}

function starterSetRadioCards(starterSets: any[], selected: unknown, fallbackSelected = 'minimal') {
  const selectedValue = String(selected ?? fallbackSelected);
  const rows = starterSets.length ? starterSets : [
    { set_key: 'minimal', title: '최소 세트', description: '대문과 핵심 문서만 만듭니다.' },
    { set_key: 'custom', title: '직접 구성', description: '빈 위키에 가깝게 시작합니다.' }
  ];
  return rows
    .map((set) => {
      const key = String(set.set_key);
      return `<label class="choice-card"><input type="radio" name="starterSet" value="${escapeHtml(key)}"${selectedValue === key ? ' checked' : ''}><span><strong>${escapeHtml(set.title)}</strong><small>${escapeHtml(set.description ?? '')}</small></span></label>`;
    })
    .join('');
}

function radioChoice(name: string, value: string, label: string, selected: unknown) {
  return `<label class="pill-choice"><input type="radio" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${String(selected ?? '') === value ? ' checked' : ''}>${escapeHtml(label)}</label>`;
}

function checkboxChoice(name: string, value: string, label: string, selected: unknown) {
  const values = Array.isArray(selected) ? selected.map(String) : String(selected ?? '').split(/[·,]/).map((item) => item.trim());
  return `<label class="pill-choice"><input type="checkbox" name="${escapeHtml(name)}" value="${escapeHtml(value)}"${values.includes(value) ? ' checked' : ''}>${escapeHtml(label)}</label>`;
}

export function serverWikiRequestSubmittedPage(requestId: number, user: CurrentUser | null) {
  const canReview = canAccessAdminTools(user);
  const summary = `<section class="creation-flow-summary server-request-result-summary" aria-label="서버 위키 신청 요약">
    <span><strong>#${escapeHtml(String(requestId))}</strong>신청 번호<small>운영 검토 목록에서 이 번호로 추적됩니다.</small></span>
    <span><strong>검토 대기</strong>현재 상태<small>승인 전에는 서버 허브에 바로 공개되지 않습니다.</small></span>
    <span><strong>${user ? '내 서버' : '서버 허브'}</strong>다음 확인<small>${user ? '내 서버 화면에서 인증과 검토 상태를 이어서 확인합니다.' : '로그인하면 내 서버 화면에서 진행 상태를 확인할 수 있습니다.'}</small></span>
  </section>`;
  const reviewerAction = canReview ? '<a class="button ghost" href="/admin/work">관리자 업무 큐</a>' : '';
  return layout(
    '서버 위키 신청 완료',
    `<main class="narrow space-server">
      <section class="directory-head">
        <h1>서버 위키 신청 완료</h1>
        <p>신청이 운영자 업무 큐에 등록되었습니다.</p>
      </section>
      <section class="doc-status"><strong>신청 번호</strong><span>#${escapeHtml(String(requestId))}</span></section>
      ${summary}
      ${workflowSteps('다음 진행', [
        ['운영자 검토', '관리자가 신청 내용과 서버 운영자 인증 방법을 확인합니다.'],
        ['인증 준비', 'DNS TXT 또는 수동 인증에 필요한 자료를 준비하면 승인 속도가 빨라집니다.'],
        ['문서 작성', '승인 전에도 기본 위키에서 서버 소개나 가이드를 먼저 정리할 수 있습니다.']
      ])}
      <div class="quick-actions"><a class="button" href="/servers">서버 허브</a><a class="button ghost" href="/my/servers">내 서버</a><a class="button ghost" href="/servers/new">다른 서버 신청</a>${reviewerAction}</div>
    </main>`,
    user,
    'server'
  );
}

function serverWikiStatusLabel(status: string) {
  const labels: Record<string, string> = {
    active: '운영 중',
    inactive: '비활성',
    closed: '운영 종료',
    disputed: '분쟁 중',
    readonly: '읽기 전용',
    verification_expired: '인증 만료'
  };
  return labels[status] ?? '운영 중';
}

function serverOperationalLabel(status: string) {
  const labels: Record<string, string> = {
    active: '운영 중',
    checking_failed: '상태 확인 실패',
    inactive: '운영 중단 가능',
    closed: '운영 종료',
    disputed: '분쟁 중',
    unverified: '인증 없음'
  };
  return labels[status] ?? '인증 없음';
}

function serverStatusCheckLabel(row: any) {
  if (row.status_enabled === true || row.status_enabled === 1 || row.status_enabled === '1') return '상태 확인 중';
  if (row.card_type === 'server_wiki') return '상태 확인 필요';
  return '';
}

function serverVerificationLabel(status: string) {
  if (/운영자\s*인증|verified|확인/.test(String(status ?? ''))) return '운영자 인증';
  const labels: Record<string, string> = {
    verified: '운영자 인증',
    renewal_required: '갱신 필요',
    expired: '만료',
    pending: '대기',
    failed: '실패',
    disputed: '분쟁 중',
    revoked: '취소',
    none: '미인증',
    unverified: '미인증'
  };
  return labels[status] ?? '미인증';
}

export function developHubPage(groups: Record<string, any[]>, user: CurrentUser | null) {
  const sections = Object.entries(groups)
    .filter(([, pages]) => pages.length)
    .map(
      ([group, pages]) => `<section class="dev-group"><h2>${escapeHtml(group)}</h2><div class="dev-card-grid">${pages
        .slice(0, 12)
        .map((page) => `<a class="dev-card" href="${wikiUrl('dev', page.title)}"><strong>${escapeHtml(devDisplayTitle(page.title))}</strong><span>${escapeHtml(devGroupDescription(group))}</span></a>`)
        .join('')}</div></section>`
    )
    .join('') || emptyPublicSection('개발 문서가 없습니다', '아직 공개된 개발 문서가 없습니다.');
  return layout(
    '개발',
    `<main class="directory dev-layout">
      <section class="directory-head">
        <h1>개발자용 위키</h1>
        <p>Minecraft 개발 자료를 한국어로 정리합니다.</p>
        <form class="filter-bar" action="/search" method="get"><input name="q" placeholder="VarInt, NBT, Paper API, Plugin Message"><input type="hidden" name="space" value="dev"><button>검색</button></form>
      </section>
      <section class="dev-groups">${sections}</section>
    </main>`,
    user,
    'dev'
  );
}

type SpaceHomeCode = NamespaceCode | 'special';

export function spaceHomePage(space: SpaceHomeCode, user: CurrentUser | null) {
  type SpaceHomeCard = { title: string; desc: string; href: string; meta: string };
  const spaces: Record<SpaceHomeCode, { title: string; desc: string; searchSpace?: NamespaceCode; cards: SpaceHomeCard[] }> = {
    main: {
      title: '위키',
      desc: '바닐라와 일반 가이드를 다룹니다.',
      searchSpace: 'main',
      cards: [
        { title: '엔더맨', desc: '몹 정보, 전리품, 전투 패턴을 정리한 기본 문서입니다.', href: wikiUrl('main', '엔더맨'), meta: '일반 문서' },
        { title: '처음 편집하기', desc: '새 문서 작성과 편집 전 확인할 기준입니다.', href: wikiUrl('help', '처음 편집하기'), meta: '도움말' }
      ]
    },
    mod: {
      title: '모드',
      desc: '로더, 지원 버전, 공식 링크, 의존성을 중심으로 모드 정보를 정리합니다.',
      searchSpace: 'mod',
      cards: [
        { title: 'Create', desc: '회전력 기반 자동화 모드 문서 모음입니다.', href: wikiUrl('mod', 'Create'), meta: '기술 모드' },
        { title: 'Sodium', desc: '클라이언트 최적화 모드의 설정과 호환성을 다룹니다.', href: wikiUrl('mod', 'Sodium'), meta: '최적화' },
        { title: 'Fabric API', desc: 'Fabric 생태계의 기반 API와 의존성을 정리합니다.', href: wikiUrl('mod', 'Fabric API'), meta: '라이브러리' }
      ]
    },
    modpack: {
      title: '모드팩',
      desc: '모드팩 구성, 설치, 호환성, 문제 해결 문서를 정리합니다.',
      searchSpace: 'modpack',
      cards: [
        { title: 'RLCraft', desc: '모드팩 설치, 난이도, 주요 시스템 문서로 이동합니다.', href: wikiUrl('modpack', 'RLCraft'), meta: '모험' },
        { title: 'All the Mods', desc: '대형 모드팩의 진행 루트와 구성 정보를 정리합니다.', href: wikiUrl('modpack', 'All the Mods'), meta: '종합' },
        { title: 'Create 모드팩', desc: 'Create 중심 자동화 모드팩의 호환성을 다룹니다.', href: wikiUrl('modpack', 'Create 모드팩'), meta: '자동화' }
      ]
    },
    server: {
      title: '서버',
      desc: '인증 서버 목록과 서버 공식 문서를 분리해 운영합니다.',
      searchSpace: 'server',
      cards: [
        { title: '서버 목록', desc: '운영자 인증 상태와 서버 위키를 함께 확인합니다.', href: '/servers', meta: '목록' },
        { title: '서버 공식 위키 만들기', desc: '운영자 인증과 공식 문서 신청 과정을 안내합니다.', href: wikiUrl('help', '서버_공식_위키_만들기'), meta: '도움말' },
        { title: '서버 문서 정책', desc: '서버 홍보, 규칙, 공지 문서의 작성 기준입니다.', href: wikiUrl('project', '서버 문서 정책'), meta: '정책' }
      ]
    },
    dev: {
      title: '개발',
      desc: '프로토콜, NBT, 플러그인 API, 모드 개발 자료를 일반 문서와 분리합니다.',
      searchSpace: 'dev',
      cards: [
        { title: 'Protocol/VarInt', desc: '패킷 직렬화에서 사용하는 VarInt 형식을 설명합니다.', href: wikiUrl('dev', 'Protocol/VarInt'), meta: '프로토콜' },
        { title: 'NBT', desc: '월드와 아이템 데이터 저장 형식을 정리합니다.', href: wikiUrl('dev', 'NBT'), meta: '데이터' },
        { title: 'Paper API', desc: '서버 플러그인 개발에 필요한 API 문서입니다.', href: wikiUrl('dev', 'Paper API'), meta: '플러그인' }
      ]
    },
    guide: {
      title: '가이드',
      desc: '플레이와 편집에 필요한 절차형 문서를 모읍니다.',
      searchSpace: 'guide',
      cards: [
        { title: '처음 시작하기', desc: '초보자를 위한 기본 진행 가이드입니다.', href: wikiUrl('guide', '처음 시작하기'), meta: '입문' }
      ]
    },
    data: {
      title: '데이터',
      desc: '표, 수치, 목록형 정보를 정리합니다.',
      searchSpace: 'data',
      cards: [
        { title: '아이템 ID', desc: '문서에서 참조하는 데이터 목록입니다.', href: wikiUrl('data', '아이템 ID'), meta: '자료' }
      ]
    },
    help: {
      title: '도움말',
      desc: '편집, 신고, 서버 인증, GitBook 이전 도움말을 제공합니다.',
      searchSpace: 'help',
      cards: [
        { title: '처음 편집하기', desc: '문서 생성, 요약 작성, 검토 흐름을 안내합니다.', href: wikiUrl('help', '처음 편집하기'), meta: '편집' },
        { title: '위키 문법', desc: '링크, 표, 접기, 분류 등 문서 문법 예시입니다.', href: wikiUrl('help', '위키_문법'), meta: '문법' },
        { title: 'GitBook에서 이전하기', desc: '기존 문서를 MineWiki 형식으로 옮기는 절차입니다.', href: wikiUrl('help', 'GitBook에서 이전하기'), meta: '이전' }
      ]
    },
    project: {
      title: '프로젝트',
      desc: '정책, 운영 기준, 공개 준비 문서를 관리합니다.',
      searchSpace: 'project',
      cards: [
        { title: '문서 작성 정책', desc: '출처, 중립성, 문서 품질 기준을 정리합니다.', href: wikiUrl('project', '문서 작성 정책'), meta: '정책' },
        { title: '서버 문서 정책', desc: '서버 위키의 공식성, 홍보성, 인증 기준입니다.', href: wikiUrl('project', '서버 문서 정책'), meta: '서버' },
        { title: '수익 및 운영비 정책', desc: '광고와 운영비 공개 원칙을 정리합니다.', href: wikiUrl('project', '수익 및 운영비 정책'), meta: '운영' }
      ]
    },
    special: {
      title: '특수 문서',
      desc: '품질 점검, 최근 변경, 운영 상태처럼 문서가 아닌 기능성 페이지를 모읍니다.',
      cards: [
        { title: '최근 바뀜', desc: '전체 문서의 최근 편집과 토론 변경을 확인합니다.', href: '/recent', meta: '변경' },
        { title: '새 문서', desc: '최근 생성된 문서와 신규 작성 흐름을 확인합니다.', href: '/new', meta: '작성' },
        { title: '검증 필요 문서', desc: '상태 확인과 보강이 필요한 문서를 모아 봅니다.', href: '/special/needs_check', meta: '품질' },
        { title: '필요한 문서', desc: '링크는 있지만 아직 작성되지 않은 문서를 모읍니다.', href: '/special/needed-pages', meta: '작성 요청' },
        { title: '문서 작성 요청', desc: '작성 수요가 모인 문서를 우선순위별로 확인합니다.', href: '/special/page-requests', meta: '요청' },
        { title: '깨진 링크', desc: '없는 문서로 연결된 링크와 필요한 문서를 점검합니다.', href: '/special/broken-links', meta: '정비' },
        { title: '분류 없는 문서', desc: '분류가 없어 탐색에서 빠지기 쉬운 문서를 정리합니다.', href: '/special/uncategorized', meta: '정비' },
        { title: '문서 상태 없는 문서', desc: '검증 상태 틀이 빠진 문서를 찾아 품질 표식을 보강합니다.', href: '/special/missing-status', meta: '상태' },
        { title: '정보상자 없는 문서', desc: '모드, 서버, 개발 문서의 핵심 요약 정보 누락을 점검합니다.', href: '/special/missing-infobox', meta: '구조' },
        { title: '내부 링크 없는 문서', desc: '고립된 문서를 찾아 관련 문서와 연결합니다.', href: '/special/no-internal-links', meta: '연결' },
        { title: '오래된 모드 문서', desc: '버전과 로더 정보가 오래된 모드 문서를 갱신합니다.', href: '/special/old-mods', meta: '모드' },
        { title: '주소 없는 서버 문서', desc: '서버 주소와 접속 정보가 누락된 공식 문서를 확인합니다.', href: '/special/server-missing-address', meta: '서버' },
        { title: '최근 리비전', desc: '공개 리비전을 표 형태로 훑어보고 변경 맥락을 확인합니다.', href: '/special/recent-revisions', meta: '이력' },
        { title: '리비전 검색', desc: '문서 제목, 요약, 작성자를 기준으로 변경 기록을 검색합니다.', href: '/special/revision-search', meta: '검색' },
        { title: '운영 상태', desc: '장애와 점검 공지를 확인합니다.', href: '/status', meta: '상태' },
        { title: '오픈 베타', desc: '공개 준비 상태와 베타 운영 안내를 확인합니다.', href: '/beta', meta: '공지' }
      ]
    },
    template: {
      title: '틀',
      desc: '문서 구조를 재사용하기 위한 템플릿을 모읍니다.',
      searchSpace: 'template',
      cards: [
        { title: '새 틀 만들기', desc: '반복되는 안내, 상태, 정보상자 구조를 새 틀로 등록합니다.', href: '/templates/new', meta: '작성' },
        { title: '문서 상태', desc: '검증 필요, 최신화 필요 같은 품질 상태를 문서 상단에 표시합니다.', href: wikiUrl('template', '문서 상태'), meta: '품질' },
        { title: '정보상자', desc: '모드, 서버, 개발 문서의 핵심 정보를 표준 형태로 요약합니다.', href: wikiUrl('template', '정보상자'), meta: '요약' },
        { title: '위키 문법', desc: '틀 호출, 표, 링크, 분류 문법을 예시와 함께 확인합니다.', href: wikiUrl('help', '위키_문법'), meta: '도움말' },
        { title: '기본 문서 만들기', desc: '틀을 적용할 새 위키 문서를 바로 작성합니다.', href: '/new/wiki', meta: '문서 작성' }
      ]
    },
    file: {
      title: '파일',
      desc: '업로드 파일과 라이선스 정보를 관리합니다.',
      searchSpace: 'file',
      cards: [
        { title: '파일 업로드', desc: '문서에 사용할 스크린샷, 서버 로고, 아이콘을 출처와 함께 등록합니다.', href: '/file/upload', meta: '업로드' },
        { title: '파일 업로드 도움말', desc: '스크린샷, 로고, 아이콘을 문서에 첨부하기 전 확인할 기준입니다.', href: wikiUrl('help', '파일 업로드'), meta: '도움말' },
        { title: '파일 라이선스 정책', desc: '출처, 저작권, 서버 로고 사용 기준을 확인합니다.', href: wikiUrl('project', '파일 라이선스 정책'), meta: '정책' },
        { title: '문서 작성 요청', desc: '필요한 이미지가 있는 문서를 요청하고 보강 후보를 모읍니다.', href: '/special/page-requests', meta: '요청' },
        { title: '최근 바뀜', desc: '파일을 포함한 최근 문서 변경 내역을 확인합니다.', href: '/recent', meta: '변경' }
      ]
    }
  };
  const info = spaces[space];
  const canManageServers = Boolean(user?.groups.some((group) => ['server_owner', 'admin', 'developer'].includes(group)) || user?.permissions.includes('server.official_edit'));
  const canHandleReports = canAccessAdminTools(user);
  const roleCards: SpaceHomeCard[] = space === 'special'
    ? [
        ...(user ? [
          { title: '감시문서', desc: '내가 지켜보는 문서의 최근 변경을 확인합니다.', href: '/watchlist', meta: '내 메뉴' },
          { title: '내 작업', desc: '내게 배정된 검토와 보강 업무를 확인합니다.', href: '/tasks', meta: '내 메뉴' }
        ] : []),
        ...(user && canManageServers ? [{ title: '내 서버', desc: '내가 관리하는 서버 위키와 인증 상태를 확인합니다.', href: '/my/servers', meta: '서버' }] : []),
        ...(canHandleReports ? [
          { title: '관리 홈', desc: '신고, 검토 큐, 시스템 작업을 한 화면에서 처리합니다.', href: '/admin', meta: '관리' },
          { title: '검색 관리', desc: '검색 로그와 재색인 상태를 점검합니다.', href: '/admin/search', meta: '관리' },
          { title: '파일 관리', desc: '신고된 파일과 라이선스 검토 대상을 처리합니다.', href: '/admin/files', meta: '관리' }
        ] : [])
      ]
    : space === 'file' && canHandleReports
      ? [{ title: '파일 관리', desc: '신고된 파일, 숨김 처리, 라이선스 검토 대상을 처리합니다.', href: '/admin/files', meta: '관리' }]
      : [];
  const cards = [...info.cards, ...roleCards];
  const searchSpaceInput = info.searchSpace ? `<input type="hidden" name="space" value="${escapeHtml(info.searchSpace)}">` : '';
  return layout(
    info.title,
    `<main class="directory wiki-hub-page space-${escapeHtml(String(space))}">
      <section class="directory-head">
        <h1>${escapeHtml(info.title)}</h1>
        <p>${escapeHtml(info.desc)}</p>
        <form class="filter-bar" action="/search" method="get">
          <input name="q" placeholder="${escapeHtml(cards[0]?.title ?? '검색')}">
          ${searchSpaceInput}
          <button>검색</button>
        </form>
      </section>
      <section class="entry-grid hub-card-grid">${cards
        .map((card) => `<article class="entry hub-card">
          <h2><a href="${escapeHtml(card.href)}">${escapeHtml(card.title)}</a></h2>
          <p>${escapeHtml(card.desc)}</p>
          <span class="tag">${escapeHtml(card.meta)}</span>
        </article>`)
        .join('') || emptyPublicSection('표시할 항목이 없습니다', '아직 이 공간에 등록된 대표 문서가 없습니다.')}
      </section>
    </main>`,
    user,
    space === 'special' ? 'special' : (info.searchSpace ?? '')
  );
}

function devDisplayTitle(title: string) {
  return String(title).replace(/^Develop\//, '').replace(/\//g, ' / ');
}

function devGroupDescription(group: string) {
  const descriptions: Record<string, string> = {
    Protocol: '패킷, 상태, 직렬화',
    'Plugin API': 'Paper, Bukkit, Velocity',
    'Mod API': 'Fabric, Forge, NeoForge',
    Data: 'NBT, Registry, Data Pack, Resource Pack',
    Tools: '개발 도구와 예제'
  };
  return descriptions[group] ?? '개발 문서';
}

export function newDocumentPage(user: CurrentUser | null, values: Record<string, string> = {}) {
  const suggestedTitle = normalizeTitle(String(values.title ?? ''));
  const titleQuery = suggestedTitle ? `?title=${encodeURIComponent(suggestedTitle)}` : '';
  const choices = [
    [`/new/wiki${titleQuery}`, '기본 위키에 문서 만들기', '몹, 블록, 아이템, 가이드 문서', '예: 엔더맨, 황금 사과'],
    [`/new/mod-page${titleQuery}`, '모드 위키 안에 문서 만들기', '특정 모드 위키의 하위 문서', '예: Create 위키 / 회전력'],
    [`/new/server-page${titleQuery}`, '서버 위키 안에 문서 만들기', '특정 서버 위키의 공식/커뮤니티 문서', '예: 예시서버 위키 / 규칙'],
    [`/new/dev${titleQuery}`, '개발 위키에 문서 만들기', 'API, Protocol, NBT 문서', '예: Paper API, VarInt']
  ];
  return layout(
    '새 문서 만들기',
    `<main class="new-doc-shell">
      <section class="directory-head">
        <h1>새 문서 만들기</h1>
        <p>어디에 문서를 만들까요?</p>
      </section>
      ${creationFlowSummary([
        { label: '작성 공간', value: '4가지', detail: '기본, 모드, 서버, 개발 위키 중에서 고릅니다.' },
        { label: '로그인 상태', value: user ? '로그인됨' : '미로그인', detail: user ? '저장하면 계정 기여로 기록됩니다.' : '저장 전 로그인 안내를 볼 수 있습니다.' },
        { label: '제목 후보', value: suggestedTitle || '없음', detail: suggestedTitle ? '검색/요청에서 이어진 제목입니다.' : '다음 화면에서 문서 제목을 입력합니다.' }
      ])}
      ${workflowSteps('작성 흐름', [
        ['위치 선택', '기본 위키, 모드 위키, 서버 위키, 개발 위키 중 문서가 속할 공간을 고릅니다.'],
        ['제목과 양식 선택', '문서 제목을 정하고 필요하면 시작 양식을 적용합니다.'],
        ['편집 화면에서 저장', '생성 버튼은 편집 화면으로 이동하며, 저장하면 문서 역사에 기록됩니다.']
      ])}
      ${values.templateSaved ? '<section class="doc-status"><strong>양식 저장 완료</strong><span>새 문서를 만들 때 방금 저장한 양식을 시작 양식으로 선택할 수 있습니다.</span></section>' : ''}
      ${suggestedTitle ? `<section class="doc-status"><strong>작성할 제목</strong><span>${escapeHtml(suggestedTitle)}</span></section>` : ''}
      <section class="doc-type-grid new-doc-choice-grid">
        ${choices.map(([href, label, desc, example]) => `<a class="doc-type-card" href="${href}"><strong>${label}</strong><span>${desc}</span><small>${example}</small></a>`).join('')}
      </section>
      <section class="new-wiki-cta">
        <h2>새 위키를 만들고 싶나요?</h2>
        <div class="quick-actions">
          <a class="button" href="/mods/new">새 모드 위키 만들기</a>
          <a class="button ghost" href="/servers/new">새 서버 위키 만들기</a>
        </div>
      </section>
    </main>`,
    user,
    'main'
  );
}

function creationFlowSummary(items: Array<{ label: string; value: string; detail: string }>) {
  return `<section class="creation-flow-summary" aria-label="생성 흐름 요약">
    ${items.map((item) => `<span><strong>${escapeHtml(item.value)}</strong>${escapeHtml(item.label)}<small>${escapeHtml(item.detail)}</small></span>`).join('')}
  </section>`;
}

function newDocumentCurrentSpace(kind: 'wiki' | 'mod-page' | 'server-page' | 'dev') {
  if (kind === 'mod-page') return 'mod';
  if (kind === 'server-page') return 'server';
  if (kind === 'dev') return 'dev';
  return 'main';
}

function workflowSteps(title: string, items: Array<[string, string]>) {
  return `<section class="workflow-steps" aria-label="${escapeHtml(title)}">
    <h2>${escapeHtml(title)}</h2>
    <ol>
      ${items.map(([label, detail]) => `<li><strong>${escapeHtml(label)}</strong><span>${escapeHtml(detail)}</span></li>`).join('')}
    </ol>
  </section>`;
}

function creationLoginGate(user: CurrentUser | null, message: string, nextPath: string) {
  if (user) {
    return `<section class="doc-status creation-user-state"><strong>로그인됨</strong><span>${escapeHtml(user.display_name || user.username)} 계정으로 저장됩니다. 저장 뒤 문서 역사와 작업 기록에 남습니다.</span></section>`;
  }
  return `<section class="doc-status creation-login-gate" id="creation-login-gate"><strong>로그인 필요</strong><span>${escapeHtml(message)}</span><a class="button" href="/login?next=${encodeURIComponent(nextPath)}">로그인 후 계속</a></section>`;
}

function disabledLoginSubmit(label: string) {
  return `<button disabled title="로그인 후 사용할 수 있습니다." aria-describedby="creation-login-gate">${escapeHtml(label)}</button>`;
}

export function newDocumentFormPage(kind: 'wiki' | 'mod-page' | 'server-page' | 'dev', user: CurrentUser | null, values: Record<string, string> = {}, wikiRows: any[] = [], templates: any[] = []) {
  const configMap = {
    wiki: {
      title: '기본 위키에 새 문서 만들기',
      action: '/new/wiki',
      intro: '몹, 블록, 아이템, 가이드 같은 기본 Minecraft 문서를 만듭니다.',
      placeholder: '엔더맨',
      examples: ['엔더맨', '황금 사과', '좀비 주민 치료'],
      emptyDesc: '처음부터 직접 작성합니다.'
    },
    'mod-page': {
      title: '모드 위키 안에 문서 만들기',
      action: '/new/mod-page',
      intro: '먼저 모드 위키를 고르고, 그 안에 들어갈 문서를 만듭니다.',
      placeholder: '회전력',
      examples: ['Create 위키 / 회전력', 'Sodium 위키 / 설정', 'Iris 위키 / 셰이더'],
      emptyDesc: '이 모드 위키에 맞춰 자유롭게 작성합니다.'
    },
    'server-page': {
      title: '서버 위키 안에 문서 만들기',
      action: '/new/server-page',
      intro: '먼저 서버 위키를 고르고, 공식 문서나 커뮤니티 문서를 만듭니다.',
      placeholder: '규칙',
      examples: ['예시서버 위키 / 규칙', '예시서버 위키 / 접속 방법', '예시서버 위키 / FAQ'],
      emptyDesc: '서버에 맞는 형식으로 직접 작성합니다.'
    },
    dev: {
      title: '개발 위키에 새 문서 만들기',
      action: '/new/dev',
      intro: 'Protocol, NBT, Paper API, 플러그인 개발 문서를 만듭니다.',
      placeholder: 'Protocol/VarInt',
      examples: ['Paper API', 'VarInt', 'NBT 구조'],
      emptyDesc: '개발 문서를 빈 문서로 시작합니다.'
    }
  }[kind];
  const selectedWiki = values.wikiSlug ?? values.slug ?? '';
  const wikiSelect = kind === 'mod-page' || kind === 'server-page'
    ? `<label>${kind === 'mod-page' ? '모드 위키 선택' : '서버 위키 선택'}
        <select name="wikiSlug" required>
          <option value="">선택</option>
          ${wikiRows.map((row) => `<option value="${escapeHtml(String(row.wiki_slug ?? row.slug ?? row.title))}"${selectedWiki === String(row.wiki_slug ?? row.slug ?? row.title) ? ' selected' : ''}>${escapeHtml(String(row.title ?? row.name))} 위키</option>`).join('')}
        </select>
      </label>`
    : '';
  const wikiEmptyCta = (kind === 'mod-page' || kind === 'server-page') && !wikiRows.length
    ? `<aside class="doc-status"><strong>선택할 위키 없음</strong><span>먼저 ${kind === 'mod-page' ? '모드 위키' : '서버 위키'}를 만들거나 신청해야 하위 문서를 추가할 수 있습니다.</span><a class="button ghost" href="${kind === 'mod-page' ? '/mods/new' : '/servers/new'}">${kind === 'mod-page' ? '모드 위키 만들기' : '서버 위키 신청'}</a></aside>`
    : '';
  const templateOptions = renderTemplateOptions(templates, values.template ?? values.templateId);
  const areaOptions = [
    ['community', '커뮤니티 영역', '일반 기여자가 함께 작성합니다.'],
    ['official', '공식 영역', '인증된 담당자가 관리합니다.'],
    ['review_required', '검토 필요 영역', '저장 전 검토가 필요합니다.']
  ];
  const previewBase =
    kind === 'wiki' ? '/wiki/' :
      kind === 'dev' ? '/dev/' :
        kind === 'mod-page' ? `/mod/${selectedWiki || '선택한_모드_위키'}/` :
          `/server/${selectedWiki || '선택한_서버_위키'}/`;
  const title = values.title ?? '';
  const templateNote = documentTemplateNote(user, kind, selectedWiki);
  const spaceLabelText = kind === 'wiki' ? '기본 위키' : kind === 'dev' ? '개발 위키' : selectedWiki ? `${selectedWiki} 위키` : '위키 선택 필요';
  return layout(
    configMap.title,
    `<main class="new-doc-shell">
      <section class="directory-head">
        <h1>${configMap.title}</h1>
        <p>${configMap.intro}</p>
      </section>
      ${creationFlowSummary([
        { label: '저장 위치', value: spaceLabelText, detail: '문서가 만들어질 위키 공간입니다.' },
        { label: '양식', value: templates.length ? `${templates.length}개` : '빈 문서', detail: templates.length ? '선택 가능한 시작 양식이 있습니다.' : '양식 없이 직접 작성합니다.' },
        { label: '저장 계정', value: user ? (user.display_name || user.username) : '로그인 필요', detail: user ? '저장 뒤 문서 역사에 표시됩니다.' : '편집 저장 전 로그인해야 합니다.' }
      ])}
      ${workflowSteps('문서 만들기 순서', [
        [kind === 'mod-page' || kind === 'server-page' ? '위키 선택' : '공간 확인', kind === 'mod-page' ? '문서를 넣을 모드 위키를 먼저 고릅니다.' : kind === 'server-page' ? '문서를 넣을 서버 위키를 먼저 고릅니다.' : '선택한 위키 공간에 문서를 만듭니다.'],
        ['제목 입력', '목차에 보일 문서 제목을 입력합니다. 슬래시를 쓰면 하위 문서가 됩니다.'],
        ['양식 선택', '빈 문서로 시작하거나 기존 양식을 적용해 편집 화면으로 이동합니다.']
      ])}
      <form class="new-doc-form guided-create-form" method="post" action="${configMap.action}">
        <section class="form-section">
          <h2>기본 정보</h2>
          ${wikiSelect}
          ${wikiEmptyCta}
          <label>문서 제목<input name="title" value="${escapeHtml(title)}" placeholder="${configMap.placeholder}" required></label>
          ${kind === 'dev' ? '<label>버전 기준<input name="version" value="Java Edition 1.21.x"></label>' : ''}
        </section>
        <section class="form-section">
          <h2>문서 양식</h2>
          <label>시작 양식
            <select name="template">
              <option value="">빈 문서 - ${escapeHtml(configMap.emptyDesc)}</option>
              ${templateOptions}
            </select>
          </label>
          ${kind === 'server-page' ? `<label>문서 영역
            <select name="area">${areaOptions.map(([value, label]) => `<option value="${value}"${values.area === value ? ' selected' : ''}>${label}</option>`).join('')}</select>
          </label><small class="form-hint">${areaOptions.map(([, label, desc]) => `${label}: ${desc}`).join(' ')}</small>` : ''}
        </section>
        <section class="create-preview">
          <strong>생성될 주소</strong>
          <code>${escapeHtml(`${previewBase}${title || configMap.placeholder}`)}</code>
          <small>예: ${configMap.examples.map((item) => escapeHtml(item)).join(' · ')}</small>
        </section>
        ${templateNote}
        <div class="form-submit-bar"><a class="button ghost" href="/new">취소</a><button>문서 만들기</button></div>
      </form>
    </main>`,
    user,
    newDocumentCurrentSpace(kind)
  );
}

function renderTemplateOptions(templates: any[], selected: unknown) {
  const selectedValue = String(selected ?? '');
  return templates
    .map((template) => {
      const value = String(template.id ?? template.template_key ?? '');
      const scope = template.template_scope === 'global' ? '전역' : '이 위키';
      return `<option value="${escapeHtml(value)}"${selectedValue === value || selectedValue === String(template.template_key ?? '') ? ' selected' : ''}>${escapeHtml(template.title)} (${scope})</option>`;
    })
    .join('');
}

function templateCreateUrl(kind: string, slug = '') {
  if (kind === 'mod-page' && slug) return `/mod/${encodeURIComponent(slug)}/templates/new`;
  if (kind === 'server-page' && slug) return `/server/${encodeURIComponent(slug)}/templates/new`;
  if (kind === 'dev') return '/templates/new?space=dev';
  return '/templates/new';
}

function documentTemplateNote(user: CurrentUser | null, kind: string, slug = '') {
  if (!user) {
    return '<aside class="doc-status"><strong>문서 양식 선택</strong><span>양식은 선택 사항입니다. 로그인하면 개인 문서 양식을 만들 수 있습니다.</span></aside>';
  }
  if ((kind === 'mod-page' || kind === 'server-page') && !slug) {
    return '<aside class="doc-status"><strong>문서 양식 선택</strong><span>양식은 선택 사항입니다. 위키를 선택한 뒤 그 위키 전용 양식을 만들 수 있습니다.</span></aside>';
  }
  return `<aside class="doc-status"><strong>문서 양식 선택</strong><span>양식은 선택 사항입니다. 원하는 양식이 없으면 빈 문서로 시작하거나 새 양식을 만들 수 있습니다.</span><a href="${templateCreateUrl(kind, slug)}">새 문서 양식 만들기</a></aside>`;
}

export function newSubwikiDocumentPage(kind: 'mod' | 'server', slug: string, user: CurrentUser | null, values: Record<string, string> = {}, templates: any[] = [], spaceExists = true) {
  const isServer = kind === 'server';
  if (!spaceExists) {
    return layout(
      `${slug} 위키 없음`,
      `<main class="new-doc-shell">
        <section class="directory-head">
          <h1>${escapeHtml(slug)} 위키를 찾을 수 없습니다</h1>
          <p>주소가 잘못되었거나 아직 만들어지지 않은 ${isServer ? '서버' : '모드'} 위키입니다.</p>
        </section>
        ${workflowSteps('다음 선택지', [
          ['목록에서 찾기', isServer ? '서버 허브에서 기존 서버 위키를 다시 선택합니다.' : '모드 허브에서 기존 모드 위키를 다시 선택합니다.'],
          ['새 위키 만들기', isServer ? '서버 운영자라면 새 서버 위키를 신청합니다.' : '새 모드 위키를 만들고 기본 문서를 준비합니다.'],
          ['기본 위키에 작성', '특정 위키가 아니어도 되는 내용은 기본 위키 문서로 만들 수 있습니다.']
        ])}
        <section class="new-wiki-cta">
          <h2>${isServer ? '서버 위키가 필요하신가요?' : '모드 위키가 필요하신가요?'}</h2>
          <div class="quick-actions">
            <a class="button" href="${isServer ? '/servers/new' : `/mods/new?slug=${encodeURIComponent(slug)}`}">${isServer ? '서버 위키 신청' : '모드 위키 만들기'}</a>
            <a class="button ghost" href="${isServer ? '/servers' : '/mods'}">${isServer ? '서버 허브' : '모드 허브'}</a>
            <a class="button ghost" href="/new/wiki?title=${encodeURIComponent(slug)}">기본 위키에 작성</a>
          </div>
        </section>
      </main>`,
      user,
      kind
    );
  }
  const title = values.title ?? '';
  const templateOptions = renderTemplateOptions(templates, values.template ?? values.templateId);
  const templateNote = user
    ? `<aside class="doc-status"><strong>문서 양식</strong><span>빈 문서로 시작해도 됩니다. 양식은 나중에 문서에 추가할 수 있습니다.</span><a href="/${kind}/${encodeURIComponent(slug)}/templates/new">새 양식 만들기</a></aside>`
    : '<aside class="doc-status"><strong>문서 양식</strong><span>빈 문서로 시작해도 됩니다. 로그인하면 이 위키의 개인 양식을 만들 수 있습니다.</span></aside>';
  return layout(
    `${slug} 위키에 새 문서 만들기`,
    `<main class="new-doc-shell">
      <section class="directory-head">
        <h1>${escapeHtml(slug)} 위키에 새 문서 만들기</h1>
        <p>이 위키 안에 들어갈 문서를 제목만 입력해서 만듭니다.</p>
      </section>
      ${creationFlowSummary([
        { label: '대상 위키', value: `${slug} 위키`, detail: isServer ? '서버 위키 하위 문서를 만듭니다.' : '모드 위키 하위 문서를 만듭니다.' },
        { label: '양식', value: templates.length ? `${templates.length}개` : '빈 문서', detail: templates.length ? '이 위키의 시작 양식을 선택할 수 있습니다.' : '양식 없이 바로 시작합니다.' },
        { label: '저장 계정', value: user ? (user.display_name || user.username) : '로그인 필요', detail: user ? '계정 기여로 기록됩니다.' : '저장 전 로그인이 필요합니다.' }
      ])}
      ${workflowSteps('이 위키에 문서 추가', [
        ['제목 입력', '현재 위키 안에 만들 하위 문서 제목을 정합니다.'],
        ['영역 확인', isServer ? '서버 문서는 공식/커뮤니티/검토 필요 영역 중 하나로 시작할 수 있습니다.' : '모드 문서는 설치, 설정, 아이템처럼 주제별 하위 문서로 나눕니다.'],
        ['편집 후 저장', '만들기 버튼을 누르면 편집 화면으로 이동합니다.']
      ])}
      ${values.templateSaved ? '<section class="doc-status"><strong>양식 저장 완료</strong><span>이 위키에 문서를 만들 때 방금 저장한 양식을 선택할 수 있습니다.</span></section>' : ''}
      <form class="new-doc-form guided-create-form" method="post" action="/${kind}/${encodeURIComponent(slug)}/new">
        <section class="form-section">
          <h2>기본 정보</h2>
          <label>문서 제목<input name="title" value="${escapeHtml(title)}" placeholder="${isServer ? '규칙' : '회전력'}" required></label>
          <label>문서 위치<input value="/${kind}/${escapeHtml(slug)}/" readonly></label>
        </section>
        <section class="form-section">
          <h2>문서 양식</h2>
          <label>시작 양식<select name="template"><option value="">빈 문서</option>${templateOptions}</select></label>
          ${isServer ? '<label>문서 영역<select name="area"><option value="community">커뮤니티 영역</option><option value="official">공식 영역</option><option value="review_required">검토 필요 영역</option></select></label>' : ''}
        </section>
        <section class="create-preview"><strong>생성될 주소</strong><code>/${kind}/${escapeHtml(slug)}/${escapeHtml(title || (isServer ? '규칙' : '회전력'))}</code></section>
        ${templateNote}
        <div class="form-submit-bar"><a class="button ghost" href="/${kind}/${encodeURIComponent(slug)}">취소</a><button>문서 만들기</button></div>
      </form>
    </main>`,
    user,
    kind
  );
}

export function newModWikiPage(user: CurrentUser | null, values: Record<string, string> = {}, starterSets: any[] = []) {
  const starterOptions = starterSetRadioCards(starterSets, values.starterSet || 'mod-minimal', 'mod-minimal');
  return layout(
    '새 모드 위키 만들기',
    `<main class="new-doc-shell">
      <section class="directory-head">
        <h1>새 모드 위키 만들기</h1>
        <p>모드 자체의 독립 위키를 만듭니다.</p>
      </section>
      ${creationLoginGate(user, '모드 위키 생성은 계정에 연결됩니다. 로그인하면 위키를 만들고 이후 관리 화면에서 문서를 정리할 수 있습니다.', '/mods/new')}
      ${workflowSteps('모드 위키 생성 순서', [
        ['모드 식별', '모드명과 URL 주소를 정해 독립 위키의 기준을 만듭니다.'],
        ['호환 정보 입력', '로더, 지원 버전, 클라이언트/서버 필요 여부를 기록합니다.'],
        ['기본 문서 생성', '선택한 시작 문서 세트로 대문과 핵심 문서를 자동 준비합니다.']
      ])}
      <form class="new-doc-form guided-create-form" method="post" action="/mods/new">
        <section class="form-section">
          <h2>기본 정보</h2>
          <div class="form-grid">
            <label>모드명<input name="title" value="${escapeHtml(values.title ?? '')}" placeholder="Create" required></label>
            <label>영문명<input name="englishName" value="${escapeHtml(values.englishName ?? '')}" placeholder="Create"></label>
          </div>
        </section>
        <section class="form-section">
          <h2>주소</h2>
          <label>URL 주소<span class="inline-prefix">/mod/</span><input name="slug" value="${escapeHtml(values.slug ?? '')}" placeholder="create" required></label>
        </section>
        <section class="form-section">
          <h2>분류와 지원 정보</h2>
          <div class="form-grid">
            <label>분류<input name="category" value="${escapeHtml(values.category ?? '')}" placeholder="기술, 자동화, 최적화"></label>
            <label>지원 버전<input name="supportedVersions" value="${escapeHtml(values.supportedVersions ?? '')}" placeholder="1.20.1 ~ 1.21.x"></label>
          </div>
          <div>
            <strong class="field-label">로더</strong>
            <div class="choice-row">
              ${checkboxChoice('loader', 'Fabric', 'Fabric', values.loader)}
              ${checkboxChoice('loader', 'Forge', 'Forge', values.loader)}
              ${checkboxChoice('loader', 'NeoForge', 'NeoForge', values.loader)}
              ${checkboxChoice('loader', 'Quilt', 'Quilt', values.loader)}
            </div>
          </div>
          <div class="form-grid">
            <label>클라이언트 필요 여부<select name="clientRequired"><option value="unknown">알 수 없음</option><option value="yes">예</option><option value="no">아니오</option><option value="optional">선택</option></select></label>
            <label>서버 필요 여부<select name="serverRequired"><option value="unknown">알 수 없음</option><option value="yes">예</option><option value="no">아니오</option><option value="optional">선택</option></select></label>
          </div>
        </section>
        <section class="form-section">
          <h2>링크</h2>
          <div class="form-grid">
            <label>공식 링크<input name="officialLink" value="${escapeHtml(values.officialLink ?? '')}" placeholder="https://"></label>
            <label>소스 코드<input name="sourceUrl" value="${escapeHtml(values.sourceUrl ?? '')}" placeholder="https://github.com/..."></label>
          </div>
        </section>
        <section class="form-section">
          <h2>시작 문서 세트</h2>
          <div class="choice-card-grid">${starterOptions}</div>
          <small class="form-hint">위키를 만들 때 기본으로 준비할 문서를 선택합니다. 나중에 문서를 추가하거나 삭제할 수 있습니다.</small>
        </section>
        <section class="create-preview"><strong>생성될 주소</strong><code>/mod/${escapeHtml(values.slug || 'create')}</code></section>
        <div class="form-submit-bar"><a class="button ghost" href="/mods">취소</a>${user ? '<button>모드 위키 만들기</button>' : `<a class="button" href="/login?next=%2Fmods%2Fnew">로그인 후 만들기</a>${disabledLoginSubmit('모드 위키 만들기')}`}</div>
      </form>
    </main>`,
    user,
    'mod'
  );
}

export function documentTemplateFormPage(user: CurrentUser | null, context: { kind: 'global' | 'mod' | 'server' | 'dev'; slug?: string; spaceTitle?: string }, values: Record<string, string> = {}) {
  const action = context.kind === 'mod' && context.slug
    ? `/mod/${encodeURIComponent(context.slug)}/templates/new`
    : context.kind === 'server' && context.slug
      ? `/server/${encodeURIComponent(context.slug)}/templates/new`
      : '/templates/new';
  const title = context.spaceTitle ? `${context.spaceTitle} 문서 양식 만들기` : '새 문서 양식 만들기';
  const scopeLabel = context.kind === 'global' ? '전역 양식' : context.kind === 'dev' ? '개발 위키' : `${context.spaceTitle ?? context.slug ?? '이 위키'} 전용`;
  return layout(
    title,
    `<main class="new-doc-shell">
      <section class="directory-head">
        <h1>${escapeHtml(title)}</h1>
        <p>새 문서를 만들 때 사용할 시작 양식을 저장합니다. 양식도 위키처럼 계속 고칠 수 있습니다.</p>
      </section>
      ${creationFlowSummary([
        { label: '적용 범위', value: scopeLabel, detail: '문서 만들기 화면에서 표시될 범위입니다.' },
        { label: '작성 계정', value: user ? (user.display_name || user.username) : '로그인 필요', detail: user ? '양식 수정 기록에 남습니다.' : '양식을 저장하려면 로그인해야 합니다.' },
        { label: '본문 기준', value: '위키 문법', detail: '저장한 내용이 새 문서의 시작 본문이 됩니다.' }
      ])}
      ${workflowSteps('양식 작성 순서', [
        ['이름과 키 지정', '문서 만들기 화면에서 찾을 수 있는 양식 이름과 짧은 키를 정합니다.'],
        ['적용 범위 선택', '전역, 이 위키 공식 양식, 개인 양식 중 실제 사용할 범위를 고릅니다.'],
        ['본문 저장', '기본 문서 내용을 저장하면 새 문서 작성 화면에서 시작 양식으로 사용할 수 있습니다.']
      ])}
      <form class="new-doc-form guided-create-form" method="post" action="${action}">
        <label>양식 이름<input name="title" value="${escapeHtml(values.title ?? '')}" placeholder="직업 설명 양식" required></label>
        <label>양식 키<input name="templateKey" value="${escapeHtml(values.templateKey ?? '')}" placeholder="job"></label>
        <label>설명<textarea name="description" rows="3" placeholder="어떤 문서에 쓰는 양식인지 적습니다.">${escapeHtml(values.description ?? '')}</textarea></label>
        <label>적용 범위
          <select name="templateScope">
            <option value="${context.kind === 'global' ? 'global' : 'space'}">${context.kind === 'global' ? '전역 양식' : '이 위키 공식 양식'}</option>
            <option value="user">내 개인 양식</option>
          </select>
        </label>
        <label>기본 영역
          <select name="targetArea">
            <option value="any">상관없음</option>
            <option value="official">공식 영역</option>
            <option value="community">커뮤니티 영역</option>
            <option value="review_required">검토 필요 영역</option>
          </select>
        </label>
        <label>기본 분류<input name="defaultCategory" value="${escapeHtml(values.defaultCategory ?? '')}" placeholder="예시서버 직업"></label>
        <label>기본 문서 내용<textarea name="content" rows="16" required>${escapeHtml(values.content ?? templateFormDefaultContent(context.kind))}</textarea></label>
        <div class="form-submit-bar"><button>양식 저장</button><a class="button ghost" href="/new">새 문서 만들기</a></div>
      </form>
    </main>`,
    user,
    context.kind === 'server' ? 'server' : context.kind === 'mod' ? 'mod' : context.kind === 'dev' ? 'dev' : 'template'
  );
}

function templateFormDefaultContent(kind: string) {
  if (kind === 'server') return `{{문서 상태\n|상태=검증 필요\n}}\n\n'''{{문서명}}''' 문서입니다.\n\n== 개요 ==\n\n== 내용 ==\n\n== 관련 문서 ==\n`;
  if (kind === 'mod') return `{{문서 상태\n|상태=검증 필요\n}}\n\n'''{{문서명}}'''은 이 모드의 문서입니다.\n\n== 개요 ==\n\n== 사용법 ==\n\n== 관련 문서 ==\n`;
  if (kind === 'dev') return `{{개발 문서 상태\n|검증=필요\n}}\n\n'''{{문서명}}''' 개발 문서입니다.\n\n== 개요 ==\n\n== 예제 ==\n`;
  return `{{문서 상태\n|상태=검증 필요\n}}\n\n'''{{문서명}}''' 문서입니다.\n\n== 개요 ==\n\n== 관련 문서 ==\n`;
}

function sidebarParentSelect(items: any[], current: any = null, label = '상위 항목') {
  const currentId = current?.id ? String(current.id) : '';
  const currentParentId = current?.parent_id ? String(current.parent_id) : '';
  const options = [
    `<option value="">${escapeHtml(label)}: 최상위</option>`,
    ...sidebarOptionRows(items)
      .filter((item) => String(item.id) !== currentId)
      .map((item) => `<option value="${escapeHtml(String(item.id))}"${String(item.id) === currentParentId ? ' selected' : ''}>${escapeHtml(`${'-- '.repeat(item.depth)}${item.label}`)}</option>`)
  ].join('');
  return `<select name="parentId" aria-label="${escapeHtml(label)}">${options}</select>`;
}

function sidebarParentLabel(items: any[], parentId: unknown) {
  if (!parentId) return '최상위';
  const parent = items.find((item) => String(item.id) === String(parentId));
  return parent ? String(parent.label ?? parent.target_title ?? parent.title ?? '상위 항목') : '상위 항목 없음';
}

function sidebarOptionRows(items: any[]) {
  const byParent = new Map<string, any[]>();
  const ids = new Set(items.map((item) => String(item.id)));
  for (const item of items) {
    const parentId = item.parent_id ? String(item.parent_id) : '';
    const key = parentId && ids.has(parentId) ? parentId : 'root';
    byParent.set(key, [...(byParent.get(key) ?? []), item]);
  }
  const rows: Array<{ id: unknown; label: string; depth: number }> = [];
  const walk = (parentKey: string, depth: number, trail: Set<string>) => {
    for (const item of byParent.get(parentKey) ?? []) {
      const id = String(item.id);
      if (trail.has(id)) continue;
      rows.push({ id: item.id, label: String(item.label ?? item.target_title ?? item.title ?? '문서'), depth });
      walk(id, depth + 1, new Set([...trail, id]));
    }
  };
  walk('root', 0, new Set());
  return rows;
}

export function serverOperatorDashboardPage(space: any, docs: any[], sidebar: any[], roles: any[], jobs: any[], settings: any, seasons: any[], serverInfo: any, user: CurrentUser | null, billing: any = {}) {
  const slug = String(space.slug ?? space.code?.replace(/^server-/, '') ?? '');
  const plan = billing.plan ?? { plan_key: 'free', name: 'Free', price_monthly_krw: 0 };
  const features = billing.features ?? {};
  const theme = billing.theme ?? {};
  const docRows = docs
    .map(
      (doc) => `<tr><td><a href="${wikiUrl('server', doc.title)}">${escapeHtml(subwikiDocumentLabel(doc.title, slug, doc.display_title))}</a></td><td>${escapeHtml(qualityStatusLabel(doc.quality_status))}</td><td>${escapeHtml(formatDateTime(doc.updated_at))}</td></tr>`
    )
    .join('');
  const sidebarRows = sidebar
    .map(
      (item) => {
        const targetTitle = String(item.target_title ?? '');
        const targetCell = targetTitle ? `<a href="${wikiUrl('server', targetTitle)}">${escapeHtml(subwikiDocumentLabel(targetTitle, slug))}</a>` : '<span class="sidebar-muted">대상 없음</span>';
        return `<tr><td>${escapeHtml(item.label)}</td><td>${escapeHtml(sidebarParentLabel(sidebar, item.parent_id))}</td><td>${targetCell}</td><td><form method="post" action="/server/${encodeURIComponent(slug)}/manage/sidebar" class="inline-form sidebar-edit-form"><input type="hidden" name="itemId" value="${item.id}"><input name="label" value="${escapeHtml(item.label)}" aria-label="사이드바 라벨">${sidebarParentSelect(sidebar, item)}<input name="sortOrder" value="${escapeHtml(String(item.sort_order ?? 0))}" aria-label="정렬 순서"><button>저장</button></form></td></tr>`;
      }
    )
    .join('');
  const roleRows = roles
    .map(
      (role) => `<tr>
        <td>${escapeHtml(role.display_name)}</td>
        <td>${escapeHtml(roleLabel(role.role))}</td>
        <td>${escapeHtml(genericStatusLabel(String(role.status ?? 'active')))}</td>
        <td><form method="post" action="/server/${encodeURIComponent(slug)}/manage/roles/${role.id}/revoke" class="inline-form"><button>해지</button></form></td>
      </tr>`
    )
    .join('');
  const jobRows = jobs.map((job) => `<tr><td>${escapeHtml(importSourceLabel(job.source_type))}</td><td>${escapeHtml(genericStatusLabel(String(job.status ?? 'pending')))}</td><td>${escapeHtml(job.source_note ?? '')}</td></tr>`).join('');
  const domainRows = (billing.domains ?? [])
    .map(
      (domain: any) => `<tr>
        <td>${escapeHtml(domain.domain)}<small>TXT ${escapeHtml(domain.dns_record_name)} = ${escapeHtml(domain.dns_record_value)}</small></td>
        <td>${escapeHtml(domainStatusLabel(domain.status))} / SSL ${escapeHtml(sslStatusLabel(domain.ssl_status))}</td>
        <td class="inline-actions">${domainActionForms(slug, domain)}</td>
      </tr>`
    )
    .join('');
  const planCards = (billing.plans ?? [])
    .map((item: any) => {
      const itemFeatures = safeObject(item.features_json);
      return `<div class="plan-card${item.plan_key === plan.plan_key ? ' active' : ''}">
        <strong>${escapeHtml(item.name)}</strong>
        <span>${Number(item.price_monthly_krw ?? 0).toLocaleString('ko-KR')}원/월</span>
        <small>운영자 ${escapeHtml(String(itemFeatures.operatorLimit ?? 1))}명 · ${itemFeatures.customDomain ? '커스텀 도메인' : '기본 주소'} · ${itemFeatures.whiteLabel ? '화이트라벨' : 'MineWiki 브랜딩'}</small>
      </div>`;
    })
    .join('');
  const seasonRows = seasons
    .map((season) => {
      const title = escapeHtml(season.title);
      const titleCell = season.page_id ? `<a href="${wikiUrl('server', `${slug}/${season.title}`)}">${title}</a>` : `<span>${title}</span>`;
      return `<tr><td>${titleCell}</td><td>${escapeHtml(genericStatusLabel(String(season.status ?? 'planned')))}</td><td>${escapeHtml(formatDateTime(season.starts_at, ''))}</td><td>${escapeHtml(formatDateTime(season.ends_at, ''))}</td></tr>`;
    })
    .join('');
  const protectionOptions = [
    ['open', '누구나 편집'],
    ['login_required', '로그인 사용자'],
    ['review_required', '검토 후 반영'],
    ['autoconfirmed_only', '자동 인증 사용자'],
    ['trusted_only', '신뢰 사용자'],
    ['official_only', '서버 운영자'],
    ['admin_only', '관리자'],
    ['locked', '전체 잠금']
  ]
    .map(([value, label]) => `<option value="${value}"${value === 'official_only' ? ' selected' : ''}>${label}</option>`)
    .join('');
  const customDomainLockId = 'custom-domain-plan-lock';
  const themeLockId = 'theme-plan-lock';
  const customCssLockId = 'custom-css-plan-lock';
  const markdownImportLockId = 'markdown-import-plan-lock';
  const customDomainLock = features.customDomain ? '' : operatorFeatureLock('Pro', '커스텀 도메인', '서버 문서를 별도 도메인으로 연결하려면 플랜을 올려야 합니다.', customDomainLockId);
  const themeLock = features.themeTokens ? '' : operatorFeatureLock('Plus', '서버 테마', '색상, 배경 모드, 서버 브랜드 우선 표시는 Plus 이상에서 사용할 수 있습니다.', themeLockId);
  const customCssLock = features.customCss ? '' : operatorFeatureLock('Business', '제한 CSS', '운영팀 검토가 필요한 CSS 커스터마이징은 Business 플랜에서 열립니다.', customCssLockId);
  const markdownImportLock = features.markdownImport ? '' : operatorFeatureLock('Pro', 'Markdown/GitBook 이전', '기존 GitBook export, Markdown 묶음, SUMMARY.md 문서 트리 가져오기는 Pro 이상에서 사용할 수 있습니다.', markdownImportLockId);
  const customDomainDisabledAttrs = disabledFeatureAttrs(features.customDomain, customDomainLockId, 'Pro 이상에서 커스텀 도메인을 사용할 수 있습니다.');
  const themeDisabledAttrs = disabledFeatureAttrs(features.themeTokens, themeLockId, 'Plus 이상에서 서버 테마를 수정할 수 있습니다.');
  const customCssDisabledAttrs = disabledFeatureAttrs(features.customCss, customCssLockId, 'Business 플랜에서 제한 CSS 검토를 요청할 수 있습니다.');
  const markdownImportDisabledAttrs = disabledFeatureAttrs(features.markdownImport, markdownImportLockId, 'Pro 이상에서 Markdown/GitBook 이전을 사용할 수 있습니다.');
  return layout(
    `${space.title ?? space.name} 운영자 대시보드`,
    `<main class="operator-shell space-server">
      <section class="operator-head">
        <div>
          <span class="space-badge">[서버 공식 위키]</span>
          <h1>${escapeHtml(space.title ?? space.name)}</h1>
          <p>공식 문서 트리, 템플릿 문서, GitBook 이전 상태를 한 화면에서 관리합니다.</p>
        </div>
        <div class="quick-actions">
          <a class="button" href="/server/${encodeURIComponent(slug)}">공식 위키 보기</a>
          <a class="button ghost" href="/server/${encodeURIComponent(slug)}/claim">운영자 DNS 인증</a>
        </div>
      </section>
      <section class="doc-status">
        <strong>운영자 인증</strong>
        <span>${escapeHtml(serverVerificationLabel(serverInfo?.verified_status ?? 'pending'))} · 운영자 인증은 서버 품질 보증이 아니라 공식 영역 관리 권한 확인 절차입니다.</span>
      </section>
      <section class="operator-panel">
        <h2>서버 위키 플랜</h2>
        <p>현재 플랜: <strong>${escapeHtml(plan.name ?? plan.plan_key)}</strong> · 검색 순위, 운영자 인증 배지, 서버 품질 표시는 판매하지 않습니다.</p>
        <div class="plan-grid">${planCards || '<span class="sidebar-muted">플랜 정보가 없습니다.</span>'}</div>
        ${canAccessAdminTools(user) ? `<form class="inline-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/subscription">
          <select name="planKey">
            ${['free', 'plus', 'pro', 'business'].map((key) => `<option value="${key}"${plan.plan_key === key ? ' selected' : ''}>${key}</option>`).join('')}
          </select>
          <button>관리자 플랜 적용</button>
        </form>` : ''}
      </section>
      <section class="operator-grid">
        <form class="operator-panel" method="post" action="/server/${encodeURIComponent(slug)}/manage/documents">
          <h2>빠른 새 문서</h2>
          <input name="title" placeholder="문서 제목: 시즌 안내">
          ${sidebarParentSelect(sidebar, null, '상위 사이드바')}
          <select name="template">
            <option value="generic">기본 문서</option>
            <option value="rules">규칙</option>
            <option value="notice">공지</option>
            <option value="donation">후원 정책</option>
            <option value="sanction">제재 기준</option>
          </select>
          <button>문서 생성</button>
        </form>
        <section class="operator-panel">
          <h2>쉬운 편집</h2>
          <form class="stack-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/easy-edit">
            <input type="hidden" name="docType" value="connection">
            <strong>접속 정보 편집</strong>
            <input name="host" value="${escapeHtml(serverInfo?.host ?? '')}" placeholder="서버 주소">
            <input name="supportedVersions" value="${escapeHtml(serverInfo?.supported_versions ?? '')}" placeholder="지원 버전">
            <input name="whitelist" placeholder="화이트리스트 여부">
            <textarea name="body" rows="3" placeholder="접속 절차, 서버 리소스팩, 디스코드 안내"></textarea>
            <button>접속 정보 저장</button>
          </form>
          <form class="stack-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/easy-edit">
            <input type="hidden" name="docType" value="rules">
            <strong>규칙 편집</strong>
            <input name="ruleTitle" placeholder="규칙 제목">
            <textarea name="ruleBody" rows="3" placeholder="규칙 내용"></textarea>
            <input name="scope" placeholder="적용 범위">
            <input name="link" placeholder="관련 링크">
            <button>규칙 저장</button>
          </form>
          <form class="stack-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/easy-edit">
            <input type="hidden" name="docType" value="notice">
            <strong>공지 작성</strong>
            <input name="noticeTitle" placeholder="공지 제목">
            <textarea name="noticeBody" rows="3" placeholder="공지 내용"></textarea>
            <label><input type="checkbox" name="pinned" value="1"> 고정 공지</label>
            <input name="startsAt" type="date" aria-label="공지 시작일">
            <input name="endsAt" type="date" aria-label="공지 종료일">
            <button>공지 저장</button>
          </form>
          <form class="stack-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/easy-edit">
            <input type="hidden" name="docType" value="donation">
            <strong>후원 정책 편집</strong>
            <textarea name="donationBody" rows="3" placeholder="후원 안내"></textarea>
            <textarea name="refundPolicy" rows="2" placeholder="환불 정책"></textarea>
            <input name="link" placeholder="후원/정책 링크">
            <button>후원 정책 저장</button>
          </form>
          <form class="stack-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/easy-edit">
            <input type="hidden" name="docType" value="sanction">
            <strong>제재 기준 편집</strong>
            <textarea name="sanctionBody" rows="3" placeholder="제재 단계와 기준"></textarea>
            <input name="appealLink" placeholder="이의 제기 경로">
            <button>제재 기준 저장</button>
          </form>
        </section>
        <form class="operator-panel" method="post" action="/server/${encodeURIComponent(slug)}/manage/status">
          <h2>서버 상태 설정</h2>
          <input name="host" value="${escapeHtml(serverInfo?.host ?? '')}" placeholder="서버 주소">
          <select name="edition">
            ${['java', 'bedrock', 'crossplay', 'unknown'].map((edition) => option(edition, serverInfo?.edition, serverEditionLabel(edition))).join('')}
          </select>
          <input name="supportedVersions" value="${escapeHtml(serverInfo?.supported_versions ?? '')}" placeholder="지원 버전">
          <input name="genres" value="${escapeHtml(serverInfo?.genres ?? '')}" placeholder="장르">
          <select name="operationalStatus">
            ${['active', 'checking_failed', 'inactive', 'closed', 'disputed', 'unverified'].map((status) => `<option value="${status}"${serverInfo?.operational_status === status ? ' selected' : ''}>${serverOperationalLabel(status)}</option>`).join('')}
          </select>
          <label><input type="checkbox" name="statusEnabled" value="1"${serverInfo?.status_enabled ? ' checked' : ''}> 상태 확인 사용</label>
          <button>서버 상태 저장</button>
        </form>
        <section class="operator-panel">
          <h2>권한</h2>
          <form class="inline-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/roles">
            <input name="username" placeholder="사용자명 또는 이메일">
            <select name="role"><option value="editor">${roleLabel('editor')}</option><option value="manager">${roleLabel('manager')}</option><option value="owner">${roleLabel('owner')}</option></select>
            <button>운영자 추가</button>
          </form>
          ${componentTableMarkup(`<thead><tr><th>사용자</th><th>역할</th><th>상태</th><th>작업</th></tr></thead><tbody>${roleRows || emptyTableRow(4, '등록된 운영자 없음', '서버 위키를 함께 관리할 사용자를 위 폼에서 추가하세요.')}</tbody>`)}
        </section>
        <form class="operator-panel" method="post" action="/server/${encodeURIComponent(slug)}/manage/permissions">
          <h2>문서 편집 권한</h2>
          <select name="protectionLevel">${protectionOptions}</select>
          <label><input type="checkbox" name="applyAll" value="1" checked> 이 서버 위키 전체 문서에 적용</label>
          <input name="reason" placeholder="변경 사유">
          <button>권한 적용</button>
        </form>
        <form class="operator-panel" method="post" action="/server/${encodeURIComponent(slug)}/manage/settings">
          <h2>주소 설정</h2>
          <input name="shortPath" value="${escapeHtml(settings?.short_path ?? `/server/${slug}`)}" placeholder="/server/example">
          <label><input type="checkbox" name="allowPublicEdit" value="1"${settings?.allow_public_edit ?? settings?.public_edit_enabled ? ' checked' : ''}> 공개 편집 허용</label>
          <label><input type="checkbox" name="requireReview" value="1"${settings?.require_review ?? settings?.review_required ? ' checked' : ''}> 공개 편집 검토 필요</label>
          <button>주소 저장</button>
        </form>
        <section class="operator-panel">
          <h2>커스텀 도메인</h2>
          <p class="muted">Pro 이상에서 서버 문서 도메인을 연결합니다. CNAME은 <code>custom.minewiki.kr</code>, TXT는 아래 값으로 확인합니다.</p>
          ${customDomainLock}
          <form class="inline-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/custom-domain">
            <input name="domain" placeholder="wiki.example.kr"${customDomainDisabledAttrs}>
            <button${customDomainDisabledAttrs}>도메인 추가</button>
          </form>
          ${componentTableMarkup(`<thead><tr><th>도메인/검증값</th><th>상태</th><th>작업</th></tr></thead><tbody>${domainRows || emptyTableRow(3, '등록된 도메인 없음', '서버 문서에 별도 도메인을 연결하려면 Pro 이상에서 도메인을 추가하세요.')}</tbody>`)}
        </section>
        <section class="operator-panel">
          <h2>테마</h2>
          ${themeLock}
          <form class="stack-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/theme">
            <select name="themeKey"${themeDisabledAttrs}>
              ${['default', 'dark-server', 'rpg', 'economy', 'minimal-docs', 'pixel-classic'].map((key) => option(key, theme.theme_key, serverThemeOptionLabel(key))).join('')}
            </select>
            <input name="primaryColor" value="${escapeHtml(theme.primary_color ?? '')}" placeholder="#00a495"${themeDisabledAttrs}>
            <input name="accentColor" value="${escapeHtml(theme.accent_color ?? '')}" placeholder="#38bdf8"${themeDisabledAttrs}>
            <select name="backgroundMode"${themeDisabledAttrs}>${['system', 'light', 'dark'].map((value) => option(value, theme.background_mode, themeBackgroundLabel(value))).join('')}</select>
            <select name="brandingMode"${themeDisabledAttrs}><option value="minewiki">MineWiki 표시</option><option value="compact"${theme.branding_mode === 'compact' ? ' selected' : ''}>서버 브랜드 우선</option><option value="white_label"${theme.branding_mode === 'white_label' ? ' selected' : ''}${features.whiteLabel ? '' : ' disabled'}>화이트라벨</option></select>
            <button${themeDisabledAttrs}>테마 저장</button>
          </form>
          ${customCssLock}
          <form class="stack-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/theme/css">
            <textarea name="customCss" rows="5" placeholder="제한 CSS"${customCssDisabledAttrs}>${escapeHtml(theme.custom_css ?? '')}</textarea>
            <small>상태: ${escapeHtml(customCssStatusLabel(theme.custom_css_status))} · script, iframe, @import, 외부 URL, 고정 오버레이는 차단됩니다.</small>
            <button${customCssDisabledAttrs}>CSS 검토 요청</button>
          </form>
        </section>
      </section>
      <section class="operator-panel">
        <h2>시즌 관리</h2>
        <form class="inline-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/seasons">
          <input name="title" placeholder="시즌 2">
          <select name="status"><option value="planned">예정</option><option value="active">진행 중</option><option value="archived">종료</option></select>
          <input name="startsAt" type="date" aria-label="시즌 시작일">
          <input name="endsAt" type="date" aria-label="시즌 종료일">
          <input name="summary" placeholder="월드 초기화, 경제 개편 등">
          <button>시즌 추가</button>
        </form>
        ${componentTableMarkup(`<thead><tr><th>시즌</th><th>상태</th><th>시작</th><th>종료</th></tr></thead><tbody>${seasonRows || emptyTableRow(4, '등록된 시즌 없음', '월드 초기화나 대형 업데이트 단위를 시즌으로 기록하면 서버 문서 변경 맥락을 추적할 수 있습니다.')}</tbody>`)}
      </section>
      <section class="operator-panel">
        <h2>문서 트리</h2>
        ${componentTableMarkup(`<thead><tr><th>문서</th><th>검사 상태</th><th>수정일</th></tr></thead><tbody>${docRows || emptyTableRow(3, '문서 없음', '위의 빠른 작성 버튼으로 규칙, 접속 방법, 공지 같은 첫 문서를 만드세요.', `/server/${encodeURIComponent(slug)}/new`, '문서 만들기')}</tbody>`)}
      </section>
      <section class="operator-panel">
        <h2>사이드바</h2>
        <p class="muted">상위 항목을 지정하면 방문자 화면의 문서 트리에 부모-자식 관계로 표시됩니다.</p>
        ${componentTableMarkup(`<thead><tr><th>라벨</th><th>상위</th><th>대상</th><th>정렬/수정</th></tr></thead><tbody>${sidebarRows || emptyTableRow(4, '사이드바 항목 없음', '문서가 만들어지면 사이드바에 넣어 방문자가 공식 문서를 빠르게 찾게 하세요.')}</tbody>`)}
      </section>
      <section class="operator-panel">
        <h2>GitBook 이전</h2>
        ${markdownImportLock}
        <form class="stack-form" method="post" action="/server/${encodeURIComponent(slug)}/manage/import" enctype="multipart/form-data">
          <input name="sourceNote" placeholder="소스 메모: GitBook export 2026-05"${markdownImportDisabledAttrs}>
          <input type="file" name="archive" accept=".zip,.md,.markdown" aria-label="Markdown 또는 GitBook 파일"${markdownImportDisabledAttrs}>
          <textarea name="summary" rows="5" placeholder="SUMMARY.md 목차를 붙여넣으면 문서 트리와 사이드바 순서에 반영됩니다."${markdownImportDisabledAttrs}></textarea>
          <textarea name="markdown" rows="8" placeholder="# 규칙&#10;&#10;서버 규칙 내용...&#10;---&#10;# 접속 방법&#10;&#10;접속 안내..."${markdownImportDisabledAttrs}></textarea>
          <button${markdownImportDisabledAttrs}>Markdown 가져오기</button>
        </form>
        ${componentTableMarkup(`<thead><tr><th>소스</th><th>상태</th><th>메모</th></tr></thead><tbody>${jobRows || emptyTableRow(3, '이전 작업 없음', 'GitBook이나 Markdown 문서를 가져오면 작업 기록과 결과가 여기에 표시됩니다.')}</tbody>`)}
      </section>
      <section class="operator-panel">
        <h2>문서 내보내기</h2>
        <div class="quick-actions">
          <a class="button ghost" href="/server/${encodeURIComponent(slug)}/export?format=markdown">Markdown</a>
          <a class="button ghost" href="/server/${encodeURIComponent(slug)}/export?format=tree">문서 트리 내려받기</a>
          <a class="button ghost" href="/server/${encodeURIComponent(slug)}/export?format=sidebar">사이드바 내려받기</a>
          <a class="button ghost" href="/server/${encodeURIComponent(slug)}/export?format=files">파일 목록 내려받기</a>
        </div>
      </section>
    </main>`,
    user,
    'server'
  );
}

function subwikiDocumentLabel(title: unknown, root: string, displayTitle: unknown = '') {
  const shown = String(displayTitle ?? '').trim();
  if (shown) return shown.split('/').pop() || shown;
  const raw = String(title ?? '').trim();
  const prefix = `${root}/`;
  return raw.toLowerCase().startsWith(prefix.toLowerCase()) ? raw.slice(prefix.length) || raw : raw;
}

function serverThemeOptionLabel(value: string) {
  const labels: Record<string, string> = {
    default: '기본 위키',
    'dark-server': '어두운 서버',
    rpg: 'RPG 서버',
    economy: '경제 서버',
    'minimal-docs': '문서 중심',
    'pixel-classic': '클래식 픽셀'
  };
  return labels[value] ?? value;
}

function themeBackgroundLabel(value: string) {
  const labels: Record<string, string> = {
    system: '기기 설정 따름',
    light: '밝은 배경',
    dark: '어두운 배경'
  };
  return labels[value] ?? value;
}

function customCssStatusLabel(value: unknown) {
  const labels: Record<string, string> = {
    none: '등록 없음',
    pending: '검토 대기',
    approved: '승인됨',
    rejected: '반려됨',
    disabled: '사용 안 함'
  };
  return labels[String(value ?? 'none')] ?? String(value ?? 'none');
}

export function modOperatorDashboardPage(space: any, docs: any[], sidebar: any[], roles: any[], settings: any, modInfo: any, user: CurrentUser | null) {
  const slug = String(space.slug ?? space.code?.replace(/^mod-/, '') ?? '');
  const wikiTitle = String(space.title ?? space.name ?? slug);
  const docCount = docs.length;
  const sidebarCount = sidebar.length;
  const roleCount = roles.filter((role) => String(role.status ?? 'active') === 'active').length;
  const dataChecks = modOperatorDataChecks(modInfo, settings);
  const summaryCards = [
    ['문서', `${docCount}개`, docCount ? '문서 트리가 준비되어 있습니다.' : '설치/설정/호환성 첫 문서가 필요합니다.', `/mod/${encodeURIComponent(slug)}/new`],
    ['사이드바', `${sidebarCount}개`, sidebarCount ? '독자가 주요 문서를 따라갈 수 있습니다.' : '주요 문서를 사이드바에 배치하세요.', ''],
    ['담당자', `${roleCount}명`, roleCount ? '운영 역할이 등록되어 있습니다.' : '공동 편집자나 검토자를 추가하세요.', ''],
    ['데이터 완성도', `${dataChecks.done}/${dataChecks.total}`, dataChecks.missing.length ? `${dataChecks.missing.join(', ')} 보강 필요` : '모드 기본 데이터가 채워져 있습니다.', '']
  ]
    .map(([label, value, detail, href]) => {
      const content = `<strong>${escapeHtml(label)}</strong> <span>${escapeHtml(value)}</span> <small>${escapeHtml(detail)}</small>`;
      return href ? `<a class="operator-card" href="${escapeHtml(href)}">${content}</a>` : `<div class="operator-card">${content}</div>`;
    })
    .join('');
  const docRows = docs
    .map((doc) => `<tr><td><a href="${wikiUrl('mod', doc.title)}">${escapeHtml(subwikiDocumentLabel(doc.title, slug, doc.display_title))}</a></td><td>${escapeHtml(qualityStatusLabel(doc.quality_status))}</td><td>${escapeHtml(formatDateTime(doc.updated_at))}</td></tr>`)
    .join('');
  const sidebarRows = sidebar
    .map((item) => {
      const targetTitle = String(item.target_title ?? '');
      const targetCell = targetTitle ? `<a href="${wikiUrl('mod', targetTitle)}">${escapeHtml(subwikiDocumentLabel(targetTitle, slug))}</a>` : '<span class="sidebar-muted">대상 없음</span>';
      return `<tr><td>${escapeHtml(item.label)}</td><td>${escapeHtml(sidebarParentLabel(sidebar, item.parent_id))}</td><td>${targetCell}</td><td><form method="post" action="/mod/${encodeURIComponent(slug)}/manage/sidebar" class="inline-form sidebar-edit-form"><input type="hidden" name="itemId" value="${item.id}"><input name="label" value="${escapeHtml(item.label)}" aria-label="사이드바 라벨">${sidebarParentSelect(sidebar, item)}<input name="sortOrder" value="${escapeHtml(String(item.sort_order ?? 0))}" aria-label="정렬 순서"><button>저장</button></form></td></tr>`;
    })
    .join('');
  const roleRows = roles
    .map((role) => `<tr>
      <td>${escapeHtml(role.display_name ?? role.username ?? '알 수 없음')}</td>
      <td>${escapeHtml(roleLabel(role.role))}</td>
      <td>${escapeHtml(genericStatusLabel(String(role.status ?? 'active')))}</td>
      <td>${String(role.status ?? 'active') === 'active' && role.id ? `<form method="post" action="/mod/${encodeURIComponent(slug)}/manage/roles/${escapeHtml(String(role.id))}/revoke" class="inline-form"><button>해지</button></form>` : ''}</td>
    </tr>`)
    .join('');
  return layout(
    `${wikiTitle} 모드 위키 관리`,
    `<main class="operator-shell space-mod">
      <section class="operator-head">
        <div>
          <span class="space-badge">[모드 위키]</span>
          <h1>${escapeHtml(wikiTitle)}</h1>
          <p>모드별 문서 트리, 버전/의존성 데이터, 사이드바를 관리합니다.</p>
        </div>
        <div class="quick-actions">
          <a class="button" href="/mod/${encodeURIComponent(slug)}/대문">모드 위키 보기</a>
          <a class="button ghost" href="/search?q=${encodeURIComponent(space.title ?? slug)}&space=${encodeURIComponent(space.code ?? 'mod')}">위키 내부 검색</a>
        </div>
      </section>
      <section class="operator-summary">${summaryCards}</section>
      <section class="doc-status">
        <strong>운영 체크리스트</strong>
        <span>${escapeHtml(dataChecks.missing.length ? `${dataChecks.missing.join(', ')} 정보를 보강하면 검색과 문서 안내가 더 명확해집니다.` : '기본 모드 데이터가 채워져 있습니다. 문서 검토와 버전 갱신에 집중하세요.')}</span>
      </section>
      <section class="operator-grid">
        <form class="operator-panel" method="post" action="/mod/${encodeURIComponent(slug)}/manage/documents">
          <h2>빠른 새 문서</h2>
          <input name="title" placeholder="문서 제목: 아이템">
          ${sidebarParentSelect(sidebar, null, '상위 사이드바')}
          <select name="template">
            <option value="generic">기본 문서</option>
            <option value="item">아이템 목록</option>
            <option value="block">블록 목록</option>
            <option value="machine">기계/시스템</option>
            <option value="compatibility">호환성/의존성</option>
            <option value="version">버전별 변경점</option>
          </select>
          <button>문서 생성</button>
        </form>
        <form class="operator-panel" method="post" action="/mod/${encodeURIComponent(slug)}/manage/settings">
          <h2>모드 데이터</h2>
          <input name="category" value="${escapeHtml(modInfo?.category ?? '')}" placeholder="분류">
          <input name="loaders" value="${escapeHtml(modInfo?.loaders ?? '')}" placeholder="로더">
          <input name="supportedVersions" value="${escapeHtml(modInfo?.supported_versions ?? '')}" placeholder="지원 버전">
          <input name="officialUrl" value="${escapeHtml(modInfo?.official_url ?? '')}" placeholder="공식 링크">
          <input name="sourceUrl" value="${escapeHtml(modInfo?.source_url ?? '')}" placeholder="소스 코드">
          <input name="license" value="${escapeHtml(modInfo?.license ?? '')}" placeholder="라이선스">
          <label><input type="checkbox" name="allowPublicEdit" value="1"${settings?.allow_public_edit ?? settings?.public_edit_enabled ? ' checked' : ''}> 공개 편집 허용</label>
          <label><input type="checkbox" name="requireReview" value="1"${settings?.require_review ?? settings?.review_required ? ' checked' : ''}> 공개 편집 검토 필요</label>
          <button>저장</button>
        </form>
      </section>
      <section class="operator-panel">
        <h2>문서 트리</h2>
        ${componentTableMarkup(`<thead><tr><th>문서</th><th>검사 상태</th><th>수정일</th></tr></thead><tbody>${docRows || emptyTableRow(3, '문서 없음', '위의 빠른 작성 버튼으로 설치, 설정, 호환성 같은 첫 문서를 만드세요.', `/mod/${encodeURIComponent(slug)}/new`, '문서 만들기')}</tbody>`)}
      </section>
      <section class="operator-panel">
        <h2>사이드바</h2>
        <p class="muted">설치, 시스템, 아이템처럼 상위 항목을 나누면 읽는 사람이 문서 흐름을 바로 파악할 수 있습니다.</p>
        ${componentTableMarkup(`<thead><tr><th>라벨</th><th>상위</th><th>대상</th><th>정렬/수정</th></tr></thead><tbody>${sidebarRows || emptyTableRow(4, '사이드바 항목 없음', '문서가 만들어지면 주요 문서를 사이드바에 배치해 독자가 설치와 설정 흐름을 따라가게 하세요.')}</tbody>`)}
      </section>
      <section class="operator-panel">
        <h2>권한</h2>
        <form class="filter-bar" method="post" action="/mod/${encodeURIComponent(slug)}/manage/roles">
          <input name="username" placeholder="사용자명 또는 이메일">
          <select name="role">
            <option value="editor">편집자</option>
            <option value="reviewer">검토자</option>
            <option value="manager">관리자</option>
            <option value="owner">소유자</option>
          </select>
          <button>역할 추가</button>
        </form>
        ${componentTableMarkup(`<thead><tr><th>사용자</th><th>역할</th><th>상태</th><th>작업</th></tr></thead><tbody>${roleRows || emptyTableRow(4, '등록된 역할 없음', '모드 위키 담당자와 검증자를 추가하면 문서 작성과 검토 책임을 분리할 수 있습니다.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'mod'
  );
}

function operatorFeatureLock(planName: string, featureName: string, detail: string, id?: string) {
  return `<aside class="operator-feature-lock"${id ? ` id="${escapeHtml(id)}"` : ''} aria-label="${escapeHtml(featureName)} 플랜 제한">
    <strong>${escapeHtml(featureName)} 잠김</strong>
    <span>${escapeHtml(detail)}</span>
    <small>필요 플랜: ${escapeHtml(planName)} 이상. 현재 화면의 플랜 선택에서 변경하면 이 컨트롤이 활성화됩니다.</small>
  </aside>`;
}

function disabledFeatureAttrs(enabled: boolean, describedBy: string, reason: string) {
  return enabled ? '' : ` disabled title="${escapeHtml(reason)}" aria-describedby="${escapeHtml(describedBy)}"`;
}

function modOperatorDataChecks(modInfo: any, settings: any) {
  const checks: Array<[string, unknown]> = [
    ['분류', modInfo?.category],
    ['로더', modInfo?.loaders],
    ['지원 버전', modInfo?.supported_versions],
    ['공식 링크', modInfo?.official_url],
    ['소스 코드', modInfo?.source_url],
    ['라이선스', modInfo?.license],
    ['편집 정책', settings?.require_review ?? settings?.review_required]
  ];
  const missing = checks.filter(([, value]) => value === undefined || value === null || String(value).trim() === '').map(([label]) => label);
  return { total: checks.length, done: checks.length - missing.length, missing };
}

export function myServersPage(rows: any[], user: CurrentUser | null) {
  const verifiedCount = rows.filter((row) => ['verified', '운영자 인증'].includes(String(row.verification_status ?? row.verified_status ?? ''))).length;
  const renewalCount = rows.filter((row) => {
    const status = String(row.verification_status ?? row.verified_status ?? '');
    return status === 'renewal_required' || status === 'expired' || Number(row.renewal_days_left ?? 9999) <= 14;
  }).length;
  const pendingReviewTotal = rows.reduce((sum, row) => sum + Number(row.pending_review_count ?? 0), 0);
  const documentTotal = rows.reduce((sum, row) => sum + Number(row.doc_count ?? row.official_doc_count ?? 0), 0);
  const serverRows = rows
    .map((row) => {
      const verificationStatus = row.verification_status ?? row.verified_status;
      const renewalAt = row.renewal_required_at ?? row.next_verification_due_at;
      const expiresAt = row.expires_at ?? row.verification_expires_at;
      const docCount = row.doc_count ?? row.official_doc_count ?? 0;
      const warning = verificationStatus === 'renewal_required' || verificationStatus === 'expired'
        ? '<strong class="status-warning">인증 갱신 필요</strong>'
        : Number(row.renewal_days_left ?? 9999) <= 14
          ? '<strong class="status-warning">14일 이내 만료</strong>'
          : '';
      return `<tr>
        <td><a href="/server/${encodeURIComponent(row.slug)}/manage">${escapeHtml(row.title ?? row.name ?? row.slug)}</a><small>${escapeHtml(row.host ?? '주소 미등록')}</small></td>
        <td>${escapeHtml(serverVerificationLabel(verificationStatus))}${warning}</td>
        <td>${escapeHtml(formatDateTime(renewalAt, '미정'))}</td>
        <td>${escapeHtml(formatDateTime(expiresAt, '미정'))}</td>
        <td>${escapeHtml(String(docCount))}개</td>
        <td>${escapeHtml(formatDateTime(row.last_edit_at, '없음'))}</td>
        <td>${row.last_ping_at ? `${row.last_ping_online ? '온라인' : '오프라인'} · ${escapeHtml(formatDateTime(row.last_ping_at))}` : '확인 전'}</td>
        <td>${escapeHtml(String(row.pending_review_count ?? 0))}건</td>
        <td>${escapeHtml(String(row.owner_count ?? 0))}명</td>
        <td><a class="button ghost" href="/server/${encodeURIComponent(row.slug)}/manage">관리</a></td>
      </tr>`;
    })
    .join('');
  const summary = `<section class="operator-flow-summary my-server-summary" aria-label="내 서버 요약">
    <span><strong>${escapeHtml(String(rows.length))}개</strong>관리 서버<small>내 계정에 연결된 서버 위키입니다.</small></span>
    <span><strong>${escapeHtml(String(verifiedCount))}개</strong>인증 완료<small>운영자 권한이 확인된 서버입니다.</small></span>
    <span><strong>${escapeHtml(String(renewalCount))}개</strong>갱신 필요<small>만료 또는 14일 이내 만료 예정입니다.</small></span>
    <span><strong>${escapeHtml(String(pendingReviewTotal))}건</strong>검토 대기<small>공식 영역에 반영 전 확인할 항목입니다.</small></span>
    <span><strong>${escapeHtml(String(documentTotal))}개</strong>공식 문서<small>서버 위키에 연결된 공개 문서입니다.</small></span>
  </section>`;
  const guide = `<section class="operator-guide-panel my-server-guide">
    <strong>서버 관리 순서</strong>
    <ol>
      <li><span>갱신 필요 서버가 있으면 먼저 인증 화면에서 DNS 상태를 확인합니다.</span></li>
      <li><span>검토 대기 항목이 있으면 관리 화면에서 공식 문서 반영 여부를 결정합니다.</span></li>
      <li><span>상태 확인과 최근 편집을 보고 서버 문서가 최신인지 점검합니다.</span></li>
    </ol>
  </section>`;
  return layout(
    '내 서버',
    `<main class="operator-shell space-server">
      <section class="operator-head">
        <div>
          <span class="space-badge">서버</span>
          <h1>내 서버</h1>
          <p>내가 관리하는 서버 공식 문서, 인증 만료, 상태 확인, 검토 대기 항목을 한 화면에서 확인합니다.</p>
        </div>
        <div class="quick-actions">
          <a class="button" href="/servers/new">서버 위키 만들기</a>
          <a class="button ghost" href="/servers">서버 목록</a>
        </div>
      </section>
      ${summary}
      ${guide}
      <section class="operator-panel">
        ${componentTableMarkup(`<thead><tr><th>서버</th><th>인증</th><th>갱신 필요일</th><th>인증 만료일</th><th>공식 문서</th><th>최근 편집</th><th>상태 확인</th><th>검토 대기</th><th>운영자</th><th>관리</th></tr></thead><tbody>${serverRows || emptyTableRow(10, '관리 중인 서버 없음', '서버 위키를 만들거나 운영자 인증을 완료하면 이곳에서 공식 문서를 관리할 수 있습니다.', '/servers/new', '서버 위키 만들기')}</tbody>`)}
      </section>
    </main>`,
    user,
    'server'
  );
}

export function serverClaimPage(space: any, serverInfo: any, claim: any, checks: any[], user: CurrentUser | null) {
  const slug = String(space.slug ?? '').trim();
  const host = String(serverInfo?.host ?? claim?.target_host ?? '').trim();
  const recordName = String(claim?.record_name ?? (host ? `_minewiki.${host}` : '_minewiki.example.kr'));
  const expectedValue = String(claim?.expected_value ?? claim?.token_plain ?? '');
  const status = String(claim?.status ?? 'none');
  const normalizedStatus = status === 'none' ? 'pending' : status;
  const lastCheck = checks[0]?.checked_at;
  const summary = `<section class="operator-flow-summary server-claim-summary" aria-label="서버 인증 요약">
    <span><strong>${escapeHtml(serverVerificationLabel(normalizedStatus))}</strong>인증 상태<small>현재 서버 운영자 인증 진행 단계입니다.</small></span>
    <span><strong>${escapeHtml(host || '미등록')}</strong>서버 주소<small>TXT 레코드를 추가할 대상 도메인입니다.</small></span>
    <span><strong>${claim ? '발급됨' : '필요'}</strong>DNS 토큰<small>${claim ? '아래 값을 DNS TXT 레코드에 추가합니다.' : '토큰을 먼저 발급해야 확인할 수 있습니다.'}</small></span>
    <span><strong>${escapeHtml(formatDateTime(lastCheck, '없음'))}</strong>최근 확인<small>DNS 확인 시도 기록의 최신 시각입니다.</small></span>
  </section>`;
  const guide = `<section class="operator-guide-panel server-claim-guide">
    <strong>DNS 인증 순서</strong>
    <ol>
      <li><span>DNS 토큰을 발급하고 아래 TXT Name과 Value를 복사합니다.</span></li>
      <li><span>서버 주소 도메인의 DNS 관리 화면에 TXT 레코드를 추가합니다.</span></li>
      <li><span>전파 후 지금 확인을 눌러 운영자 인증 상태를 갱신합니다.</span></li>
    </ol>
  </section>`;
  const checkRows = checks
    .map(
      (row) => `<tr>
        <td>${escapeHtml(formatDateTime(row.checked_at, ''))}</td>
        <td>${escapeHtml(serverVerificationLabel(String(row.status ?? 'pending')))}</td>
        <td>${escapeHtml(row.error_message ?? row.failure_reason ?? '')}</td>
      </tr>`
    )
    .join('');
  return layout(
    '서버 운영자 인증',
    `<main class="operator-shell space-server">
      <section class="operator-head">
        <div>
          <span class="space-badge">서버</span>
          <h1>서버 운영자 인증</h1>
          <p><strong>${escapeHtml(space.title ?? space.name ?? slug)}</strong>의 공식 영역을 관리하려면 서버 주소 도메인에 TXT 레코드를 추가하세요.</p>
        </div>
        <div class="quick-actions">
          <a class="button ghost" href="/server/${encodeURIComponent(slug)}/manage">관리 화면</a>
          <a class="button ghost" href="/server/${encodeURIComponent(slug)}">서버 위키</a>
        </div>
      </section>
      <aside class="doc-status"><strong>인증 범위</strong><span>운영자 인증은 서버 품질, 안전성, 운영 수준을 보증하지 않습니다. 이 서버 주소의 도메인을 제어할 수 있음을 확인하는 절차입니다.</span></aside>
      ${summary}
      ${guide}
      <section class="operator-panel">
        <h2>DNS TXT 레코드</h2>
        <dl class="spec-list">
          <dt>서버 주소</dt><dd>${escapeHtml(host || '주소 미등록')}</dd>
          <dt>상태</dt><dd>${escapeHtml(serverVerificationLabel(status === 'none' ? 'pending' : status))}</dd>
          <dt>Type</dt><dd><code>TXT</code></dd>
          <dt>Name</dt><dd><code>${escapeHtml(recordName)}</code></dd>
          <dt>Value</dt><dd><code>${escapeHtml(expectedValue || '토큰 발급 필요')}</code></dd>
        </dl>
        <div class="quick-actions">
          <form method="post" action="/server/${encodeURIComponent(slug)}/claim">
            <button>${claim ? '토큰 재발급' : 'DNS 토큰 발급'}</button>
          </form>
          ${claim ? `<form method="post" action="/server/${encodeURIComponent(slug)}/claim/verify"><input type="hidden" name="claimId" value="${escapeHtml(String(claim.id))}"><button>지금 확인</button></form>` : ''}
        </div>
        <p class="muted">DNS 변경은 전파까지 시간이 걸릴 수 있습니다. 인증이 완료되면 TXT 레코드는 삭제해도 됩니다.</p>
      </section>
      <section class="operator-panel">
        <h2>최근 확인</h2>
        ${componentTableMarkup(`<thead><tr><th>시간</th><th>결과</th><th>메시지</th></tr></thead><tbody>${checkRows || emptyTableRow(3, '확인 기록 없음', 'TXT 레코드를 추가한 뒤 지금 확인을 누르면 DNS 확인 결과가 여기에 남습니다.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'server'
  );
}

export function operatorHomePage(summary: any[], work: any[], user: CurrentUser | null) {
  const cards = summary
    .map(
      (item) => `<a class="operator-card" href="${escapeHtml(item.href ?? '/admin/work')}">
        <strong>${escapeHtml(item.label)}</strong>
        <span> ${escapeHtml(String(item.count ?? 0))}</span>
        <small>${escapeHtml(item.detail ?? adminWorkTypeLabel(item.work_type))}</small>
      </a>`
    )
    .join('');
  const workRows = work
    .map((item) => {
      const target = adminWorkTarget(item);
      return `<tr>
        <td>${escapeHtml(adminWorkTypeLabel(item.work_type))}</td>
        <td>${escapeHtml(target.label)}${target.href ? ` <a href="${escapeHtml(target.href)}">열기</a>` : ''}<small>${escapeHtml(target.detail)}</small></td>
        <td>${escapeHtml(priorityLabel(item.priority))}</td>
        <td>${escapeHtml(genericStatusLabel(String(item.status ?? 'open')))}</td>
        <td>${escapeHtml(item.assigned_display_name ?? item.assigned_username ?? '미배정')}</td>
        <td>${escapeHtml(formatDateTime(item.updated_at))}</td>
      </tr>`;
    })
    .join('');
  return layout(
    '운영자 홈',
    `<main class="admin operator-home">
      <section class="operator-head">
        <div>
          <span class="space-badge">Operator</span>
          <h1>운영자 홈</h1>
          <p>신고, 검토, 서버 인증, 위키 신청, 이전 요청, 검색/파일/작업 큐를 한 화면에서 확인합니다.</p>
        </div>
        <div class="quick-actions">
          <a class="button" href="/admin/work">업무 큐</a>
          <a class="button ghost" href="/admin/release">릴리즈 상태</a>
          <a class="button ghost" href="/admin/search">검색 관리</a>
        </div>
      </section>
      <section class="operator-summary">${cards}</section>
      <section class="admin-panel">
        <h2>열린 관리자 업무</h2>
        ${componentTableMarkup(`<thead><tr><th>유형</th><th>대상</th><th>우선순위</th><th>상태</th><th>담당자</th><th>갱신</th></tr></thead><tbody>${workRows || emptyTableRow(6, '열린 관리자 업무 없음', '신고, 검토, 서버 인증, 검색 정비가 필요하면 이 목록에 표시됩니다.', '/admin/work', '업무 큐 열기')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function modDetailsHtml(details: { versions: any[]; links: any[]; dependencies: any[]; wiki?: any }) {
  const creatorBadge = details.wiki?.creator_verified
    ? `<aside class="official-area compact-status"><strong title="제작자 또는 공식 팀 참여가 확인된 공식 관리 권한 표시입니다.">제작자 인증</strong><small>${escapeHtml(formatDateTime(details.wiki.verified_at, ''))}</small></aside>`
    : details.wiki
      ? '<aside class="doc-status compact-status"><strong title="제작자 인증은 품질 보증이 아니라 공식 관리 권한 표시입니다.">제작자 미인증</strong></aside>'
      : '';
  const versionRows = details.versions
    .map((row) => `<tr><td>${escapeHtml(row.minecraft_version)}</td><td>${escapeHtml(row.loader)}</td><td>${escapeHtml(modSupportStatusLabel(row.support_status))}</td><td>${escapeHtml(row.note ?? '')}</td></tr>`)
    .join('');
  const linkRows = details.links
    .map((row) => `<tr><td>${escapeHtml(modLinkTypeLabel(row.link_type))}</td><td><a href="${escapeHtml(row.url)}" rel="nofollow noopener" target="_blank">${escapeHtml(row.url)}</a></td><td>${escapeHtml(modVerificationLabel(String(row.status ?? 'needs_check')))}</td></tr>`)
    .join('');
  const depRows = details.dependencies
    .map((row) => `<tr><td>${escapeHtml(row.dependency_name)}</td><td>${escapeHtml(modDependencyTypeLabel(row.required_type))}</td><td>${escapeHtml(row.note ?? '')}</td></tr>`)
    .join('');
  return `${creatorBadge}<section class="data-section"><h2>모드 데이터</h2>
    ${componentTableMarkup(`<caption>지원 버전</caption><thead><tr><th>버전</th><th>로더</th><th>상태</th><th>비고</th></tr></thead><tbody>${versionRows || emptyTableRow(4, '지원 버전 데이터 없음', '검증된 Minecraft 버전과 로더 정보가 등록되면 호환성 표로 표시됩니다.')}</tbody>`)}
    ${componentTableMarkup(`<caption>공식 링크</caption><thead><tr><th>종류</th><th>URL</th><th>상태</th></tr></thead><tbody>${linkRows || emptyTableRow(3, '공식 링크 데이터 없음', '공식 사이트, 소스 코드, 다운로드 링크를 검증하면 링크 표에 표시됩니다.')}</tbody>`)}
    ${componentTableMarkup(`<caption>의존성</caption><thead><tr><th>이름</th><th>유형</th><th>비고</th></tr></thead><tbody>${depRows || emptyTableRow(3, '등록된 의존성 없음', '필수/선택 의존 모드가 확인되면 설치 전 확인용으로 표시됩니다.')}</tbody>`)}
  </section>`;
}

function modSupportStatusLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    supported: '지원',
    current: '최신',
    partial: '일부 지원',
    outdated: '오래됨',
    dropped: '지원 종료',
    unknown: '확인 필요'
  };
  return labels[key] ?? genericStatusLabel(key);
}

function modLinkTypeLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    homepage: '홈페이지',
    modrinth: 'Modrinth',
    curseforge: 'CurseForge',
    github: 'GitHub',
    wiki: '위키',
    docs: '문서',
    discord: 'Discord'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function modDependencyTypeLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    required: '필수',
    optional: '선택',
    incompatible: '호환 불가',
    embedded: '포함됨'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function developDocPanel(components: Array<{ name: string; props: Record<string, string> }>) {
  const api = components.find((component) => component.name === 'api_info' || component.name === 'packet_info');
  const status = components.find((component) => component.name === 'document_status');
  const props = api?.props ?? {};
  const rows = [
    ['종류', props['종류'] ?? (api?.name === 'packet_info' ? '패킷' : 'API')],
    ['기준 버전', props['기준 버전'] ?? props['버전'] ?? ''],
    ['네임스페이스', props['네임스페이스'] ?? props['패키지'] ?? ''],
    ['상태', status?.props?.['상태'] ?? '검증 필요'],
    ['확인일', status?.props?.['확인일'] ?? props['마지막 확인'] ?? '']
  ].filter(([, value]) => value);
  const official = props['공식 링크'] || props['공식 문서'];
  const officialLink = official && /^https?:\/\//i.test(official)
    ? `<a href="${escapeHtml(official)}" rel="nofollow noopener" target="_blank">공식 문서</a>`
    : '<span>공식 링크 필요</span>';
  return `<aside class="dev-doc-panel">
    <div>
      <strong>${escapeHtml(props['이름'] ?? props['패킷'] ?? '개발 문서')}</strong>
      <span>버전 기준, 예제 코드, 공식 링크를 함께 검토합니다.</span>
    </div>
    <dl>${rows.map(([key, value]) => `<div><dt>${escapeHtml(key)}</dt><dd>${escapeHtml(value)}</dd></div>`).join('')}</dl>
    <div class="quick-actions">${officialLink}<a href="/search?space=dev&q=${encodeURIComponent(props['이름'] ?? '')}">관련 개발 문서</a></div>
  </aside>`;
}

function spaceProfile(namespace: NamespaceCode, title: string) {
  const subwiki = title.includes('/');
  if (namespace === 'main' && isUserWikiTitle(title)) {
    return {
      key: 'user',
      label: '사용자 문서',
      badge: '[사용자 문서]',
      summary: '개인 작업 공간입니다.',
      notice: '<aside class="doc-status"><strong>사용자 문서</strong><span>본인과 관리자만 수정할 수 있습니다.</span></aside>'
    };
  }
  if (namespace === 'mod') {
    return {
      key: 'mod',
      label: subwiki ? '모드 위키' : '모드',
      badge: subwiki ? '[모드 위키]' : '[Mod]',
      summary: subwiki ? '대형 모드 전용 문서 공간입니다.' : '로더, 버전, 의존성, 공식 링크 검증 상태를 중심으로 읽는 모드 문서입니다.',
      notice: subwiki ? '<aside class="doc-status"><strong>모드 위키</strong><span>이 문서는 전용 모드 문서 구조와 사이드바를 따릅니다.</span></aside>' : ''
    };
  }
  if (namespace === 'modpack') {
    return {
      key: 'modpack',
      label: '모드팩',
      badge: '[Modpack]',
      summary: '모드팩 구성, 설치, 호환성, 문제 해결 문서를 정리하는 공간입니다.',
      notice: '<aside class="doc-status"><strong>모드팩 문서</strong><span>설치 방법, 구성 모드, 버전 호환성을 함께 확인합니다.</span></aside>'
    };
  }
  if (namespace === 'server') {
    return {
      key: 'server',
      label: subwiki ? '서버 공식 위키' : '서버',
      badge: subwiki ? '[서버 공식 위키]' : '[Server]',
      summary: subwiki ? '인증된 서버 운영자가 관리하는 공식 문서 공간입니다.' : '서버 순위가 아니라 인증, 버전, 장르, 상태 정보를 정리하는 문서입니다.',
      notice: subwiki
        ? '<aside class="official-area"><strong>공식 문서</strong><span>이 문서는 인증된 서버 운영자가 관리하는 공식 영역입니다.</span></aside>'
        : ''
    };
  }
  if (namespace === 'dev') {
    return {
      key: 'dev',
      label: '개발',
      badge: '[Develop]',
      summary: 'Minecraft 개발 자료를 코드, 표, 버전 기준, 공식 링크 중심으로 정리한 기술 문서입니다.',
      notice: '<aside class="doc-status"><strong>개발 문서</strong><span>버전 기준과 공식 문서 링크를 먼저 확인합니다.</span></aside>'
    };
  }
  return {
    key: namespace === 'main' ? 'main' : namespace,
    label: namespace === 'main' ? '위키' : (namespaceSpecs.find((item) => item.code === namespace)?.displayName ?? namespace),
    badge: spaceLabel(namespace),
    summary:
      namespace === 'guide'
        ? '절차형 가이드와 플레이 안내를 정리한 문서입니다.'
        : namespace === 'data'
          ? '표, 수치, 목록형 정보를 중심으로 정리한 자료 문서입니다.'
          : namespace === 'help'
            ? '편집, 신고, 이전 절차를 안내하는 도움말 문서입니다.'
            : namespace === 'project'
              ? '운영 정책과 프로젝트 기준을 정리한 문서입니다.'
              : namespace === 'template'
                ? '문서 구조를 재사용하기 위한 틀 문서입니다.'
                : namespace === 'file'
                  ? '파일 설명과 라이선스 정보를 정리한 문서입니다.'
                  : '한국어 Minecraft 문서입니다.',
    notice: ''
  };
}

function tag(value: unknown) {
  if (value === null || value === undefined || value === '') return '';
  return `<span class="tag">${escapeHtml(String(value))}</span>`;
}

function option(value: string, selected: string | undefined, label = value) {
  return `<option value="${escapeHtml(value)}"${selected === value ? ' selected' : ''}>${escapeHtml(label)}</option>`;
}

export function dataListPage(title: string, rows: any[], user: CurrentUser | null, options: { currentSpace?: string; summary?: string } = {}) {
  const hiddenKeys = new Set(['id', 'page_id', 'target_page_id', 'from_page_id', 'target_id', 'entity_id', 'space_id', 'protection_level']);
  const keys = Object.keys(rows[0] ?? {}).filter((key) => !hiddenKeys.has(key));
  const profile = dataListProfile(title, rows, keys, options);
  const summaryCards = [
    ['항목', `${rows.length}건`, profile.metric],
    ['표시 열', `${keys.length}개`, keys.length ? keys.map(dataColumnLabel).slice(0, 3).join(' · ') : '현재 표시할 열 없음'],
    ['범위', profile.scope, profile.scopeDetail]
  ]
    .map(([label, value, detail]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></span>`)
    .join('');
  const table = rows.length && keys.length
    ? componentTableMarkup(`<thead><tr>${keys.map((key) => `<th>${escapeHtml(dataColumnLabel(key))}</th>`).join('')}</tr></thead><tbody>${rows
        .map((row) => `<tr>${keys.map((key) => `<td>${dataCellHtml(key, row[key], row)}</td>`).join('')}</tr>`)
        .join('')}</tbody>`)
    : dataListEmptyState(title);
  return layout(
    title,
    `<main class="narrow public-log-page">
      <section class="directory-head">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(profile.summary)}</p>
      </section>
      <section class="directory-summary data-list-summary" aria-label="${escapeHtml(title)} 요약">${summaryCards}</section>
      <section class="data-list-layout">
        <section class="public-log-section data-list-table-section">
          <h2>${escapeHtml(profile.tableTitle)}</h2>
          ${table}
        </section>
        <aside class="directory-guide-panel data-list-guide-panel">
          <strong>읽는 방법</strong>
          <p>${escapeHtml(profile.guide)}</p>
          <strong>다음 행동</strong>
          <div class="quick-actions">${profile.actions}</div>
        </aside>
      </section>
    </main>`,
    user,
    options.currentSpace ?? 'main'
  );
}

function dataListProfile(title: string, rows: any[], keys: string[], options: { currentSpace?: string; summary?: string } = {}) {
  const normalized = String(title ?? '');
  const isAdmin = options.currentSpace === 'admin';
  if (normalized.includes('리비전') || keys.includes('revision_no')) {
    return {
      summary: options.summary ?? (isAdmin ? '관리자가 확인해야 하는 판 기록을 위키 표로 점검합니다.' : '공개 리비전을 표로 훑어보고 변경 맥락을 확인합니다.'),
      metric: rows.length ? '권한 범위 안에서 볼 수 있는 판 기록입니다.' : '현재 조건에 맞는 판 기록이 없습니다.',
      scope: isAdmin ? '관리자' : '공개',
      scopeDetail: isAdmin ? '관리 권한으로 접근 가능한 기록입니다.' : '공개 문서의 공개 판만 표시합니다.',
      tableTitle: isAdmin ? '감사 대상 리비전' : '공개 리비전',
      guide: '문서, 판 번호, 공개 범위, 작성자, 요약을 함께 보면서 변경 흐름을 확인하세요.',
      actions: `${isAdmin ? '<a class="button ghost" href="/admin/recent">관리자 최근 바뀜</a><a class="button ghost" href="/admin/audits">감사 허브</a>' : '<a class="button ghost" href="/recent">최근 바뀜</a><a class="button ghost" href="/special/revision-search">리비전 검색</a>'}`
    };
  }
  if (normalized.includes('상태') || keys.some((key) => ['incident_type', 'severity', 'started_at', 'resolved_at'].includes(key))) {
    return {
      summary: options.summary ?? '점검, 장애, 운영 공지를 위키 표 형식으로 정리합니다.',
      metric: rows.length ? '공개 운영 항목입니다.' : '진행 중인 공개 운영 항목이 없습니다.',
      scope: '운영',
      scopeDetail: '공개 가능한 상태와 일정만 표시합니다.',
      tableTitle: '운영 항목',
      guide: '유형, 중요도, 시작/해결 시간을 기준으로 서비스 상태를 빠르게 판단하세요.',
      actions: '<a class="button ghost" href="/status">운영 상태</a><a class="button ghost" href="/announcements">공지</a>'
    };
  }
  return {
    summary: options.summary ?? '공개 데이터를 위키 표 형식으로 정리합니다.',
    metric: rows.length ? '현재 표시 조건에 맞는 공개 항목입니다.' : '현재 표시할 공개 항목이 없습니다.',
    scope: options.currentSpace ? spaceLabel(options.currentSpace) : '공개',
    scopeDetail: '읽기 권한이 있는 항목만 표시합니다.',
    tableTitle: '목록',
    guide: '표의 첫 열부터 대상과 상태를 확인하고, 보기 링크가 있으면 원문 문서나 기록으로 이동하세요.',
    actions: '<a class="button ghost" href="/special">특수 문서</a><a class="button ghost" href="/search">검색</a>'
  };
}

function dataListEmptyState(title: string) {
  const normalized = String(title ?? '');
  const state = normalized.includes('리비전')
    ? { heading: '표시할 리비전 없음', message: '권한 범위 안에서 볼 수 있는 판 기록이 아직 없거나 현재 조건에 맞는 기록이 없습니다.', href: '/recent', label: '최근 바뀜 보기' }
    : normalized.includes('상태')
      ? { heading: '공개된 운영 항목 없음', message: '현재 공개된 점검, 장애, 운영 항목이 없습니다. 새 공지가 등록되면 이 표에 표시됩니다.', href: '/status', label: '운영 상태 보기' }
      : { heading: '표시할 항목 없음', message: '현재 조건에 맞는 공개 항목이 없습니다. 관련 문서가 만들어지거나 갱신되면 이곳에 표시됩니다.', href: '/special', label: '특수 문서 보기' };
  return `<section class="empty-state"><h2>${escapeHtml(state.heading)}</h2><p>${escapeHtml(state.message)}</p><div class="quick-actions"><a class="button ghost" href="${escapeHtml(state.href)}">${escapeHtml(state.label)}</a></div></section>`;
}

type PublicInfoSection = 'announcements' | 'releases' | 'status' | 'join';

function publicInfoTabs(active: PublicInfoSection) {
  const tabs: Array<[PublicInfoSection, string, string]> = [
    ['announcements', '공지', '/announcements'],
    ['releases', '릴리즈', '/release-notes'],
    ['status', '운영 상태', '/status'],
    ['join', '가입 안내', '/beta']
  ];
  return `<nav class="public-info-tabs" aria-label="공개 운영 정보">
    ${tabs.map(([key, label, href]) => `<a${active === key ? ' class="active" aria-current="page"' : ''} href="${href}">${label}</a>`).join('')}
  </nav>`;
}

function publicInfoPage(title: string, heading: string, summary: string, active: PublicInfoSection, body: string, user: CurrentUser | null, extraClass = '') {
  return layout(
    title,
    `<main class="narrow public-log-page public-info-page ${extraClass}">
      <section class="directory-head">
        <h1>${escapeHtml(heading)}</h1>
        <p>${escapeHtml(summary)}</p>
        ${publicInfoTabs(active)}
      </section>
      ${body}
    </main>`,
    user,
    'main'
  );
}

function publicInfoSummary(items: Array<{ label: string; value: string; detail: string }>) {
  return `<section class="public-info-summary" aria-label="화면 요약">
    ${items.map((item) => `<span><strong>${escapeHtml(item.value)}</strong>${escapeHtml(item.label)}<small>${escapeHtml(item.detail)}</small></span>`).join('')}
  </section>`;
}

function publicInfoGuide(title: string, steps: string[]) {
  return `<section class="public-info-guide">
    <strong>${escapeHtml(title)}</strong>
    <ol>${steps.map((step) => `<li><span>${escapeHtml(step)}</span></li>`).join('')}</ol>
  </section>`;
}

export function announcementsPage(rows: any[], user: CurrentUser | null) {
  const latest = rows[0]?.starts_at ?? rows[0]?.created_at ?? '';
  const summary = publicInfoSummary([
    { label: '공지', value: `${rows.length}건`, detail: '현재 공개 범위에 맞는 운영 공지입니다.' },
    { label: '최근 게시', value: formatDateTime(latest, '없음'), detail: '새 공지는 이 화면 위쪽에 먼저 표시됩니다.' },
    { label: '확인 범위', value: '운영', detail: '점검, 정책, 캠페인, 장애 공지를 함께 확인합니다.' }
  ]);
  const guide = publicInfoGuide('공지 읽는 순서', [
    '점검 또는 장애 공지는 기간과 공개 범위를 먼저 확인합니다.',
    '정책 공지는 관련 문서나 도움말을 함께 열어 변경 내용을 확인합니다.',
    '진행 중인 문제는 운영 상태 탭에서 해결 여부를 이어서 확인합니다.'
  ]);
  const body = rows.length
    ? rows
        .map((row) => `<article class="public-log-card">
          <header><strong>${escapeHtml(row.title ?? '공지')}</strong>${tag(publicTypeLabel(row.type))}</header>
          <p>${escapeHtml(row.body ?? '')}</p>
          <dl>
            <dt>공개 범위</dt><dd>${escapeHtml(visibilityLabel(row.visibility))}</dd>
            <dt>게시 기간</dt><dd>${escapeHtml(periodLabel(row.starts_at, row.ends_at))}</dd>
          </dl>
        </article>`)
        .join('')
    : emptyPublicSection('공개된 공지가 없습니다', '현재 표시할 공지가 없습니다.');
  return publicInfoPage('공지', '공지', 'MineWiki 운영 공지, 점검, 정책 변경을 시간순으로 모아 둡니다.', 'announcements', `${summary}${guide}<section class="public-log-list">${body}</section>`, user);
}

export function releaseNotesPage(rows: any[], user: CurrentUser | null) {
  const latest = rows[0]?.published_at ?? '';
  const latestType = rows[0]?.release_type ? releaseTypeLabel(rows[0].release_type) : '없음';
  const summary = publicInfoSummary([
    { label: '릴리즈', value: `${rows.length}건`, detail: '공개된 기능 변경과 운영 변경입니다.' },
    { label: '최근 공개', value: formatDateTime(latest, '없음'), detail: '가장 최근 버전의 공개 시각입니다.' },
    { label: '최근 분류', value: latestType, detail: '기능, 수정, 보안, 운영 변경을 구분합니다.' }
  ]);
  const guide = publicInfoGuide('릴리즈 확인 순서', [
    '버전과 분류를 먼저 확인해 내 작업에 영향이 있는지 봅니다.',
    '문서 작성, 검색, 파일, 권한 관련 변경은 관련 화면에서 실제 동작을 확인합니다.',
    '운영 변경은 공지와 운영 상태 화면에서 추가 안내가 있는지 확인합니다.'
  ]);
  const body = rows.length
    ? rows
        .map((row) => `<article class="public-log-card">
          <header><strong>${escapeHtml(row.version ? `${row.version} · ${row.title ?? ''}` : row.title ?? '릴리즈')}</strong>${tag(releaseTypeLabel(row.release_type))}</header>
          ${row.body ? `<p>${escapeHtml(row.body)}</p>` : '<p>릴리즈 상세 설명이 등록되지 않았습니다.</p>'}
          <dl><dt>공개일</dt><dd>${escapeHtml(formatDateTime(row.published_at, '미정'))}</dd></dl>
        </article>`)
        .join('')
    : emptyPublicSection('공개된 릴리즈 노트가 없습니다', '아직 게시된 릴리즈 노트가 없습니다.');
  return publicInfoPage('릴리즈 노트', '릴리즈 노트', '기능 추가, 수정, 운영 변경 사항을 버전별로 정리합니다.', 'releases', `${summary}${guide}<section class="public-log-list">${body}</section>`, user);
}

export function serviceStatusPage(data: { incidents: any[] }, user: CurrentUser | null) {
  const openCount = data.incidents.filter((row) => !['resolved', 'closed', 'done'].includes(String(row.status ?? 'open'))).length;
  const highestSeverity = data.incidents.find((row) => ['critical', 'major', 'high'].includes(String(row.severity ?? '')))?.severity;
  const summary = publicInfoSummary([
    { label: '진행 중', value: `${openCount}건`, detail: '아직 해결되지 않은 공개 점검 또는 장애입니다.' },
    { label: '전체 공지', value: `${data.incidents.length}건`, detail: '최근 공개된 운영 상태 항목입니다.' },
    { label: '최고 중요도', value: highestSeverity ? severityLabel(String(highestSeverity)) : '해당 없음', detail: '긴급도가 높은 항목을 먼저 확인합니다.' }
  ]);
  const guide = publicInfoGuide('상태 확인 순서', [
    '진행 중 항목의 시작 시각과 영향 범위를 먼저 확인합니다.',
    '해결 시각이 비어 있으면 아직 조치 중인 상태로 봅니다.',
    '관련 변경은 공지와 릴리즈 노트에서 추가 안내를 확인합니다.'
  ]);
  const incidents = data.incidents.length
    ? data.incidents
        .map((row) => `<article class="public-log-card status-${escapeHtml(String(row.status ?? ''))}">
          <header><strong>${escapeHtml(row.title ?? '상태 알림')}</strong>${tag(incidentTypeLabel(row.incident_type))}${tag(severityLabel(String(row.severity ?? '')))}${tag(genericStatusLabel(String(row.status ?? 'open')))}</header>
          ${row.summary ? `<p>${escapeHtml(row.summary)}</p>` : ''}
          <dl>
            <dt>시작</dt><dd>${escapeHtml(formatDateTime(row.started_at, '미정'))}</dd>
            <dt>해결</dt><dd>${escapeHtml(formatDateTime(row.resolved_at, '진행 중'))}</dd>
          </dl>
        </article>`)
        .join('')
    : emptyPublicSection('진행 중인 공지가 없습니다', '현재 공개된 장애 또는 점검 공지가 없습니다.');
  return publicInfoPage('운영 상태', '운영 상태', '서비스 점검과 장애 공지를 시간순으로 확인합니다.', 'status', `${summary}${guide}<section class="public-log-section"><h2>점검 및 장애</h2><div class="public-log-list">${incidents}</div></section>`, user);
}

export function openBetaPage(status: any, user: CurrentUser | null) {
  const settings = status?.settings ?? {};
  const ready = Boolean(status?.ready);
  const feedbackSent = status?.feedback === 'sent' || status?.notice === 'feedback_sent';
  const issueSent = status?.issue === 'sent' || status?.notice === 'issue_sent';
  const signupMode = genericStatusLabel(String(settings.signup_mode ?? 'closed'));
  const reviewPolicy = settings.new_user_review_required ? '신규 기여는 검토 후 반영됩니다.' : '기본 편집 정책에 따라 반영됩니다.';
  const serverPolicy = genericStatusLabel(String(settings.server_listing_mode ?? 'verified_or_owner'));
  const rows = [
    { label: '가입 방식', value: signupMode },
    { label: '편집 반영', value: reviewPolicy },
    { label: '서버 위키 노출', value: serverPolicy },
    { label: '마지막 갱신', value: formatDisplayValue('updated_at', settings.updated_at) || '미확인' }
  ];
  const summary = publicInfoSummary([
    { label: '가입 상태', value: ready ? '가능' : '제한', detail: ready ? '새 계정을 만들 수 있는 상태입니다.' : '가입 또는 신규 기여 정책이 제한된 상태입니다.' },
    { label: '가입 방식', value: signupMode, detail: '일반 가입, 초대, 닫힘 여부를 확인합니다.' },
    { label: '편집 정책', value: settings.new_user_review_required ? '검토 필요' : '기본 반영', detail: '첫 편집이 바로 반영되는지 확인합니다.' }
  ]);
  const guide = publicInfoGuide('처음 시작 순서', [
    '가입 방식과 편집 반영 정책을 먼저 확인합니다.',
    '가입 후에는 오탈자 수정이나 출처 보강처럼 작은 편집부터 시작합니다.',
    '서버 위키나 모드 위키 신청은 관련 공간의 신청 화면에서 진행합니다.'
  ]);
  const userAction = user ? '<a class="button ghost" href="/me">내 대시보드</a>' : '';
  const feedbackOptions = [
    ['bug', '오류'],
    ['syntax', '문법/렌더링'],
    ['search', '검색'],
    ['editor', '편집기'],
    ['server_claim', '서버 인증'],
    ['mod_verification', '모드 검증'],
    ['policy', '정책'],
    ['other', '기타']
  ];
  const feedbackNotice = feedbackSent
    ? '<aside class="doc-status official"><strong>피드백 접수</strong><span>보낸 의견이 운영 검토 큐에 등록되었습니다.</span></aside>'
    : '';
  const issueNotice = issueSent
    ? '<aside class="doc-status official"><strong>문제 신고 접수</strong><span>공개 전 확인할 이슈로 등록되었습니다.</span></aside>'
    : '';
  const feedbackIdentity = user
    ? `${escapeHtml(user.display_name || user.username)} 계정으로 접수됩니다.`
    : '로그인하지 않아도 보낼 수 있지만 자동 검증을 통과해야 합니다.';
  const issueOptions = [
    ['bug', '오류'],
    ['permission', '권한'],
    ['security', '보안'],
    ['editor', '편집기'],
    ['parser', '문법/렌더링'],
    ['search', '검색'],
    ['server_wiki', '서버 위키'],
    ['mod_wiki', '모드 위키'],
    ['file', '파일'],
    ['performance', '성능'],
    ['ui', '화면'],
    ['content', '문서 내용'],
    ['other', '기타']
  ];
  const severityOptions = [
    ['critical', '긴급'],
    ['high', '높음'],
    ['medium', '보통'],
    ['low', '낮음']
  ];
  return publicInfoPage(
    '가입 안내',
    '가입 안내',
    'MineWiki 계정 생성과 첫 편집에 필요한 공개 기준을 안내합니다.',
    'join',
    `${summary}${guide}
      <section class="doc-status ${ready ? 'official' : 'review'}"><strong>${ready ? '가입 가능' : '가입 제한'}</strong><span>${ready ? '현재 계정 생성과 문서 기여를 받을 수 있습니다.' : '현재 가입 또는 신규 기여 정책이 제한되어 있습니다.'}</span></section>
      <section class="public-log-section">
        <h2>현재 기준</h2>
        ${componentTableMarkup(`<tbody>${rows.map((row) => `<tr><th>${escapeHtml(row.label)}</th><td>${escapeHtml(row.value)}</td></tr>`).join('')}</tbody>`)}
      </section>
      <section class="public-log-section">
        <h2>처음 시작하기</h2>
        <p>가입 후에는 작은 오탈자 수정, 출처 보강, 깨진 링크 정리처럼 추적 가능한 편집부터 시작하는 것을 권장합니다.</p>
        <div class="quick-actions"><a class="button" href="/join">가입하기</a><a class="button ghost" href="/help/처음_편집하기">처음 편집하기</a><a class="button ghost" href="/help/위키_문법">위키 문법</a>${userAction}</div>
      </section>
      <section class="public-log-section beta-feedback-panel">
        <div>
          <h2>베타 피드백</h2>
          <p>가입, 검색, 편집기, 서버 인증처럼 막히는 흐름을 바로 운영팀에 보냅니다. ${feedbackIdentity}</p>
        </div>
        ${feedbackNotice}
        <form class="beta-feedback-form" method="post" action="/beta/feedback">
          <input type="hidden" name="redirectTo" value="/beta?feedback=sent">
          <label>분류<select name="feedbackType">${feedbackOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
          <label>제목<input name="title" maxlength="120" placeholder="예: 검색 결과에서 서버 문서를 찾기 어렵습니다" required></label>
          <label class="wide">내용<textarea name="body" rows="5" maxlength="4000" placeholder="어떤 화면에서 무엇을 하려 했고, 어디서 막혔는지 적어 주세요." required></textarea></label>
          ${user ? '' : turnstileWidget('beta_feedback')}
          <div class="form-submit-bar"><button>피드백 보내기</button></div>
        </form>
      </section>
      <section class="public-log-section beta-issue-panel">
        <div>
          <h2>공개 전 문제 신고</h2>
          <p>보안, 권한, 검색, 편집 저장처럼 공개 전 처리해야 하는 문제를 이슈로 등록합니다. 단순 의견은 위 피드백으로 보내 주세요.</p>
        </div>
        ${issueNotice}
        <form class="beta-issue-form" method="post" action="/beta/issues">
          <input type="hidden" name="redirectTo" value="/beta?issue=sent">
          <label>유형<select name="issueType">${issueOptions.map(([value, label]) => `<option value="${value}">${label}</option>`).join('')}</select></label>
          <label>심각도<select name="severity">${severityOptions.map(([value, label]) => `<option value="${value}"${value === 'medium' ? ' selected' : ''}>${label}</option>`).join('')}</select></label>
          <label class="wide">제목<input name="title" maxlength="160" placeholder="예: 비로그인 상태에서 편집 저장 버튼이 동작하지 않습니다" required></label>
          <label class="wide">재현 내용<textarea name="body" rows="5" maxlength="4000" placeholder="문제가 난 화면, 누른 버튼, 기대한 결과와 실제 결과를 적어 주세요." required></textarea></label>
          ${user ? '' : turnstileWidget('beta_issue')}
          <div class="form-submit-bar"><button>문제 신고하기</button></div>
        </form>
      </section>`,
    user,
    'join-info-page'
  );
}

function emptyPublicSection(title: string, message: string) {
  return `<section class="empty-state"><h2>${escapeHtml(title)}</h2><p>${escapeHtml(message)}</p></section>`;
}

function periodLabel(start: unknown, end: unknown) {
  const startText = formatDateTime(start, '');
  const endText = formatDateTime(end, '');
  if (startText && endText) return `${startText} ~ ${endText}`;
  if (startText) return `${startText}부터`;
  if (endText) return `${endText}까지`;
  return '상시';
}

function publicTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    notice: '공지',
    maintenance: '점검',
    policy: '정책',
    release: '릴리즈',
    incident: '장애',
    campaign: '캠페인'
  };
  return labels[String(value ?? '')] ?? String(value ?? '공지');
}

function visibilityLabel(value: unknown) {
  const labels: Record<string, string> = {
    public: '전체 공개',
    logged_in: '로그인 사용자',
    staff: '운영진'
  };
  return labels[String(value ?? '')] ?? String(value ?? '전체 공개');
}

function releaseTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    feature: '기능',
    fix: '수정',
    policy: '정책',
    major: '주요 변경',
    minor: '일반 변경',
    patch: '수정',
    security: '보안',
    content: '콘텐츠',
    operations: '운영'
  };
  return labels[String(value ?? '')] ?? String(value ?? '릴리즈');
}

function incidentTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    availability: '접속',
    search: '검색',
    permission: '권한',
    security: '보안',
    data: '데이터',
    editor: '편집기',
    server_claim: '서버 인증',
    file: '파일',
    other: '기타',
    incident: '장애',
    maintenance: '점검',
    degradation: '성능 저하',
    notice: '알림'
  };
  return labels[String(value ?? '')] ?? String(value ?? '알림');
}

function dataColumnLabel(key: string) {
  const labels: Record<string, string> = {
    id: '번호',
    title: '제목',
    body: '내용',
    type: '유형',
    visibility: '공개 범위',
    starts_at: '시작',
    ends_at: '종료',
    version: '버전',
    release_type: '분류',
    published_at: '공개일',
    incident_type: '유형',
    severity: '중요도',
    status: '상태',
    started_at: '시작',
    resolved_at: '해결',
    week_start: '주간',
    signup_count: '가입',
    edit_count: '편집',
    active_users: '활동 사용자',
    server_wiki_count: '서버 위키',
    mod_wiki_count: '모드 위키',
    namespace: '공간',
    namespace_code: '분류',
    source_namespace_code: '출처 공간',
    revision_id: '판',
    revision_no: '판',
    actor: '수정자',
    edit_summary: '요약',
    last_reason: '숨김 사유',
    visibility_changed_at: '숨김 처리',
    url: '보기',
    source_title: '출처 문서',
    target_title: '대상 문서',
    requested_title: '요청 문서',
    link_count: '링크 수',
    count: '건수',
    issue_type: '점검 항목',
    detail: '상세',
    reason: '사유',
    created_at: '생성',
    updated_at: '갱신',
    target_page_id: '대상 문서 번호'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function dataCellHtml(key: string, value: any, row: any = {}) {
  if (key === 'url') return value ? `<a class="button ghost" href="${safeLocalHref(value)}">보기</a>` : '<span class="muted">-</span>';
  if (key === 'namespace' || key === 'namespace_code') return escapeHtml(spaceLabel(String(value ?? '')));
  if (key === 'source_namespace_code') return escapeHtml(spaceLabel(String(value ?? '')));
  if (key === 'visibility') return escapeHtml(revisionVisibilityLabel(value ?? 'public'));
  if (key === 'edit_summary') return escapeHtml(publicRevisionSummary(value));
  if (key === 'revision_no') return value ? `r${escapeHtml(String(value))}` : '';
  if (key === 'revision_id') return value ? `r${escapeHtml(String(value))}` : '';
  const display = formatDisplayValue(key, value);
  if ((key === 'title' || key === 'target_title' || key === 'requested_title' || key === 'source_title') && display) {
    const namespaceKey = key === 'source_title' ? 'source_namespace_code' : 'namespace_code';
    const namespace = String(row[namespaceKey] ?? '');
    const linked = namespace ? `<a href="${wikiUrl(namespace as NamespaceCode, String(value))}">${escapeHtml(display)}</a>` : escapeHtml(display);
    return `<strong>${linked}</strong>`;
  }
  if (/_at$|^week_start$/.test(key)) return `<time>${escapeHtml(display)}</time>`;
  return escapeHtml(display);
}

function taskTypeLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    write_page: '문서 작성',
    improve_stub: '짧은 문서 보강',
    fix_broken_link: '깨진 링크 수정',
    add_category: '분류 추가',
    verify_server: '서버 정보 확인',
    fix_search_alias: '검색 별칭 정리',
    check_file_license: '파일 라이선스 확인',
    review_edit: '편집 검토',
    policy_review: '정책 검토',
    content: '문서 작성',
    cleanup: '문서 정리',
    review: '검토',
    link_fix: '링크 정리',
    quality: '품질 개선',
    mod_link_review: '모드 링크 검토',
    server_claim: '서버 인증',
    file_license: '파일 라이선스'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function targetTypeLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    none: '전체',
    page: '문서',
    revision: '리비전',
    report: '신고',
    file: '파일',
    server: '서버',
    server_subwiki: '서버 위키',
    mod_subwiki: '모드 위키',
    user: '사용자',
    admin_log: '관리 로그',
    page_request: '문서 요청',
    mod: '모드',
    contributor_task: '기여 작업'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function priorityLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    urgent: '긴급',
    high: '높음',
    normal: '보통',
    low: '낮음'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function boardItemStatusLabel(value: unknown) {
  const key = String(value ?? 'todo');
  const labels: Record<string, string> = {
    todo: '할 일',
    doing: '진행 중',
    review: '검토',
    blocked: '막힘',
    done: '완료'
  };
  return labels[key] ?? genericStatusLabel(key);
}

function reviewStatusLabel(value: unknown) {
  const key = String(value ?? 'pending');
  const labels: Record<string, string> = {
    pending: '검토 대기',
    approved: '승인',
    rejected: '거절',
    needs_changes: '수정 요청'
  };
  return labels[key] ?? genericStatusLabel(key);
}

function feedbackTypeLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    bug: '오류',
    suggestion: '제안',
    report: '신고',
    content: '문서 의견',
    account: '계정',
    other: '기타'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function searchDictionaryActionLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    alias: '별칭',
    disambiguation: '동음이의',
    ignore: '무시',
    redirect: '넘겨주기',
    typo: '오탈자 보정'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function jobTypeLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    render_page: '문서 렌더링',
    reindex_page: '검색 색인 갱신',
    rebuild_links: '문서 링크 재계산',
    rebuild_categories: '분류 재계산',
    check_file_usage: '파일 사용 점검',
    check_mod_links: '모드 링크 점검',
    check_server_status: '서버 상태 확인',
    run_consistency_check: '일관성 점검'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

export function contributorTasksPage(rows: { assigned: any[]; recommended: any[]; done: any[] }, user: CurrentUser | null, notice: Record<string, unknown> = {}) {
  const taskTable = (items: any[], mode: 'assigned' | 'recommended' | 'done', emptyTitle: string, emptyDetail: string, actionHref = '', actionLabel = '') => componentTableMarkup(`<thead><tr><th>작업</th><th>유형</th><th>대상</th><th>우선순위</th><th>상태</th><th>기한</th><th>처리</th></tr></thead><tbody>${
    items
      .map(
        (item) =>
          `<tr>
            <td data-label="작업"><strong>${escapeHtml(item.title)}</strong>${item.description ? `<small>${escapeHtml(item.description)}</small>` : ''}</td>
            <td data-label="유형">${escapeHtml(taskTypeLabel(item.task_type))}</td>
            <td data-label="대상">${contributorTaskTargetHtml(item)}</td>
            <td data-label="우선순위">${escapeHtml(priorityLabel(item.priority))}</td>
            <td data-label="상태">${escapeHtml(genericStatusLabel(String(item.status ?? 'open')))}</td>
            <td data-label="기한">${escapeHtml(formatDateTime(item.due_at, '미정'))}</td>
            <td data-label="처리">${contributorTaskAction(item, mode)}</td>
          </tr>`
      )
      .join('') || emptyTableRow(7, emptyTitle, emptyDetail, actionHref, actionLabel)
  }</tbody>`);
  const assignedCount = rows.assigned?.length ?? 0;
  const recommendedCount = rows.recommended?.length ?? 0;
  const doneCount = rows.done?.length ?? 0;
  const noticeBlock = notice.claimed
    ? '<section class="doc-status"><strong>작업을 맡았습니다</strong><span>배정된 작업 목록에서 대상 문서를 열고 편집을 시작하세요.</span></section>'
    : notice.completed
      ? '<section class="doc-status"><strong>작업 완료 처리</strong><span>완료 기록에 남았습니다. 대상 문서의 상태와 최근 변경을 한 번 더 확인하세요.</span></section>'
      : '';
  return layout(
    '내 작업',
    `<main class="narrow public-log-page">
      <section class="directory-head">
        <h1>내 작업</h1>
        <p>배정된 정비 작업과 추천 작업을 공간별로 확인합니다.</p>
      </section>
      ${noticeBlock}
      <section class="task-summary" aria-label="작업 요약">
        <span><strong>${assignedCount}</strong>배정</span>
        <span><strong>${recommendedCount}</strong>추천</span>
        <span><strong>${doneCount}</strong>완료</span>
      </section>
      <section class="doc-status"><strong>작업 진행 방법</strong><span>대상 열기에서 문서를 확인하고, 문서 고치기로 바로 편집한 뒤 완료 버튼을 누릅니다. 추천 작업은 먼저 맡으면 내 배정 목록으로 이동합니다.</span></section>
      <section class="public-log-section"><h2>배정된 작업</h2>${taskTable(rows.assigned ?? [], 'assigned', '배정된 작업 없음', '관리자가 지정한 작업은 여기에 표시됩니다.', '/recent', '최근 바뀜 보기')}</section>
      <section class="public-log-section"><h2>추천 작업</h2>${taskTable(rows.recommended ?? [], 'recommended', '추천 작업 없음', '지금은 전체 공개 정비 작업이 없습니다. 최근 변경에서 보강할 문서를 찾아볼 수 있습니다.', '/recent', '최근 바뀜 보기')}</section>
      <section class="public-log-section"><h2>최근 완료</h2>${taskTable(rows.done ?? [], 'done', '완료 기록 없음', '작업을 완료하면 최근 완료 목록에 남습니다.', '/help/처음_편집하기', '처음 편집하기')}</section>
    </main>`,
    user
  );
}

function contributorTaskAction(item: any, mode: 'assigned' | 'recommended' | 'done') {
  const id = Number(item.id ?? 0);
  if (!id) return '-';
  const href = contributorTaskTargetHref(item);
  const editHref = contributorTaskEditHref(item);
  const viewLink = href ? `<a class="button ghost" href="${escapeHtml(href)}">대상 열기</a>` : '';
  const editLink = editHref ? `<a class="button ghost" href="${escapeHtml(editHref)}">문서 고치기</a>` : '';
  if (mode === 'recommended') {
    return `<div class="task-action-stack">${viewLink}<form class="inline-form task-action-form" method="post" action="/tasks/${escapeHtml(String(id))}/claim"><button>맡기</button></form></div>`;
  }
  if (mode === 'assigned' && String(item.status ?? 'open') !== 'done') {
    return `<div class="task-action-stack">${editLink || viewLink}<form class="inline-form task-action-form" method="post" action="/tasks/${escapeHtml(String(id))}/complete"><button>완료</button></form></div>`;
  }
  return `<div class="task-action-stack">${viewLink}<span>완료됨</span></div>`;
}

function contributorTaskTargetHtml(item: any) {
  const label = contributorTaskTargetLabel(item);
  const href = contributorTaskTargetHref(item);
  return href ? `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>` : escapeHtml(label);
}

function contributorTaskTargetLabel(item: any) {
  const title = String(item.target_title ?? item.target_label ?? '').trim();
  const displayTitle = String(item.target_display_title ?? '').trim();
  const namespace = item.target_namespace_code ?? item.namespace_code ?? '';
  if (title || displayTitle) {
    const documentTitle = publicDocumentTitle(namespace, title, displayTitle);
    return `${targetTypeLabel(item.target_type)} · ${documentTitle}`;
  }
  return targetTypeLabel(item.target_type || 'none');
}

function contributorTaskTargetHref(item: any) {
  const title = String(item.target_title ?? '').trim();
  const namespace = String(item.target_namespace_code ?? item.namespace_code ?? '').trim();
  if (title && namespace) return wikiUrl(namespace as NamespaceCode, title);
  return '';
}

function contributorTaskEditHref(item: any) {
  const href = contributorTaskTargetHref(item);
  if (!href || String(item.target_type ?? '') !== 'page') return '';
  return `${href}/edit`;
}

export function projectBoardsPage(boards: any[], items: any[], tasks: any[], user: CurrentUser | null) {
  const boardOptions = boards.map((board) => `<option value="${escapeHtml(String(board.id))}">${escapeHtml(board.name)}</option>`).join('');
  const taskOptions = tasks
    .map((task) => `<option value="${escapeHtml(String(task.id))}">${escapeHtml(task.title)} · ${escapeHtml(taskTypeLabel(task.task_type))} · ${escapeHtml(priorityLabel(task.priority))}</option>`)
    .join('');
  const statusColumns = ['todo', 'doing', 'review', 'blocked', 'done'];
  const boardSummary = `<section class="project-board-summary" aria-label="프로젝트 보드 요약">
    <span><strong>${boards.length}</strong>보드</span>
    <span><strong>${items.filter((item) => !['done'].includes(String(item.status ?? 'todo'))).length}</strong>진행 항목</span>
    <span><strong>${items.filter((item) => String(item.status ?? '') === 'review').length}</strong>검토 대기</span>
    <span><strong>${tasks.length}</strong>연결 가능 작업</span>
  </section>`;
  const grouped = boards
    .map((board) => {
      const boardItems = items.filter((item) => Number(item.board_id) === Number(board.id));
      const columnHtml = statusColumns
        .map((status) => {
          const columnItems = boardItems.filter((item) => String(item.status ?? 'todo') === status);
          const cards = columnItems
            .map((item) => `<article class="kanban-card">
              <strong>${escapeHtml(item.title)}</strong>
              <span>${escapeHtml(projectBoardItemDetail(item))}</span>
              <small>${escapeHtml(item.assigned_display_name ?? item.assigned_username ?? '담당 미지정')}</small>
            </article>`)
            .join('') || `<p class="kanban-empty">${escapeHtml(boardItemStatusLabel(status))} 항목 없음</p>`;
          return `<section class="kanban-column">
            <h3>${escapeHtml(boardItemStatusLabel(status))}<span>${columnItems.length}</span></h3>
            ${cards}
          </section>`;
        })
        .join('');
      const rows =
        boardItems
          .map(
            (item) => `<tr>
              <td data-label="항목"><strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(projectBoardItemDetail(item))}</small></td>
              <td data-label="상태">${escapeHtml(boardItemStatusLabel(item.status))}</td>
              <td data-label="담당">${escapeHtml(item.assigned_display_name ?? item.assigned_username ?? '')}</td>
              <td data-label="작업">
                <form class="inline-form" method="post" action="/admin/project-boards/${escapeHtml(String(board.id))}/items/${escapeHtml(String(item.id))}">
                  <select name="status">${['todo', 'doing', 'review', 'blocked', 'done'].map((status) => option(status, item.status, boardItemStatusLabel(status))).join('')}</select>
                  <input name="sortOrder" value="${escapeHtml(String(item.sort_order ?? 0))}" aria-label="정렬">
                  <button>저장</button>
                </form>
              </td>
            </tr>`
          )
          .join('') || emptyTableRow(4, '보드 항목 없음', '이 보드에 넣을 작업을 아래 항목 추가 폼에서 연결하세요.');
      return `<section class="admin-panel">
        <h2>${escapeHtml(board.name)}</h2>
        <p>${escapeHtml(board.description ?? '')}</p>
        <div class="project-kanban">${columnHtml}</div>
        ${componentTableMarkup(`<thead><tr><th>항목</th><th>상태</th><th>담당</th><th>작업</th></tr></thead><tbody>${rows}</tbody>`)}
      </section>`;
    })
    .join('');
  return layout(
    '프로젝트 보드',
    `<main class="admin admin-project-board-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>프로젝트 보드</h1>
          <p>문서 생산, 검토, 정비 작업을 할 일, 진행, 검토, 완료 흐름으로 관리합니다.</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/admin/work">업무 큐</a><a class="button ghost" href="/admin">관리 홈</a></div>
      </section>
      ${boardSummary}
      <section class="admin-guide-panel project-board-guide">
        <div>
          <strong>보드 운영 순서</strong>
          <p>프로젝트 보드는 여러 문서 정비 작업을 한 흐름으로 묶는 화면입니다. 업무 큐의 개별 작업을 보드 항목에 연결하고 상태를 옮겨 진행 상황을 공유합니다.</p>
        </div>
        <ol>
          <li><strong>보드 만들기</strong><span>정비 주제나 릴리즈 목표별로 보드를 만들고 설명에 범위를 남깁니다.</span></li>
          <li><strong>작업 연결</strong><span>업무 큐의 기여 작업을 항목에 연결하거나 독립 항목으로 필요한 일을 추가합니다.</span></li>
          <li><strong>상태 이동</strong><span>할 일, 진행, 검토, 막힘, 완료 순서로 옮겨 실제 작업 상태를 맞춥니다.</span></li>
        </ol>
      </section>
      <section class="admin-panel">
        <h2>보드 만들기</h2>
        <form class="filter-bar" method="post" action="/admin/project-boards">
          <input name="name" placeholder="보드 이름" required>
          <input name="description" placeholder="설명">
          <button>생성</button>
        </form>
      </section>
      <section class="admin-panel">
        <h2>항목 추가</h2>
        <form class="filter-bar" method="post" action="/admin/project-boards/items">
          <select name="boardId">${boardOptions}</select>
          <select name="taskId"><option value="">연결 작업 없음</option>${taskOptions}</select>
          <input name="title" placeholder="항목 제목" required>
          <button>추가</button>
        </form>
      </section>
      ${grouped || '<section class="admin-panel"><div class="empty-state compact"><h2>프로젝트 보드 없음</h2><p>반복되는 문서 생산, 검토, 정비 흐름을 묶을 보드를 먼저 만드세요.</p></div></section>'}
    </main>`,
    user,
    'admin'
  );
}

function projectBoardItemDetail(item: any) {
  if (item.task_title) return `연결 작업: ${item.task_title}`;
  if (item.task_id) return '연결 작업 있음';
  return '독립 항목';
}

export function reviewDetailPage(review: any, user: CurrentUser | null) {
  const draft = review.draft ?? {};
  const current = review.current ?? {};
  const currentContent = current.content_raw ?? '';
  const submittedContent = draft.content_raw ?? '';
  const draftNamespace = (draft.namespace_code ?? 'main') as NamespaceCode;
  const draftTitle = String(draft.title ?? '').trim();
  const draftDocument = draftTitle
    ? `<a href="${wikiUrl(draftNamespace, draftTitle)}">${escapeHtml(spaceLabel(draftNamespace))} · ${escapeHtml(publicDocumentTitle(draftNamespace, draftTitle, draft.display_title))}</a>`
    : '새 문서';
  const baseRevision = draft.base_revision_id ?? current.current_revision_id;
  const currentPreview = reviewContentPreview(currentContent, '현재 문서가 없습니다', '새 문서 검토라서 비교할 기존 본문이 없습니다.');
  const submittedPreview = reviewContentPreview(submittedContent, '제출 본문 없음', '제출된 원문이 비어 있습니다. 승인 전 작성자에게 보완을 요청하세요.');
  const impactRows = reviewImpactRows(currentContent, submittedContent);
  return layout(
    `검토 #${review.id}`,
    `<main class="narrow public-log-page admin-review-page">
      <section class="directory-head">
        <h1>검토 #${escapeHtml(String(review.id))}</h1>
        <p>제출된 편집안과 현재 문서를 비교한 뒤 처리합니다.</p>
      </section>
      <section class="doc-status"><strong>${escapeHtml(reviewStatusLabel(review.status))}</strong><span>${escapeHtml(review.reason ?? '')}</span><small>${escapeHtml(review.submitted_display_name ?? review.submitted_username ?? '알 수 없음')}</small></section>
      <section class="admin-guide-panel review-guide">
        <div>
          <strong>편집 검토 순서</strong>
          <p>현재 문서와 제출 미리보기를 비교하고, 링크·분류·컴포넌트 변화가 의도한 편집인지 확인한 뒤 처리합니다.</p>
        </div>
        <ol>
          <li><strong>변경 영향 확인</strong><span>글자 수, 내부 링크, 분류, 컴포넌트 변화가 과도하지 않은지 먼저 봅니다.</span></li>
          <li><strong>렌더링 비교</strong><span>현재 렌더링과 제출 미리보기를 나란히 확인해 깨진 문법이나 이상한 출력이 없는지 봅니다.</span></li>
          <li><strong>처리 기록</strong><span>문제가 없으면 승인, 근거가 부족하면 수정 요청, 정책 위반이면 거절로 남깁니다.</span></li>
        </ol>
      </section>
      ${componentTableMarkup(`<tbody>
        <tr><th>문서</th><td>${draftDocument}</td></tr>
        <tr><th>요약</th><td>${escapeHtml(draft.edit_summary ?? '')}</td></tr>
        <tr><th>기준 판</th><td>${baseRevision ? `r${escapeHtml(String(baseRevision))}` : '새 문서'}</td></tr>
      </tbody>`)}
      <section class="public-log-section">
        <h2>검토 영향</h2>
        ${componentTableMarkup(`<thead><tr><th>항목</th><th>현재</th><th>제출 후</th></tr></thead><tbody>${impactRows}</tbody>`)}
      </section>
      <section class="diff-grid">
        <article class="review-preview-panel"><h2>현재 렌더링</h2>${currentPreview}</article>
        <article class="review-preview-panel"><h2>제출 미리보기</h2>${submittedPreview}</article>
      </section>
      <details class="public-log-section">
        <summary>원문 비교</summary>
        <section class="diff-grid source-diff-grid">
          <article><h2>현재 원문</h2><pre class="codeblock"><code>${escapeHtml(currentContent || '새 문서')}</code></pre></article>
          <article><h2>제출 원문</h2><pre class="codeblock"><code>${escapeHtml(submittedContent || '비어 있음')}</code></pre></article>
        </section>
      </details>
      <form class="filter-bar" method="post" action="/admin/reviews/${escapeHtml(String(review.id))}/resolve">
        <select name="status">
          <option value="approved">승인</option>
          <option value="rejected">거절</option>
          <option value="needs_changes">수정 요청</option>
        </select>
        <input name="reason" placeholder="검토 사유">
        <button>처리</button>
      </form>
    </main>`,
    user,
    'admin'
  );
}

function reviewContentPreview(raw: unknown, emptyTitle: string, emptyDetail: string) {
  const content = String(raw ?? '');
  if (!content.trim()) {
    return `<div class="empty-state compact"><strong>${escapeHtml(emptyTitle)}</strong><p>${escapeHtml(emptyDetail)}</p></div>`;
  }
  const parsed = parseMarkup(content);
  const errors = [...parsed.errors, ...parsed.blockingErrors]
    .map((error) => `<li>${escapeHtml(error)}</li>`)
    .join('');
  return `<div class="review-rendered article-body">${renderDocument(parsed.ast)}</div>${errors ? `<aside class="doc-status warning"><strong>문법 확인 필요</strong><span>미리보기 중 경고가 감지되었습니다.</span><ul>${errors}</ul></aside>` : ''}`;
}

function reviewImpactRows(currentContent: unknown, submittedContent: unknown) {
  const current = reviewContentMetrics(currentContent);
  const submitted = reviewContentMetrics(submittedContent);
  const rows = [
    ['본문 글자 수', current.characters, submitted.characters],
    ['줄 수', current.lines, submitted.lines],
    ['내부 링크', current.links, submitted.links],
    ['분류', current.categories, submitted.categories],
    ['위키 컴포넌트', current.components, submitted.components]
  ];
  return rows.map(([label, before, after]) => `<tr><th>${escapeHtml(String(label))}</th><td>${escapeHtml(String(before))}</td><td>${escapeHtml(String(after))}</td></tr>`).join('');
}

function reviewContentMetrics(raw: unknown) {
  const content = String(raw ?? '');
  const parsed = parseMarkup(content);
  return {
    characters: content.length,
    lines: content.trim() ? content.replace(/\r\n/g, '\n').split('\n').length : 0,
    links: parsed.links.length,
    categories: parsed.categories.length,
    components: parsed.components.length
  };
}

export function qualityPage(title: string, rows: any[], user: CurrentUser | null, kind = '') {
  const profile = qualityKindProfile(kind, title);
  const normalizedKind = profile.kind;
  const visibleKeys = qualityVisibleKeys(rows);
  const tableRows = rows
    .map((row) => `<tr>${visibleKeys.map((key) => `<td data-label="${escapeHtml(dataColumnLabel(key))}">${dataCellHtml(key, row[key], row)}</td>`).join('')}<td data-label="작업">${qualityActionHtml(normalizedKind, row)}</td></tr>`)
    .join('');
  const table = rows.length && visibleKeys.length
    ? componentTableMarkup(`<thead><tr>${visibleKeys.map((key) => `<th>${escapeHtml(dataColumnLabel(key))}</th>`).join('')}<th>작업</th></tr></thead><tbody>${tableRows}</tbody>`)
    : `<section class="empty-state"><h2>정비할 문서 없음</h2><p>${escapeHtml(profile.empty)}</p></section>`;
  const quickLinks = qualityQuickLinks(normalizedKind);
  const requestForm = normalizedKind === 'page-requests' ? pageRequestInlineForm(user) : '';
  const summaryCards = [
    ['대상', `${rows.length}건`, profile.metric],
    ['권장 작업', profile.action, profile.actionDetail],
    ['범위', profile.scope, '읽기 권한이 있는 공개 문서만 표시합니다.']
  ]
    .map(([label, value, detail]) => `<article class="operator-card"><strong>${escapeHtml(label)}</strong> <span>${escapeHtml(value)}</span> <small>${escapeHtml(detail)}</small></article>`)
    .join('');
  return layout(
    title,
    `<main class="narrow public-log-page quality-page">
      <section class="directory-head">
        <h1>${escapeHtml(title)}</h1>
        <p>${escapeHtml(profile.summary)}</p>
        <nav class="public-info-tabs quality-tabs" aria-label="정비 목록">${quickLinks}</nav>
      </section>
      <section class="operator-summary quality-summary">${summaryCards}</section>
      <section class="doc-status">
        <strong>정비 기준</strong>
        <span>${escapeHtml(profile.guide)}</span>
      </section>
      ${requestForm}
      <section class="public-log-section">
        <h2>정비 대상</h2>
        ${table}
      </section>
    </main>`,
    user,
    'main'
  );
}

function pageRequestInlineForm(user: CurrentUser | null) {
  const namespaceOptions = namespaceSpecs
    .filter((item) => item.isContent || ['help', 'project'].includes(item.code))
    .map((item) => `<option value="${item.code}">${escapeHtml(item.displayName)}</option>`)
    .join('');
  return `<section class="public-log-section page-request-panel">
    <h2>새 작성 요청</h2>
    <p class="muted">필요한 문서 제목과 이유를 남기면 요청 목록에 올라갑니다. 이미 같은 문서가 있으면 기존 문서와 연결됩니다.</p>
    <form class="stacked-form page-request-form" method="post" action="/page-requests">
      <input type="hidden" name="redirectTo" value="/special/page-requests">
      <div class="request-form-grid">
        <label>공간<select name="namespace">${namespaceOptions}</select></label>
        <label>문서 제목<input name="title" required placeholder="예: Create/회전력"></label>
      </div>
      <label>요청 이유<textarea name="reason" rows="3" maxlength="1000" placeholder="왜 필요한 문서인지, 어떤 내용을 기대하는지 적어 주세요."></textarea></label>
      ${user ? '' : turnstileWidget('page_request')}
      <div class="quick-actions"><button>작성 요청 등록</button><a class="button ghost" href="/new">직접 문서 만들기</a></div>
    </form>
  </section>`;
}

function qualityVisibleKeys(rows: any[]) {
  const hiddenKeys = new Set(['id', 'page_id', 'target_page_id', 'from_page_id', 'target_id', 'entity_id', 'space_id', 'protection_level']);
  const preferred = ['namespace_code', 'title', 'target_title', 'requested_title', 'count', 'link_count', 'status', 'issue_type', 'severity', 'detail', 'reason', 'created_at', 'updated_at'];
  const keys = Object.keys(rows[0] ?? {}).filter((key) => !hiddenKeys.has(key));
  return [...preferred.filter((key) => keys.includes(key)), ...keys.filter((key) => !preferred.includes(key))];
}

function qualityKindProfile(kind: string, title: string) {
  const inferred = kind || inferQualityKind(title);
  const profiles: Record<string, { summary: string; guide: string; metric: string; action: string; actionDetail: string; scope: string; empty: string }> = {
    needs_check: {
      summary: '검증이 필요한 문서를 모아 출처, 버전, 사실관계를 빠르게 확인합니다.',
      guide: '본문의 기준일, 출처, 버전 정보를 확인하고 문서 상태를 최신 상태로 갱신하세요.',
      metric: '검증 필요 상태의 문서입니다.',
      action: '문서 검증',
      actionDetail: '문서를 열어 출처와 기준일을 보강합니다.',
      scope: '품질 상태',
      empty: '현재 검증 필요로 표시된 문서가 없습니다.'
    },
    stub: {
      summary: '토막글 문서를 찾아 핵심 설명, 표, 분류, 내부 링크를 보강합니다.',
      guide: '짧은 본문을 확장하고 관련 문서로 이어지는 내부 링크를 추가하세요.',
      metric: '토막글 상태의 문서입니다.',
      action: '본문 보강',
      actionDetail: '문서를 편집해 설명과 구조를 추가합니다.',
      scope: '품질 상태',
      empty: '현재 토막글로 표시된 문서가 없습니다.'
    },
    uncategorized: {
      summary: '분류가 없는 문서를 찾아 독자가 같은 주제 문서를 탐색할 수 있게 정리합니다.',
      guide: '본문 하단에 적절한 분류를 추가하고 기존 분류 체계와 이름을 맞추세요.',
      metric: '분류가 하나도 없는 문서입니다.',
      action: '분류 추가',
      actionDetail: '문서 편집에서 분류 태그를 추가합니다.',
      scope: '분류',
      empty: '현재 분류가 없는 문서가 없습니다.'
    },
    'broken-links': {
      summary: '없는 문서로 이어지는 링크를 모아 새 문서 작성 또는 링크 수정 여부를 판단합니다.',
      guide: '반복해서 연결되는 제목은 새 문서로 만들고, 오타나 잘못된 제목은 출처 문서에서 수정하세요.',
      metric: '누락 제목별 링크 수입니다.',
      action: '문서 만들기',
      actionDetail: '누락 문서를 만들거나 링크 제목을 정정합니다.',
      scope: '링크',
      empty: '현재 깨진 내부 링크가 없습니다.'
    },
    'needed-pages': {
      summary: '여러 문서에서 필요로 하는 미작성 문서를 우선순위별로 확인합니다.',
      guide: '링크 수가 많은 문서부터 기본 정의와 관련 문서를 작성하세요.',
      metric: '필요 문서별 링크 수입니다.',
      action: '문서 만들기',
      actionDetail: '미작성 문서를 바로 편집 화면에서 시작합니다.',
      scope: '링크',
      empty: '현재 필요 문서 목록이 비어 있습니다.'
    },
    'page-requests': {
      summary: '사용자가 요청한 문서 작성 대상을 확인하고 새 문서 작성으로 연결합니다.',
      guide: '요청 사유를 읽고 제목, 공간, 작성 범위를 확인한 뒤 문서를 생성하세요.',
      metric: '열린 문서 작성 요청입니다.',
      action: '요청 처리',
      actionDetail: '요청 제목으로 새 문서를 작성합니다.',
      scope: '요청',
      empty: '열린 문서 작성 요청이 없습니다.'
    },
    'missing-status': {
      summary: '문서 상태 틀이 없는 문서를 찾아 검증 기준과 상태를 명확히 표시합니다.',
      guide: '문서 상단에 상태/기준/확인일 정보를 추가해 독자가 신뢰도를 판단할 수 있게 하세요.',
      metric: '상태 정보가 빠진 문서입니다.',
      action: '상태 추가',
      actionDetail: '문서 상태 틀이나 요약을 보강합니다.',
      scope: '품질 이슈',
      empty: '상태 정보가 빠진 문서가 없습니다.'
    },
    'missing-infobox': {
      summary: '정보상자가 필요한 문서를 찾아 핵심 속성을 표로 정리합니다.',
      guide: '모드, 서버, 데이터 문서에는 버전, 분류, 출처 같은 핵심 정보를 표로 추가하세요.',
      metric: '정보상자가 빠진 문서입니다.',
      action: '정보상자 추가',
      actionDetail: '문서 구조와 기본 정보를 보강합니다.',
      scope: '품질 이슈',
      empty: '정보상자가 필요한 미정비 문서가 없습니다.'
    },
    'no-internal-links': {
      summary: '다른 문서로 이어지는 링크가 없는 고립 문서를 찾아 탐색 흐름을 만듭니다.',
      guide: '관련 블록, 아이템, 모드, 서버, 개발 문서로 이어지는 내부 링크를 추가하세요.',
      metric: '내부 링크가 없는 문서입니다.',
      action: '링크 추가',
      actionDetail: '본문에 관련 문서 링크를 연결합니다.',
      scope: '품질 이슈',
      empty: '내부 링크가 없는 문서가 없습니다.'
    },
    'old-mods': {
      summary: '오래된 모드 문서를 찾아 지원 버전, 로더, 공식 링크를 다시 확인합니다.',
      guide: '최근 Minecraft 버전과 로더 지원 여부, 공식 링크 상태를 확인하고 기준일을 갱신하세요.',
      metric: '확인일이 오래된 모드 문서입니다.',
      action: '모드 검증',
      actionDetail: '모드 데이터와 링크를 갱신합니다.',
      scope: '모드',
      empty: '오래된 모드 문서가 없습니다.'
    },
    'server-missing-address': {
      summary: '서버 주소가 빠진 서버 문서를 찾아 접속 정보와 인증 흐름을 보강합니다.',
      guide: '서버 주소, 지원 버전, 장르, 운영자 인증 여부를 확인해 독자가 접속 가능성을 판단하게 하세요.',
      metric: '주소가 비어 있는 서버 문서입니다.',
      action: '주소 보강',
      actionDetail: '서버 정보와 상태 점검 데이터를 추가합니다.',
      scope: '서버',
      empty: '주소가 빠진 서버 문서가 없습니다.'
    },
    outdated: {
      summary: '오래된 정보를 담은 문서를 찾아 최신 버전 기준으로 갱신합니다.',
      guide: '본문의 버전, 날짜, 공식 링크가 현재 기준과 맞는지 확인하세요.',
      metric: '오래됨 상태의 문서입니다.',
      action: '최신화',
      actionDetail: '문서 내용을 최신 기준으로 고칩니다.',
      scope: '품질 상태',
      empty: '오래됨으로 표시된 문서가 없습니다.'
    }
  };
  return { kind: inferred, ...(profiles[inferred] ?? profiles.needs_check) };
}

function inferQualityKind(title: string) {
  if (title.includes('토막글')) return 'stub';
  if (title.includes('분류 없는')) return 'uncategorized';
  if (title.includes('깨진 링크')) return 'broken-links';
  if (title.includes('필요한 문서')) return 'needed-pages';
  if (title.includes('작성 요청')) return 'page-requests';
  if (title.includes('상태 없는')) return 'missing-status';
  if (title.includes('정보상자')) return 'missing-infobox';
  if (title.includes('내부 링크')) return 'no-internal-links';
  if (title.includes('오래된 모드')) return 'old-mods';
  if (title.includes('주소 없는 서버')) return 'server-missing-address';
  if (title.includes('오래된')) return 'outdated';
  return 'needs_check';
}

function qualityQuickLinks(activeKind: string) {
  const links = [
    ['needs_check', '검증 필요', '/special/needs_check'],
    ['broken-links', '깨진 링크', '/special/broken-links'],
    ['needed-pages', '필요 문서', '/special/needed-pages'],
    ['page-requests', '작성 요청', '/special/page-requests'],
    ['old-mods', '오래된 모드', '/special/old-mods'],
    ['server-missing-address', '서버 주소', '/special/server-missing-address']
  ];
  return links.map(([kind, label, href]) => `<a${activeKind === kind ? ' class="active" aria-current="page"' : ''} href="${href}">${label}</a>`).join('');
}

function qualityActionHtml(kind: string, row: any) {
  const namespace = String(row.namespace_code ?? 'main') as NamespaceCode;
  const title = String(row.title ?? row.target_title ?? row.requested_title ?? '').trim();
  if (!title) return '<span class="muted">-</span>';
  const pageHref = wikiUrl(namespace, title);
  if (kind === 'broken-links' || kind === 'needed-pages' || kind === 'page-requests') {
    return `<a class="button ghost" href="${pageHref}/edit">문서 만들기</a>`;
  }
  const label = kind === 'uncategorized'
    ? '분류 추가'
    : kind === 'old-mods'
      ? '검증하기'
      : kind === 'server-missing-address'
        ? '주소 보강'
        : '문서 고치기';
  return `<a class="button ghost" href="${pageHref}">보기</a><a class="button" href="${pageHref}/edit">${label}</a>`;
}

export function editPage(
  namespace: NamespaceCode,
  title: string,
  content: string,
  user: CurrentUser | null,
  announcements: any[] = [],
  pageType = '',
  baseRevisionId: number | string = '',
  policyNotice = ''
) {
  const lockedUserWikiTitle = namespace === 'main' && isUserWikiTitle(title);
  const visibleTitle = lockedUserWikiTitle ? userWikiDisplayTitle(title) : title;
  const newContributor = Boolean(user && !user.groups.some((group) => ['autoconfirmed', 'trusted', 'moderator', 'admin', 'developer'].includes(group)));
  const onboardingHtml = newContributor
    ? `<aside class="doc-status"><strong>첫 편집 기준</strong><span>출처가 확인되는 내용만 쓰고, 서버 홍보 문구와 과도한 외부 링크는 피합니다.</span><small>정책: 문서 작성 정책, 저작권 정책, 서버 문서 정책</small></aside>`
    : '';
  const noticeHtml = announcements.length
    ? `<section class="notice-stack">${announcements
        .map((item) => `<aside class="doc-status"><strong>${escapeHtml(item.title)}</strong><span>${escapeHtml(item.body)}</span></aside>`)
        .join('')}</section>`
    : '';
  const policyHtml = policyNotice
    ? `<aside class="doc-status edit-policy"><strong>편집 정책</strong><span>${escapeHtml(policyNotice)}</span></aside>`
    : `<aside class="doc-status edit-policy"><strong>편집 정책</strong><span>저장하면 새 판으로 기록됩니다. 문서 보호 수준에 따라 검토 대기로 이동할 수 있습니다.</span></aside>`;
  const anonymousIpHtml = user
    ? ''
    : `<aside class="doc-status warning edit-policy"><strong>비로그인 편집 안내</strong><span>비로그인 상태로 편집하면 IP 주소가 문서 역사에 공개됩니다. IP 공개를 원하지 않으면 로그인 후 편집하세요.</span><small><label><input type="checkbox" required> 비로그인 편집 시 IP 주소가 공개되는 것을 확인했습니다.</label></small></aside>`;
  const turnstileHtml = user ? '' : turnstileWidget('anonymous_edit');
  const templateTools = editorTemplateToolsHtml(namespace, pageType);
  const contentMetrics = reviewContentMetrics(content);
  const editorSummary = [
    ['문자', `${contentMetrics.characters}자`, '저장하면 새 판의 본문 길이로 기록됩니다.'],
    ['줄', `${contentMetrics.lines}줄`, '긴 문서는 제목과 문단을 나눠 주세요.'],
    ['내부 링크', `${contentMetrics.links}개`, '관련 문서와 연결되면 탐색이 쉬워집니다.']
  ]
    .map(([label, value, detail]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></span>`)
    .join('');
  return layout(
    `${visibleTitle} 편집`,
    `<main class="editor-shell editor-tab-shell">
      <form class="editor editor-tabbed" method="post" action="${wikiUrl(namespace, title)}/edit">
        ${onboardingHtml}
        ${noticeHtml}
        ${policyHtml}
        ${anonymousIpHtml}
        <header>
          <div>
            <h1>${escapeHtml(visibleTitle)} 편집</h1>
            ${documentToolTabs(namespace, title, 'edit')}
          </div>
          <button>저장</button>
        </header>
        <section class="directory-summary editor-summary" aria-label="편집 요약">${editorSummary}</section>
        <section class="editor-guide-panel">
          <strong>저장 전 확인</strong>
          <p>출처, 버전, 분류, 내부 링크를 확인한 뒤 편집 요약에 바꾼 이유를 짧게 남기세요.</p>
        </section>
        <input type="hidden" name="namespace" value="${namespace}">
        <input type="hidden" name="baseRevisionId" value="${escapeHtml(String(baseRevisionId ?? ''))}">
        <div class="editor-meta">
          ${lockedUserWikiTitle
            ? `<input type="hidden" name="title" value="${escapeHtml(title)}"><label>문서 제목<input value="${escapeHtml(visibleTitle)}" readonly></label>`
            : `<label>문서 제목<input name="title" value="${escapeHtml(title)}" required></label>`}
          <label>문서 유형
            <select name="pageType">
              ${option('general', pageType || 'general', '일반 문서')}
              ${option('guide', pageType, '가이드 문서')}
              ${option('mod', pageType, '모드 문서')}
              ${option('server', pageType, '서버 문서')}
              ${option('dev', pageType, '개발 문서')}
              ${option('data', pageType, '데이터 문서')}
              ${option('policy', pageType, '정책 문서')}
            </select>
          </label>
          <label><input type="checkbox" name="isMinor" value="1"> 사소한 편집</label>
        </div>
        <nav class="editor-tabs" aria-label="편집기 탭">
          <button type="button" class="active" data-editor-tab="source">편집</button>
          <button type="button" data-editor-tab="preview">미리보기</button>
          <button type="button" data-editor-tab="tools">삽입</button>
        </nav>
        <section class="editor-pane active" data-editor-pane="source">
          <textarea name="content" id="content" spellcheck="false">${escapeHtml(content)}</textarea>
          <input name="summary" placeholder="편집 요약">
          ${turnstileHtml}
        </section>
        <section class="editor-pane preview" data-editor-pane="preview">
          <div id="preview"></div>
        </section>
        <section class="editor-pane editor-tools" data-editor-pane="tools">
          <div class="component-inserter">
            ${templateTools.groupsHtml}
          </div>
          <section class="form-editor" data-form-editor>
            <div class="form-editor-head">
              <strong>폼 편집</strong>
              <select data-component-form data-component-forms="${escapeHtml(templateTools.formKeys.join(','))}" aria-label="정보상자 종류"></select>
            </div>
            <div data-component-fields></div>
          </section>
        </section>
      </form>
    </main>
    <script src="/assets/editor.js?v=20260525-scoped-tools" type="module"></script>`,
    user,
    currentSpaceForNamespace(namespace)
  );
}

export function editConflictPage(
  namespace: NamespaceCode,
  title: string,
  currentContent: string,
  submittedContent: string,
  user: CurrentUser | null,
  pageType = '',
  currentRevisionId: number | string = '',
  submittedSummary = ''
) {
  const lockedUserWikiTitle = namespace === 'main' && isUserWikiTitle(title);
  const visibleTitle = lockedUserWikiTitle ? userWikiDisplayTitle(title) : title;
  const currentMetrics = reviewContentMetrics(currentContent);
  const submittedMetrics = reviewContentMetrics(submittedContent);
  return layout(
    `${visibleTitle} 편집 충돌`,
    `<main class="editor-shell conflict-shell">
      <form class="editor" method="post" action="${wikiUrl(namespace, title)}/edit">
        <header>
          <div>
            <h1>편집 충돌</h1>
            <p>다른 편집이 먼저 저장되었습니다. 현재 문서와 내 수정본을 확인한 뒤 병합해서 저장하세요.</p>
            ${documentToolTabs(namespace, title, 'edit')}
          </div>
          <button>병합본 저장</button>
        </header>
        <section class="directory-summary editor-summary" aria-label="편집 충돌 요약">
          <span><small>현재 문서</small><strong>${escapeHtml(String(currentMetrics.lines))}줄</strong><small>이미 저장된 최신 판입니다.</small></span>
          <span><small>내 수정본</small><strong>${escapeHtml(String(submittedMetrics.lines))}줄</strong><small>아래 입력창의 병합 대상입니다.</small></span>
          <span><small>처리</small><strong>병합 저장</strong><small>두 내용을 비교해 충돌을 직접 정리합니다.</small></span>
        </section>
        <input type="hidden" name="namespace" value="${namespace}">
        <input type="hidden" name="baseRevisionId" value="${escapeHtml(String(currentRevisionId ?? ''))}">
        <div class="editor-meta">
          ${lockedUserWikiTitle
            ? `<input type="hidden" name="title" value="${escapeHtml(title)}"><label>문서 제목<input value="${escapeHtml(visibleTitle)}" readonly></label>`
            : `<label>문서 제목<input name="title" value="${escapeHtml(title)}" required></label>`}
          <label>문서 유형
            <select name="pageType">
              ${option('general', pageType || 'general', '일반 문서')}
              ${option('guide', pageType, '가이드 문서')}
              ${option('mod', pageType, '모드 문서')}
              ${option('server', pageType, '서버 문서')}
              ${option('dev', pageType, '개발 문서')}
              ${option('data', pageType, '데이터 문서')}
              ${option('policy', pageType, '정책 문서')}
            </select>
          </label>
        </div>
        <textarea name="content" id="content" spellcheck="false">${escapeHtml(submittedContent)}</textarea>
        <input name="summary" value="${escapeHtml(submittedSummary)}" placeholder="편집 요약">
      </form>
      <aside class="preview conflict-panel">
        <section>
          <h2>현재 저장된 문서</h2>
          <textarea readonly>${escapeHtml(currentContent)}</textarea>
        </section>
        <section>
          <h2>내가 저장하려던 내용</h2>
          <textarea readonly>${escapeHtml(submittedContent)}</textarea>
        </section>
      </aside>
    </main>
    <script src="/assets/editor.js?v=20260524-preview" type="module"></script>`,
    user,
    currentSpaceForNamespace(namespace)
  );
}

export function permissionInfoPage(page: any, events: any[], user: CurrentUser | null) {
  const namespace = page.namespace_code as NamespaceCode;
  const title = String(page.title ?? '');
  const pagePath = wikiUrl(namespace, title);
  const chrome = documentToolChrome(page, 'permission-info-page public-log-page');
  const documentTitle = publicDocumentTitle(namespace, page.title, page.display_title);
  const level = String(page.protection_level ?? 'open');
  const policy = protectionPolicyText(level, page);
  const aclSummary = page.aclSummary ?? {};
  const aclRules = Array.isArray(page.aclRules) ? page.aclRules : [];
  const summaryRows = ['read', 'edit', 'create_thread', 'write_thread_comment', 'move', 'delete', 'acl']
    .map((action) => `<tr><th>${escapeHtml(aclActionLabel(action))}</th><td>${escapeHtml(aclSummary[action] ?? protectionActionFallback(action, level, page))}</td></tr>`)
    .join('');
  const ruleRows = aclRules
    .map((rule: any, index: number) => `<tr><td>${index + 1}</td><td>${escapeHtml(aclActionLabel(rule.action))}</td><td>${escapeHtml(aclEffectLabel(rule.effect))}</td><td>${escapeHtml(aclSubjectLabel(rule.subject_type, rule.subject_value))}</td><td>${escapeHtml(rule.expires_at ? formatDateTime(rule.expires_at, '') : '없음')}</td><td>${escapeHtml(rule.reason ?? '')}</td>${page.canChangeAcl ? `<td>${rule.id ? `<form method="post" action="${wikiUrl(page.namespace_code, page.title)}/acl"><input type="hidden" name="deleteRuleId" value="${escapeHtml(String(rule.id))}"><input type="hidden" name="reason" value="ACL 규칙 삭제"><button class="button ghost">삭제</button></form>` : '<span>기본</span>'}</td>` : ''}</tr>`)
    .join('');
  const aclSummaryCards = [
    ['보호 수준', protectionLabel(level), policy],
    ['상세 규칙', `${aclRules.length}개`, aclRules.length ? '기본 정책 위에 개별 ACL이 적용됩니다.' : '현재 기본 보호 정책을 따릅니다.'],
    ['내 권한', user ? userPermissionText(level, page, user) : '로그인 필요', user ? '현재 계정 기준으로 계산한 안내입니다.' : '로그인하면 편집 가능 여부를 확인할 수 있습니다.']
  ]
    .map(([label, value, detail]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></span>`)
    .join('');
  return layout(
    `${documentTitle} ACL`,
    `${chrome.open}
      <section class="directory-head">
        <h1>${escapeHtml(documentTitle)} 문서의 ACL</h1>
        <p>문서 보호 수준과 현재 적용 중인 ACL 규칙을 확인합니다.</p>
        ${documentToolTabs(namespace, title, 'acl')}
      </section>
      <section class="directory-summary acl-summary-strip" aria-label="ACL 요약">${aclSummaryCards}</section>
      <section class="permission-summary">
        <h2>현재 내 권한</h2>
        ${protectionBadges(page)}
        <dl>
          <dt>영역</dt><dd>${escapeHtml(searchGroupLabel(page.namespace_code))}</dd>
          <dt>현재 보호 수준</dt><dd>${escapeHtml(protectionLabel(level))}</dd>
          <dt>편집 정책</dt><dd>${escapeHtml(policy)}</dd>
          <dt>내 권한</dt><dd>${escapeHtml(user ? userPermissionText(level, page, user) : '로그인 후 편집할 수 있습니다.')}</dd>
        </dl>
      </section>
      <section class="public-log-section">
        <h2>ACL 요약</h2>
        ${componentTableMarkup(`<tbody>${summaryRows}</tbody>`)}
      </section>
      <details class="public-log-section">
        <summary>상세 ACL</summary>
        ${componentTableMarkup(`<thead><tr><th>순서</th><th>동작</th><th>효과</th><th>대상</th><th>만료</th><th>사유</th>${page.canChangeAcl ? '<th>관리</th>' : ''}</tr></thead><tbody>${ruleRows || emptyTableRow(page.canChangeAcl ? 7 : 6, '개별 ACL 규칙 없음', '이 문서는 현재 위키의 기본 보호 정책을 따릅니다.')}</tbody>`)}
      </details>
      ${page.canChangeAcl ? `<section class="public-log-section">
        <h2>ACL 변경</h2>
        <form class="stack-form" method="post" action="${pagePath}/acl">
          <label>템플릿<select name="template"><option value="public_edit">누구나 편집 가능</option><option value="members_only">로그인 사용자만 편집</option><option value="autoconfirmed_only">자동 인증 사용자만 편집</option><option value="request_only">편집 요청만 허용</option><option value="locked">관리자만 편집</option></select></label>
          <label>사유<input name="reason" placeholder="정책 적용"></label>
          <button>템플릿 적용</button>
        </form>
        <form class="stack-form" method="post" action="${pagePath}/acl">
          <label>동작<select name="action">${['read','edit','create','move','delete','revert','history','raw','create_thread','write_thread_comment','edit_request','upload_file','acl'].map((action) => `<option value="${action}">${escapeHtml(aclActionLabel(action))}</option>`).join('')}</select></label>
          <label>효과<select name="effect"><option value="allow">허용</option><option value="deny">거부</option></select></label>
          <label>대상 종류<select name="subjectType"><option value="perm">권한</option><option value="role">역할</option><option value="user">사용자명 또는 번호</option><option value="aclgroup">ACL 그룹</option></select></label>
          <label>대상<input name="subjectValue" value="member" placeholder="예: member, admin, 위키러"></label>
          <label>사유<input name="reason" placeholder="반달 대응"></label>
          <label>만료<select name="expiresIn"><option value="">무기한</option><option value="24h">24시간</option><option value="3d">3일</option><option value="7d">7일</option></select></label>
          <button>규칙 추가</button>
        </form>
      </section>` : ''}
      <div class="quick-actions"><a class="button ghost" href="${pagePath}/acl/history">ACL 변경 역사</a></div>
    ${chrome.close}`,
    user,
    currentSpaceForNamespace(namespace),
    {
      headHtml: chrome.serverTheme.headHtml,
      bodyClass: chrome.serverTheme.bodyClass
    }
  );
}

export function aclHistoryPage(page: any, events: any[], user: CurrentUser | null) {
  const namespace = page.namespace_code as NamespaceCode;
  const title = String(page.title ?? '');
  const pagePath = wikiUrl(namespace, title);
  const chrome = documentToolChrome(page, 'permission-info-page public-log-page');
  const documentTitle = publicDocumentTitle(namespace, page.title, page.display_title);
  const aclLogs = Array.isArray(page.aclLogs) ? page.aclLogs : [];
  const logRows = aclLogs
    .map((log: any) => `<tr><td>${escapeHtml(formatDateTime(log.created_at, ''))}</td><td>${escapeHtml(log.actor_name ?? '자동')}</td><td>${escapeHtml(aclLogActionLabel(log.action_type))}</td><td>${escapeHtml(log.reason ?? '')}</td></tr>`)
    .join('');
  const eventRows = events
    .map(
      (event) => `<tr><td>${escapeHtml(formatDateTime(event.created_at, ''))}</td><td>${escapeHtml(event.actor_name ?? '자동')}</td><td>${escapeHtml(protectionLabel(event.old_level))} → ${escapeHtml(protectionLabel(event.new_level))}</td><td>${escapeHtml(protectionReasonLabel(event.reason))}${event.expires_at ? `<small>해제 예정 ${escapeHtml(formatDateTime(event.expires_at, ''))}</small>` : ''}</td></tr>`
    )
    .join('');
  return layout(
    `${documentTitle} ACL 변경 역사`,
    `${chrome.open}
      <section class="directory-head">
        <h1>${escapeHtml(documentTitle)} ACL 변경 역사</h1>
        <p>현재 규칙 편집 화면과 분리해 ACL 규칙 변경과 기존 보호 변경 기록만 확인합니다.</p>
        ${documentToolTabs(namespace, title, 'acl')}
      </section>
      <section class="public-log-section">
        <h2>ACL 변경 로그</h2>
        ${componentTableMarkup(`<thead><tr><th>시간</th><th>변경자</th><th>작업</th><th>사유</th></tr></thead><tbody>${logRows || emptyTableRow(4, 'ACL 변경 로그 없음', '개별 ACL 규칙을 추가하거나 삭제하면 변경자와 사유가 이곳에 남습니다.')}</tbody>`)}
      </section>
      <section class="public-log-section">
        <h2>기존 보호 변경 기록</h2>
        ${componentTableMarkup(`<thead><tr><th>시간</th><th>사용자</th><th>변경</th><th>사유</th></tr></thead><tbody>${eventRows || emptyTableRow(4, '보호 변경 기록 없음', '문서 보호 수준을 변경하면 이전 수준과 새 수준이 기록됩니다.')}</tbody>`)}
      </section>
    ${chrome.close}`,
    user,
    currentSpaceForNamespace(namespace),
    {
      headHtml: chrome.serverTheme.headHtml,
      bodyClass: chrome.serverTheme.bodyClass
    }
  );
}

function aclLogActionLabel(action: unknown) {
  const value = String(action ?? '');
  const labels: Record<string, string> = {
    insert: '규칙 추가',
    delete: '규칙 삭제',
    reset: '템플릿 적용',
    update: '규칙 수정'
  };
  return labels[value] ?? value;
}

function aclActionLabel(action: string) {
  const labels: Record<string, string> = {
    read: '읽기',
    edit: '편집',
    create: '생성',
    move: '이동',
    delete: '삭제',
    revert: '되돌리기',
    history: '역사',
    raw: '원문',
    create_thread: '토론 발제',
    write_thread_comment: '토론 댓글',
    edit_request: '편집 요청',
    upload_file: '파일 업로드',
    acl: 'ACL 변경'
  };
  return labels[action] ?? action;
}

function aclEffectLabel(effect: string) {
  if (effect === 'allow') return '허용';
  if (effect === 'deny') return '거부';
  if (effect === 'goto_space') return '공간 ACL';
  return effect;
}

function aclSubjectLabel(type: string, value: string) {
  const raw = String(value ?? '').replace(/^perm:/, '').replace(/^role:/, '').replace(/^aclgroup:/, '');
  if (type === 'user') return `사용자 #${raw.replace(/^user:/, '')}`;
  const labels: Record<string, string> = {
    any: '누구나',
    guest: '비로그인 사용자',
    member: '로그인 사용자',
    autoconfirmed: '자동 인증 사용자',
    trusted: '신뢰 사용자',
    moderator: '관리자 보조',
    admin: '관리자',
    developer: '개발자',
    server_owner: '서버 운영자',
    server_manager: '서버 관리자',
    server_editor: '서버 편집자',
    mod_wiki_manager: '모드 위키 관리자',
    mod_wiki_editor: '모드 위키 편집자',
    page_contributor: '문서 기여자',
    space_contributor: '공간 기여자',
    owner_user: '사용자 문서 주인'
  };
  return labels[raw] ?? `${type}:${raw}`;
}

function protectionActionFallback(action: string, level: string, page: any) {
  if (action === 'read' || action === 'history' || action === 'raw' || action === 'create_thread' || action === 'write_thread_comment' || action === 'edit_request') return '누구나';
  if (action === 'delete' || action === 'acl') return '관리자';
  if (action === 'move') return '자동 인증 사용자';
  if (action !== 'edit') return '자동 인증 사용자';
  if (page.namespace_code === 'main' && page.title === '대문') return '자동 인증 사용자';
  if (level === 'open') return '누구나';
  if (level === 'login_required') return '로그인 사용자';
  if (level === 'review_required' || level === 'autoconfirmed_only') return '자동 인증 사용자';
  if (level === 'trusted_only') return '신뢰 사용자';
  if (level === 'admin_only' || level === 'locked') return '관리자';
  if (level === 'owner_only' || level === 'official_only') return '공식 담당자';
  return protectionLabel(level);
}

function protectionLabel(level: unknown) {
  const labels: Record<string, string> = {
    open: '누구나 편집 가능',
    login_required: '로그인 필요',
    review_required: '검토 후 반영',
    autoconfirmed_only: '자동 인증 사용자 이상',
    trusted_only: '보호됨',
    official_only: '공식 영역',
    owner_only: '공식 영역',
    admin_only: '관리자 전용',
    locked: '보호됨'
  };
  return labels[String(level ?? 'open')] ?? String(level ?? 'open');
}

function sectionLockLabel(level: unknown) {
  const labels: Record<string, string> = {
    admin_only: '관리자 전용',
    owner_only: '공식 담당자 전용',
    trusted_only: '신뢰 사용자 전용',
    locked: '읽기 전용'
  };
  return labels[String(level ?? '')] ?? protectionLabel(level);
}

function protectionReasonLabel(reason: unknown) {
  const labels: Record<string, string> = {
    manual: '수동 변경',
    vandalism: '반달 대응 강화',
    edit_war: '편집 분쟁',
    spam: '스팸',
    privacy: '개인정보',
    server_dispute: '서버 분쟁',
    policy: '정책',
    high_risk: '고위험 문서'
  };
  return labels[String(reason ?? 'manual')] ?? String(reason ?? '');
}

function protectionPolicyText(level: string, page: any) {
  if (level === 'review_required') return '편집은 가능하지만 공개 전 검토가 필요합니다.';
  if (level === 'autoconfirmed_only') return '자동 인증 사용자 이상은 즉시 반영되고 신규 사용자는 검토가 필요합니다.';
  if (level === 'official_only' || level === 'owner_only') return '인증된 담당자는 즉시 반영하고 일반 사용자는 검토가 필요합니다.';
  if (level === 'trusted_only') return '신뢰 사용자 이상만 편집할 수 있습니다.';
  if (level === 'admin_only') return '관리자만 수정할 수 있습니다.';
  if (level === 'locked') return '현재 읽기 전용입니다.';
  if (page.namespace_code === 'dev') return '개발 문서는 버전 기준과 출처 확인이 필요합니다.';
  return '로그인한 사용자는 바로 편집할 수 있습니다.';
}

function userPermissionText(level: string, page: any, user: CurrentUser) {
  const groups = user.groups ?? [];
  if (groups.some((group) => ['admin', 'developer'].includes(group))) return '읽기 가능, 편집 가능, 즉시 반영 가능';
  if (level === 'review_required') return '읽기 가능, 편집 가능, 검토 필요';
  if (level === 'autoconfirmed_only' && !groups.some((group) => ['autoconfirmed', 'trusted', 'moderator'].includes(group))) return '읽기 가능, 편집 가능, 검토 필요';
  if ((level === 'official_only' || level === 'owner_only') && String(page.namespace_code ?? '') === 'server') return '읽기 가능, 편집 제안 가능, 서버 운영자 검토 필요';
  if (['trusted_only', 'admin_only', 'locked'].includes(level)) return '읽기 가능, 편집 제한';
  return '읽기 가능, 편집 가능';
}

export function revisionHistoryPage(page: any, revisions: any[], user: CurrentUser | null, options: { filterTag?: string } = {}) {
  const namespace = page.namespace_code as NamespaceCode;
  const pagePath = wikiUrl(namespace, page.title);
  const title = String(page.title ?? '');
  const chrome = documentToolChrome(page, 'history-page');
  const documentTitle = publicDocumentTitle(namespace, page.title, page.display_title);
  const current = revisions[0];
  const activeFilter = String(options.filterTag ?? '');
  const filterLink = (key: string, label: string) => {
    const href = key ? `${pagePath}/history?tag=${encodeURIComponent(key)}` : `${pagePath}/history`;
    const active = activeFilter === key ? ' class="active" aria-current="page"' : '';
    return `<a${active} href="${href}">${label}</a>`;
  };
  const aclLogs = Array.isArray(page.aclLogs) ? page.aclLogs : [];
  const aclRows = aclLogs
    .map((log: any) => `<tr><td><span class="tag">권한 변경</span></td><td>${escapeHtml(formatDateTime(log.created_at))}</td><td>${escapeHtml(log.actor_name ?? '자동')}</td><td>${escapeHtml(log.reason ?? '권한 규칙 변경')}</td></tr>`)
    .join('');
  const historySummary = [
    ['판', `${revisions.length}개`, activeFilter ? '현재 필터에 맞는 판 기록입니다.' : '읽을 수 있는 전체 판 기록입니다.'],
    ['현재 판', current ? `r${current.revision_no}` : '없음', current ? `${formatDateTime(current.created_at)} · ${current.actor_name ?? '익명'}` : '표시할 최신 판이 없습니다.'],
    ['권한 변경', `${aclLogs.length}건`, 'ACL과 보호 변경 흐름을 함께 확인합니다.']
  ]
    .map(([label, value, detail]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(String(value))}</strong><small>${escapeHtml(String(detail))}</small></span>`)
    .join('');
  const rows = revisions
    .map((revision, index) => {
      const previous = revisions[index + 1];
      const diffHref = previous ? `${pagePath}/diff?from=${previous.id}&to=${revision.id}` : '';
      const viewHref = `${pagePath}?oldid=${revision.id}`;
      const canHide = Boolean(user?.permissions.includes('revision.hide') || user?.permissions.includes('page.delete') || user?.groups.includes('developer'));
      const unhide = canHide && revision.visibility && revision.visibility !== 'public'
        ? `<form method="post" action="/admin/revisions/${escapeHtml(String(revision.id))}/unhide">
            <button type="submit">숨김 해제</button>
          </form>`
        : '';
      const summary = publicRevisionSummary(revision.edit_summary);
      const tags = revisionTagsHtml(revision, index === 0);
      const sizeDelta = revision.size_delta ?? (previous ? Number(revision.content_size ?? 0) - Number(previous.content_size ?? 0) : revision.content_size);
      return `<tr>
        <td data-label="비교" class="revision-compare"><label title="비교 기준"><input type="radio" name="from" value="${escapeHtml(String(revision.id))}"${index === 1 ? ' checked' : ''}><span class="sr-only">비교 기준</span></label><label title="비교 대상"><input type="radio" name="to" value="${escapeHtml(String(revision.id))}"${index === 0 ? ' checked' : ''}><span class="sr-only">비교 대상</span></label></td>
        <td data-label="판"><strong>r${escapeHtml(String(revision.revision_no))}</strong>${index === 0 ? ' <span class="tag">현재</span>' : ''}${revision.visibility && revision.visibility !== 'public' ? ' <span class="tag">숨김</span>' : ''}</td>
        <td data-label="시간">${escapeHtml(formatDateTime(revision.created_at))}</td>
        <td data-label="사용자">${escapeHtml(String(revision.actor_name ?? '익명'))}</td>
        <td data-label="요약"><span class="${summary === '요약 없음' ? 'muted' : ''}">${escapeHtml(summary)}</span></td>
        <td data-label="변화">${changeSizeBadge(sizeDelta)}</td>
        <td data-label="태그"><div class="tag-row">${tags}</div></td>
        <td data-label="작업"><a class="button ghost" href="${viewHref}">보기</a>${previous ? `<a class="button ghost" href="${diffHref}">비교</a>` : ''}${unhide}</td>
      </tr>`;
    })
    .join('');
  return layout(
    `${documentTitle} 판 기록`,
    `${chrome.open}
      <section class="directory-head">
        <h1>${escapeHtml(documentTitle)} 문서의 판 기록</h1>
        <p>이 문서의 이전 판을 보거나 두 판을 비교할 수 있습니다.</p>
        ${current ? `<small>현재 판: r${escapeHtml(String(current.revision_no))} · ${escapeHtml(formatDateTime(current.created_at))} · ${escapeHtml(String(current.actor_name ?? '익명'))}</small>` : ''}
        ${documentToolTabs(namespace, title, 'history')}
      </section>
      <section class="directory-summary history-summary" aria-label="판 기록 요약">${historySummary}</section>
      <form class="revision-compare-panel" method="get" action="${pagePath}/diff">
        <strong>비교할 두 판을 선택하세요</strong>
        <button>선택한 두 판 비교</button>
        <div class="history-filter-row">
          <span>필터</span>
          ${filterLink('', '전체')}
          ${filterLink('edit', '일반 편집')}
          ${filterLink('rollback', '되돌리기')}
          ${filterLink('review', '검토 대기')}
          ${filterLink('official', '공식 문서')}
          ${user ? `${filterLink('operation', '운영 기록')}${filterLink('hidden', '숨겨진 판')}` : ''}
        </div>
        <table class="revision-table">
          <thead><tr><th>비교</th><th>판</th><th>시간</th><th>사용자</th><th>요약</th><th>변화</th><th>태그</th><th>작업</th></tr></thead>
          <tbody>${rows || emptyTableRow(8, '표시할 판 기록 없음', '읽을 수 있는 공개 판이 아직 없거나 현재 필터에 맞는 판이 없습니다.', pagePath, '문서로 돌아가기')}</tbody>
        </table>
      </form>
      ${aclRows ? `<section><h2>권한 변경 기록</h2>${componentTableMarkup(`<thead><tr><th>구분</th><th>시간</th><th>변경자</th><th>사유</th></tr></thead><tbody>${aclRows}</tbody>`)}</section>` : ''}
    ${chrome.close}`,
    user,
    namespace,
    {
      headHtml: chrome.serverTheme.headHtml,
      bodyClass: chrome.serverTheme.bodyClass
    }
  );
}

export function rawPage(page: any, content: string, user: CurrentUser | null, revision: any = null) {
  const namespace = page.namespace_code as NamespaceCode;
  const pagePath = wikiUrl(namespace, page.title);
  const chrome = documentToolChrome(page, 'raw-page');
  const documentTitle = publicDocumentTitle(namespace, page.title, page.display_title);
  const revisionLabel = revision?.revision_no
    ? `r${escapeHtml(String(revision.revision_no))} · ${escapeHtml(formatDateTime(revision.created_at ?? ''))}`
    : '현재 판';
  const rawSummary = `<section class="raw-summary" aria-label="원문 요약">
    <span><strong>${revision?.revision_no ? `r${escapeHtml(String(revision.revision_no))}` : '현재'}</strong>표시 판<small>${revision?.created_at ? escapeHtml(formatDateTime(revision.created_at)) : '현재 공개 판의 원문입니다.'}</small></span>
    <span><strong>${escapeHtml(rawByteLabel(content))}</strong>원문 크기<small>저장된 위키 문법 텍스트 기준입니다.</small></span>
    <span><strong>${escapeHtml(spaceLabel(namespace))}</strong>문서 공간<small>${escapeHtml(documentTitle)} 문서의 원문입니다.</small></span>
  </section>`;
  const rawGuide = `<section class="raw-guide-panel">
    <strong>원문 읽는 방법</strong>
    <ol>
      <li><span>이 화면은 렌더링된 문서가 아니라 저장된 위키 문법을 그대로 보여줍니다.</span></li>
      <li><span>과거 판 원문은 편집 참고용이며 현재 문서 내용과 다를 수 있습니다.</span></li>
      <li><span>내용을 고치려면 편집 탭으로 이동하고, 변경 전에는 판 기록에서 차이를 확인합니다.</span></li>
    </ol>
  </section>`;
  return layout(
    `${documentTitle} 원문`,
    `${chrome.open}
      <section class="directory-head">
        <h1>${escapeHtml(documentTitle)} 원문</h1>
        <p>렌더링 전 위키 문법 원문입니다. ACL의 원문 보기 권한이 적용됩니다.</p>
        ${documentToolTabs(namespace, String(page.title ?? ''), 'raw')}
        <div class="quick-actions raw-tool-actions">
          <a class="button" href="${pagePath}">문서 보기</a>
          <a class="button ghost" href="${pagePath}/history">판 기록</a>
          ${user ? `<a class="button ghost" href="${pagePath}/edit">편집</a>` : ''}
        </div>
      </section>
      ${rawSummary}
      ${rawGuide}
      <section class="raw-source-panel">
        <header><strong>${revisionLabel}</strong><span>${escapeHtml(rawByteLabel(content))}</span></header>
        <div class="raw-source-help">아래 내용은 복사 가능한 위키 문법 원문입니다. 모바일에서는 가로 스크롤로 긴 줄을 확인합니다.</div>
        <pre class="codeblock raw-source"><code>${escapeHtml(content)}</code></pre>
      </section>
    ${chrome.close}`,
    user,
    namespace,
    {
      headHtml: chrome.serverTheme.headHtml,
      bodyClass: chrome.serverTheme.bodyClass
    }
  );
}

export function revisionDiffPage(page: any, diff: any, user: CurrentUser | null) {
  const namespace = page.namespace_code as NamespaceCode;
  const pagePath = wikiUrl(namespace, page.title);
  const title = String(page.title ?? '');
  const chrome = documentToolChrome(page, 'history-page');
  const documentTitle = publicDocumentTitle(namespace, page.title, page.display_title);
  const fromLabel = `r${escapeHtml(String(diff?.fromRevisionNo ?? diff?.fromRevisionId ?? ''))}`;
  const toLabel = `r${escapeHtml(String(diff?.toRevisionNo ?? diff?.toRevisionId ?? ''))}`;
  const rows = (diff?.changes ?? [])
    .map(
      (change: any) => `<tr>
        <td>${escapeHtml(String(change.line))}</td>
        <td><pre>${escapeHtml(change.before)}</pre></td>
        <td><pre>${escapeHtml(change.after)}</pre></td>
      </tr>`
    )
    .join('');
  const changeCount = (diff?.changes ?? []).length;
  return layout(
    `${documentTitle} 문서 비교`,
    `${chrome.open}
      <section class="directory-head">
        <h1>${escapeHtml(documentTitle)} 문서 비교</h1>
        <p>${fromLabel}에서 ${toLabel}까지 변경된 줄입니다.</p>
        ${documentToolTabs(namespace, title, 'history')}
      </section>
      <nav class="quick-actions">
        <a class="button" href="${pagePath}">현재 문서</a>
        <a class="button ghost" href="${pagePath}/history">판 기록</a>
        <a class="button ghost" href="${pagePath}?oldid=${escapeHtml(String(diff?.fromRevisionId ?? ''))}">이전 판 보기</a>
        <a class="button ghost" href="${pagePath}?oldid=${escapeHtml(String(diff?.toRevisionId ?? ''))}">새 판 보기</a>
      </nav>
      <section class="diff-summary">
        <article><strong>이전 판</strong><span>${fromLabel}</span></article>
        <article><strong>새 판</strong><span>${toLabel}</span></article>
        <article><strong>변경 줄</strong><span>${escapeHtml(String(changeCount))}개</span></article>
      </section>
      <div class="history-filter-row"><span>보기</span><strong>한 줄 보기</strong><span>나란히 보기는 데스크톱에서만 보조로 사용합니다.</span></div>
      <table class="diff-table">
        <thead><tr><th>줄</th><th>이전</th><th>이후</th></tr></thead>
        <tbody>${rows || emptyTableRow(3, '변경된 줄 없음', '선택한 두 판의 본문이 같거나 표시할 수 있는 줄 단위 변경이 없습니다.', `${pagePath}/history`, '판 기록 보기')}</tbody>
      </table>
    ${chrome.close}`,
    user,
    namespace,
    {
      headHtml: chrome.serverTheme.headHtml,
      bodyClass: chrome.serverTheme.bodyClass
    }
  );
}

function revisionTagsHtml(revision: any, isCurrent: boolean) {
  const tags = new Set<string>();
  if (isCurrent) tags.add('현재');
  if (revision.is_minor) tags.add('사소한 편집');
  if (revision.visibility && revision.visibility !== 'public') tags.add('숨겨진 판');
  const summary = String(revision.edit_summary ?? '');
  if (/되돌/.test(summary)) tags.add('되돌리기');
  if (/공식|운영자/.test(summary)) tags.add('공식 문서');
  if (/링크/.test(summary)) tags.add('외부 링크 변경');
  for (const item of safeJson<string>(revision.edit_tags)) tags.add(item);
  if (!tags.size) tags.add('일반 편집');
  return [...tags].map((item) => tag(item)).join('');
}

function publicRevisionSummary(value: unknown) {
  const summary = String(value ?? '').trim();
  if (!summary) return '요약 없음';
  if (/초기 기준 문서 작성|기본 문서 생성|대문 생성|일괄/.test(summary)) return '문서 작성';
  return summary;
}

export function recentChangesPage(rows: any[], filters: Record<string, string>, user: CurrentUser | null, options: { admin?: boolean } = {}) {
  const isAdminRecent = Boolean(options.admin);
  const canHideRevision = isAdminRecent && Boolean(user?.permissions.includes('revision.hide') || user?.permissions.includes('page.delete') || user?.groups.includes('developer'));
  const typeOptions = ['create', 'edit', 'move', 'delete', 'restore', 'rollback', 'protect', 'discussion', 'file_upload']
    .map((type) => `<option value="${type}"${filters.type === type ? ' selected' : ''}>${recentTypeLabel(type)}</option>`)
    .join('');
  const namespaceOptions = [
    ['', '전체'],
    ['main', '위키'],
    ['mod', '모드 위키'],
    ['server', '서버 위키'],
    ['dev', '개발']
  ]
    .map(([value, label]) => `<option value="${value}"${filters.namespace === value ? ' selected' : ''}>${label}</option>`)
    .join('');
  const prefixFilter = String(filters.prefix ?? '').trim();
  const scopeQuery = prefixFilter ? `?namespace=${encodeURIComponent(filters.namespace ?? '')}&prefix=${encodeURIComponent(prefixFilter)}` : '';
  const scopeInput = prefixFilter ? `<input type="hidden" name="prefix" value="${escapeHtml(prefixFilter)}">` : '';
  const scopeLabel = prefixFilter ? `<span class="filter-scope">범위: ${escapeHtml(spaceLabel(String(filters.namespace ?? '')))} · ${escapeHtml(prefixFilter)}</span>` : '';
  const rowTitle = (row: any) => {
    const rawTitle = String(row.title ?? '');
    const display = publicDocumentTitle(row.namespace_code, row.title, row.display_title);
    if (prefixFilter && row.namespace_code === filters.namespace && rawTitle.startsWith(`${prefixFilter}/`) && (!row.display_title || row.display_title === rawTitle)) {
      return rawTitle.slice(prefixFilter.length + 1);
    }
    return display;
  };
  const todayCount = rows.filter((row) => isTodayLike(row.created_at)).length;
  const reviewCount = rows.filter((row) => /검토|review|pending/i.test(String(row.edit_summary ?? row.change_type ?? ''))).length;
  const rollbackCount = rows.filter((row) => row.change_type === 'rollback').length;
  const tableRows = rows
    .map((row) => {
      const href = row.change_type === 'delete' ? `${wikiUrl(row.namespace_code, row.title)}/history` : wikiUrl(row.namespace_code, row.title);
      const diffHref = row.revision_no && row.change_type !== 'delete' ? `${wikiUrl(row.namespace_code, row.title)}/diff` : '';
      const hideAction = canHideRevision && row.revision_id && (!row.visibility || row.visibility === 'public')
        ? `<form class="inline-post-action" method="post" action="/admin/revisions/${escapeHtml(String(row.revision_id))}/hide">
            <input type="hidden" name="reason" value="최근 바뀜 관리자 숨김">
            <input type="hidden" name="visibility" value="admin_only">
            <button class="button ghost" type="submit">숨김</button>
          </form>`
        : '';
      const adminActions = isAdminRecent
        ? `<a class="button ghost" href="${wikiUrl(row.namespace_code, row.title)}/history">역사</a>${hideAction}`
        : '';
      return `<tr>
        <td data-label="문서" class="recent-title"><a href="${href}">${escapeHtml(rowTitle(row))}</a><small>${escapeHtml(searchGroupLabel(row.namespace_code))} · ${recentTypeLabel(row.change_type)}</small></td>
        <td data-label="수정자">${row.actor_id ? `<a href="/users/${escapeHtml(String(row.actor_id))}">${escapeHtml(row.actor_name ?? '익명')}</a>` : escapeHtml(row.actor_name ?? '익명')}</td>
        <td data-label="증감">${changeSizeBadge(row.size_delta)}</td>
        <td data-label="리비전">${row.revision_no ? `r${escapeHtml(String(row.revision_no))}` : '-'}</td>
        <td data-label="요약">${escapeHtml(publicRevisionSummary(row.edit_summary))}</td>
        <td data-label="시간">${escapeHtml(formatDateTime(row.created_at))}</td>
        <td data-label="작업">${diffHref ? `<a class="button ghost" href="${diffHref}">비교</a>` : '<span class="muted">-</span>'}${adminActions}</td>
      </tr>`;
    })
    .join('');
  const cards = rows
    .map((row) => {
      const href = row.change_type === 'delete' ? `${wikiUrl(row.namespace_code, row.title)}/history` : wikiUrl(row.namespace_code, row.title);
      const diffHref = row.revision_no && row.change_type !== 'delete' ? `${wikiUrl(row.namespace_code, row.title)}/diff` : '';
      const hideAction = canHideRevision && row.revision_id && (!row.visibility || row.visibility === 'public')
        ? `<form class="inline-post-action" method="post" action="/admin/revisions/${escapeHtml(String(row.revision_id))}/hide">
            <input type="hidden" name="reason" value="최근 바뀜 관리자 숨김">
            <input type="hidden" name="visibility" value="admin_only">
            <button type="submit">숨김</button>
          </form>`
        : '';
      const adminActions = isAdminRecent ? `<a href="${wikiUrl(row.namespace_code, row.title)}/history">역사</a>${hideAction}` : '';
      const summary = publicRevisionSummary(row.edit_summary);
      return `<article class="change-card">
        <a class="change-title" href="${href}">${escapeHtml(rowTitle(row))}</a>
        <div class="change-meta"><span>${recentTypeLabel(row.change_type)}</span><span>${escapeHtml(searchGroupLabel(row.namespace_code))}</span>${row.revision_no ? `<span>r${escapeHtml(String(row.revision_no))}</span>` : ''}${changeSizeBadge(row.size_delta)}</div>
        <div class="change-byline">${row.actor_id ? `<a href="/users/${escapeHtml(String(row.actor_id))}">${escapeHtml(row.actor_name ?? '익명')}</a>` : escapeHtml(row.actor_name ?? '익명')} · ${escapeHtml(formatDateTime(row.created_at, ''))}</div>
        ${summary ? `<p class="change-summary">${escapeHtml(summary)}</p>` : ''}
        <div class="change-actions"><a href="${href}">보기</a>${diffHref ? `<a href="${diffHref}">비교</a>` : ''}${adminActions}</div>
      </article>`;
    })
    .join('');
  const advancedFilters = isAdminRecent
    ? `<label>사용자<input name="actor" value="${escapeHtml(filters.actor ?? filters.actorId ?? '')}" placeholder="사용자명 또는 번호"></label>
      <fieldset>
        <legend>포함할 항목</legend>
        <label><input type="checkbox" name="contentOnly" value="0"${filters.contentOnly === '0' ? ' checked' : ''}>도움말 포함</label>
        <label><input type="checkbox" name="includeManagement" value="1"${filters.includeManagement === '1' ? ' checked' : ''}>운영 기록 포함</label>
        <label><input type="checkbox" name="includeDeleted" value="1"${filters.includeDeleted === '1' ? ' checked' : ''}>삭제된 문서 포함</label>
        <label><input type="checkbox" name="includeSystem" value="1"${filters.includeSystem === '1' ? ' checked' : ''}>숨긴 문서 포함</label>
      </fieldset>`
    : '';
  const quickFilters = isAdminRecent
    ? `<a href="/admin/recent${scopeQuery}">본문 문서만</a>
            <a href="/admin/recent${scopeQuery ? `${scopeQuery}&includeManagement=1&includeDeleted=1` : '?includeManagement=1&includeDeleted=1'}">운영 기록 포함</a>`
    : `<a href="/recent${scopeQuery}">본문 문서만</a>`;
  const filterSummary = isAdminRecent
    ? (prefixFilter ? '선택한 위키의 공개 변경만 표시 중' : '공개 문서 변경과 운영 기록을 필터링합니다')
    : (prefixFilter ? '선택한 위키의 공개 변경만 표시 중' : '공개 본문 문서 변경만 표시 중');
  const form = `<details class="recent-filter-panel">
    <summary><span>필터</span><small>${filterSummary}</small></summary>
    <form class="filter-bar recent-filter" method="get">
      ${scopeInput}
      ${scopeLabel}
      <label>공간<select name="namespace">${namespaceOptions}</select></label>
      <label>변경 유형<select name="type"><option value="">전체 변경</option>${typeOptions}</select></label>
      ${advancedFilters}
      <a class="button ghost" href="${isAdminRecent ? '/admin/recent' : '/recent'}">초기화</a>
      <button>적용</button>
    </form>
  </details>`;
  return layout(
    isAdminRecent ? '관리자 최근 바뀜' : '최근 바뀜',
    `<main class="narrow recent-page recent-layout-page">
      <section class="directory-head">
        <h1>최근 바뀜</h1>
        <p>${isAdminRecent ? '공개 문서 변경과 운영 기록을 확인합니다.' : '공개 문서 변경을 확인합니다.'}</p>
      </section>
      <div class="recent-layout">
        <section class="recent-main" aria-label="최근 변경 목록">
          <section class="change-list recent-card-list" aria-label="모바일 최근 변경 카드">${cards || '<section class="empty-state compact"><h2>최근 변경 없음</h2><p>문서가 수정되면 이 목록에 변경 유형, 요약, 작성자가 표시됩니다.</p></section>'}</section>
          <div class="recent-table-view" aria-label="최근 변경 표">
            ${componentTableMarkup(`<thead><tr><th>문서</th><th>수정자</th><th>증감</th><th>리비전</th><th>요약</th><th>시간</th><th>작업</th></tr></thead><tbody>${tableRows || emptyTableRow(7, '최근 변경 없음', '문서가 수정되면 이 표에 변경 유형, 요약, 작성자가 표시됩니다.', '/new', '새 문서 만들기')}</tbody>`, 'recent-table')}
          </div>
        </section>
        <aside class="recent-sidebar" aria-label="최근 바뀜 도구">
          <section class="recent-summary" aria-label="최근 바뀜 요약">
            <span>오늘 ${todayCount}건</span>
            <span>검토 필요 ${reviewCount}건</span>
            <span>되돌림 ${rollbackCount}건</span>
          </section>
          <nav class="recent-quick-filters">
            ${quickFilters}
          </nav>
          ${form}
        </aside>
      </div>
    </main>`,
    user,
    isAdminRecent ? 'admin' : 'main'
  );
}

export function watchlistPage(pages: any[], changes: any[], user: CurrentUser | null) {
  const watchedCount = pages.length;
  const changeCount = changes.length;
  const pageRows = pages
    .map(
      (row) => {
        const pageId = Number(row.id ?? row.page_id ?? 0);
        const controls = pageId
          ? `<form class="inline-form watchlist-action-form" method="post" action="/watchlist/${escapeHtml(String(pageId))}">
              <input type="hidden" name="watchDiscussion" value="${row.watch_discussion ? '0' : '1'}">
              <button>${row.watch_discussion ? '토론 끄기' : '토론 포함'}</button>
            </form>
            <form class="inline-form watchlist-action-form" method="post" action="/watchlist/${escapeHtml(String(pageId))}/remove">
              <button class="button ghost">해제</button>
            </form>`
          : '-';
        return `<tr>
        <td data-label="문서"><a href="${wikiUrl(row.namespace_code, row.title)}"><strong>${escapeHtml(publicDocumentTitle(row.namespace_code, row.title, row.display_title))}</strong></a></td>
        <td data-label="공간">${spaceLabel(String(row.namespace_code ?? ''))}</td>
        <td data-label="토론">${row.watch_discussion ? '토론 포함' : '문서만'}</td>
        <td data-label="추가일">${escapeHtml(formatDateTime(row.created_at))}</td>
        <td data-label="관리">${controls}</td>
      </tr>`;
      }
    )
    .join('');
  const changeRows = changes
    .map(
      (row) => {
        const href = row.change_type === 'delete' ? `${wikiUrl(row.namespace_code, row.title)}/history` : wikiUrl(row.namespace_code, row.title);
        return `<tr>
          <td data-label="종류"><span class="tag">${recentTypeLabel(String(row.change_type ?? ''))}</span></td>
          <td data-label="문서"><a href="${href}"><strong>${escapeHtml(publicDocumentTitle(row.namespace_code, row.title, row.display_title))}</strong></a><small>${spaceLabel(String(row.namespace_code ?? ''))}</small></td>
          <td data-label="요약">${escapeHtml(publicRevisionSummary(row.summary ?? row.edit_summary))}</td>
          <td data-label="시간">${escapeHtml(formatDateTime(row.created_at))}</td>
        </tr>`;
      }
    )
    .join('');
  return layout(
    '감시문서',
    `<main class="narrow watchlist-page">
      <section class="directory-head">
        <h1>감시문서</h1>
        <p>감시 중인 문서와 최근 변경을 한 화면에서 확인합니다.</p>
      </section>
      <section class="task-summary watchlist-summary" aria-label="감시문서 요약">
        <span><strong>${watchedCount}</strong>감시 문서</span>
        <span><strong>${changeCount}</strong>최근 변경</span>
        <span><strong>${changes.filter((row) => String(row.change_type ?? '') === 'discussion').length}</strong>토론 변경</span>
      </section>
      <section class="watchlist-start-panel">
        <div>
          <h2>감시할 문서를 찾기</h2>
          <p>문서 상단의 감시 버튼을 누르면 이 목록에 추가됩니다.</p>
        </div>
        <form class="watchlist-search" action="/search" method="get">
          <input name="q" placeholder="감시할 문서 검색">
          <button>검색</button>
        </form>
        <div class="quick-actions">
          <a class="button ghost" href="/recent">최근 바뀜에서 찾기</a>
          <a class="button ghost" href="/new">새 문서 만들기</a>
          <a class="button ghost" href="/tasks">내 작업 보기</a>
        </div>
      </section>
      <div class="watchlist-grid">
        <section class="public-log-section watchlist-main">
          <h2>감시 중인 문서</h2>
          ${componentTableMarkup(`<thead><tr><th>문서</th><th>공간</th><th>토론</th><th>추가일</th><th>관리</th></tr></thead><tbody>${pageRows || emptyTableRow(5, '감시 중인 문서 없음', '문서 상단의 감시 버튼을 누르면 이곳에서 변경을 모아볼 수 있습니다.', '/recent', '최근 바뀜에서 찾기')}</tbody>`)}
        </section>
        <aside class="public-log-section watchlist-recent">
          <h2>최근 변경</h2>
          ${componentTableMarkup(`<thead><tr><th>종류</th><th>문서</th><th>요약</th><th>시간</th></tr></thead><tbody>${changeRows || emptyTableRow(4, '변경 내역 없음', '감시 중인 문서가 수정되면 최근 변경이 이 영역에 표시됩니다.', '/recent', '전체 최근 바뀜 보기')}</tbody>`)}
        </aside>
      </div>
    </main>`,
    user,
    'main'
  );
}

export function revisionSearchPage(rows: any[], filters: { q?: string; namespace?: string; visibility?: string }, user: CurrentUser | null, includeRestricted = false) {
  const mode = includeRestricted
    ? {
        title: '리비전 감사 검색',
        summary: '관리자 권한으로 공개, 숨김, 비공개 판을 함께 점검합니다.',
        empty: '조건에 맞는 감사 대상 리비전 없음',
        emptyDetail: '검색어, 공간, 공개 상태를 바꿔 확인하거나 최근 변경과 관리자 업무 큐를 먼저 살펴보세요.',
        actions: '<a class="button ghost" href="/admin/recent">관리자 최근 바뀜</a><a class="button ghost" href="/admin/work">검토 큐</a><a class="button ghost" href="/admin/audits">감사 허브</a>'
      }
    : {
        title: '공개 리비전 검색',
        summary: '문서 제목, 편집 요약, 작성자를 기준으로 공개 변경 기록을 찾습니다.',
        empty: '공개 검색 결과 없음',
        emptyDetail: '다른 제목이나 작성자 이름으로 검색하거나 최근 바뀜에서 흐름을 확인하세요.',
        actions: '<a class="button ghost" href="/recent">최근 바뀜</a><a class="button ghost" href="/special">특수 문서</a>'
      };
  const namespaceOptions = ['main', 'mod', 'server', 'dev', 'help', 'project']
    .map((code) => `<option value="${code}"${filters.namespace === code ? ' selected' : ''}>${spaceLabel(code)}</option>`)
    .join('');
  const visibilityOptions = includeRestricted
    ? `<label>공개 상태<select name="visibility"><option value="">전체</option>${['public', 'hidden', 'admin_only', 'suppressed']
        .map((item) => `<option value="${item}"${filters.visibility === item ? ' selected' : ''}>${revisionVisibilityLabel(item)}</option>`)
        .join('')}</select></label>`
    : '';
  const tableRows = rows
    .map(
      (row) => `<tr>
        <td data-label="리비전"><a href="${escapeHtml(row.url)}">r${escapeHtml(String(row.revision_no))}</a></td>
        <td data-label="문서"><strong>${spaceLabel(String(row.namespace ?? row.namespace_code ?? ''))}:${escapeHtml(row.title)}</strong></td>
        <td data-label="상태">${revisionVisibilityLabel(row.visibility ?? 'public')}</td>
        <td data-label="작성자">${escapeHtml(row.actor ?? '익명')}</td>
        <td data-label="요약">${escapeHtml(publicRevisionSummary(row.edit_summary))}</td>
        <td data-label="일시">${escapeHtml(formatDateTime(row.created_at))}</td>
      </tr>`
    )
    .join('');
  return layout(
    mode.title,
    `<main class="narrow revision-search-page public-log-page">
      <section class="directory-head">
        <h1>${mode.title}</h1>
        <p>${mode.summary}</p>
        <div class="quick-actions">${mode.actions}</div>
      </section>
      <section class="public-log-section">
        <h2>검색 조건</h2>
        <form class="filter-bar" method="get">
          <label>검색어<input name="q" value="${escapeHtml(filters.q ?? '')}" placeholder="문서 제목, 요약, 사용자"></label>
          <label>공간<select name="namespace"><option value="">전체</option>${namespaceOptions}</select></label>
          ${visibilityOptions}
          <button>검색</button>
        </form>
      </section>
      <section class="public-log-section">
        <h2>검색 결과</h2>
        ${componentTableMarkup(`<thead><tr><th>리비전</th><th>문서</th><th>상태</th><th>작성자</th><th>요약</th><th>일시</th></tr></thead><tbody>${tableRows || emptyTableRow(6, mode.empty, mode.emptyDetail, includeRestricted ? '/admin/recent' : '/recent', includeRestricted ? '관리자 최근 바뀜' : '최근 바뀜 보기')}</tbody>`)}
      </section>
    </main>`,
    user,
    includeRestricted ? 'admin' : 'main'
  );
}

function isTodayLike(value: unknown) {
  const text = String(value ?? '');
  const date = new Date(text.replace(' ', 'T'));
  if (Number.isNaN(date.getTime())) return false;
  const now = new Date();
  return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
}

function recentTypeLabel(type: string) {
  const labels: Record<string, string> = {
    create: '새 문서',
    edit: '수정',
    move: '이동',
    delete: '삭제',
    restore: '복구',
    rollback: '되돌림',
    protect: '보호',
    discussion: '토론',
    file_upload: '파일'
  };
  return labels[type] ?? type ?? '';
}

function changeSizeBadge(value: unknown) {
  if (value === null || value === undefined || value === '') return '<span class="change-size neutral">0</span>';
  const delta = Number(value);
  if (!Number.isFinite(delta) || delta === 0) return '<span class="change-size neutral">0</span>';
  const sign = delta > 0 ? '+' : '';
  const className = delta > 0 ? 'positive' : 'negative';
  return `<span class="change-size ${className}">${sign}${escapeHtml(String(delta))}</span>`;
}

function revisionVisibilityLabel(value: unknown) {
  const labels: Record<string, string> = {
    public: '공개',
    hidden: '숨김',
    admin_only: '관리자 전용',
    suppressed: '비공개'
  };
  return labels[String(value ?? '')] ?? String(value ?? '공개');
}

function formatRevisionTags(value: unknown) {
  const tags = safeJson<string>(value as string | string[] | null);
  return tags.length ? tags.join(', ') : '';
}

export function categoryPage(title: string, rows: any[], user: CurrentUser | null) {
  const items = rows
    .map(
      (row) => `<article class="result-card category-member-card">
        <header>
          <a class="result-title" href="${wikiUrl(row.namespace_code, row.title)}">${escapeHtml(row.display_title ?? row.title)}</a>
          <span class="tag">${spaceLabel(row.namespace_code)}</span>
        </header>
        <p>${escapeHtml(row.excerpt ?? '')}</p>
        <div class="quick-actions"><a class="button ghost" href="${wikiUrl(row.namespace_code, row.title)}">문서 보기</a></div>
      </article>`
    )
    .join('');
  const categoryActions = `<nav class="category-actions" aria-label="분류 작업">
    <a class="button" href="/new/wiki?title=${encodeURIComponent(title)}">관련 문서 만들기</a>
    <a class="button ghost" href="/search?q=${encodeURIComponent(title)}">전체 검색</a>
    <a class="button ghost" href="/recent">최근 바뀜</a>
  </nav>`;
  const empty = `<section class="empty-state category-empty-state">
    <h2>${escapeHtml(title)} 분류에 문서가 없습니다</h2>
    <p>분류명이 새 주제라면 먼저 관련 문서를 만들고, 이미 문서가 있다면 문서 하단에 분류를 추가하세요.</p>
    <div class="quick-actions">
      <a class="button" href="/new/wiki?title=${encodeURIComponent(title)}">새 문서 만들기</a>
      <a class="button ghost" href="/search?q=${encodeURIComponent(title)}">전체 검색</a>
      <a class="button ghost" href="/special/needed-pages">필요한 문서</a>
    </div>
  </section>`;
  return layout(
    `${title} 분류`,
    `<main class="search-shell category-page">
      <section class="search-head">
        <div>
          <h1>${escapeHtml(title)} 분류</h1>
          <p>같은 주제로 묶인 위키 문서를 한곳에서 탐색합니다.</p>
        </div>
        <form class="search-page" action="/search" method="get">
          <input name="q" value="${escapeHtml(title)}" aria-label="검색어" placeholder="검색어">
          <button>검색</button>
        </form>
      </section>
      <section class="category-summary" aria-label="분류 요약">
        <span><strong>${escapeHtml(String(rows.length))}</strong><small>문서</small></span>
        <span><strong>${escapeHtml(title)}</strong><small>분류명</small></span>
        <span><strong>위키</strong><small>기본 공간</small></span>
      </section>
      <section class="doc-status category-guide-panel">
        <strong>분류 사용 방법</strong>
        <span>아래 문서 목록에서 같은 주제의 문서를 확인하고, 빠진 문서는 새로 만들거나 기존 문서 하단에 분류를 추가하세요.</span>
      </section>
      ${categoryActions}
      <section class="search-results">${items || empty}</section>
    </main>`,
    user,
    'main'
  );
}

export function searchPage(q: string, results: any[], user: CurrentUser | null, activeSpace = '', activePrefix = '', allResults: any[] = results, queryLogId: number | null = null) {
  const groups = groupResults(results);
  const total = results.length;
  const tabCounts = searchTabCounts(allResults);
  const hasQuery = Boolean(q.trim());
  const scopeLabel = activePrefix ? `${activePrefix} 위키` : activeSpace ? searchTabLabel(activeSpace) : '전체 MineWiki';
  const primaryAction = hasQuery
    ? `<a class="button" href="/new?title=${encodeURIComponent(q)}">새 문서 만들기</a>`
    : '<a class="button" href="/new">새 문서 만들기</a>';
  const searchGuide = `<aside class="search-guide-panel" aria-label="검색 도움">
    <strong>${hasQuery ? '다음 행동' : '검색 시작'}</strong>
    <p>${hasQuery ? '결과가 부족하면 문서 작성 요청을 남기거나 새 문서를 바로 만들 수 있습니다.' : '문서명, 별칭, 모드명, 서버명을 입력하면 공간별로 결과를 나눠 보여줍니다.'}</p>
    <div class="quick-actions">
      ${primaryAction}
      ${hasQuery ? `<a class="button ghost" href="/special/page-requests?title=${encodeURIComponent(q)}">작성 요청 보기</a>` : '<a class="button ghost" href="/recent">최근 바뀜</a>'}
      ${canAccessAdminTools(user) ? '<a class="button ghost" href="/admin/search">검색 관리</a>' : ''}
    </div>
  </aside>`;
  const filterHref = (space: string) => `/search?q=${encodeURIComponent(q)}${space ? `&space=${encodeURIComponent(space)}` : ''}`;
  const prefixNotice = activePrefix ? `<span class="tag">${escapeHtml(activePrefix)} 내부</span>` : '';
  const scopeTabs = activePrefix
    ? `<nav class="search-scope-tabs">
        <a class="active" href="/search?q=${encodeURIComponent(q)}&space=${encodeURIComponent(activeSpace)}&prefix=${encodeURIComponent(activePrefix)}">${escapeHtml(activePrefix)} 위키</a>
        <a href="/search?q=${encodeURIComponent(q)}&space=${encodeURIComponent(activeSpace)}">모든 ${escapeHtml(searchTabLabel(activeSpace))}</a>
        <a href="/search?q=${encodeURIComponent(q)}">전체 MineWiki</a>
      </nav>`
    : '';
  const requestNamespace = ['main', 'guide', 'mod', 'modpack', 'server', 'dev', 'data', 'project', 'help'].includes(activeSpace) ? activeSpace : 'main';
  const emptyHtml = q
    ? `<div class="empty-state">
        <strong>검색 결과가 없습니다.</strong>
        <p>찾고 있던 것이 있나요?</p>
        <form class="feedback-inline" method="post" action="/page-requests">
          <input type="hidden" name="namespace" value="${escapeHtml(requestNamespace)}">
          <input type="hidden" name="title" value="${escapeHtml(q)}">
          <input type="hidden" name="reason" value="${escapeHtml(`검색 결과 없음: ${q}`)}">
          <input type="hidden" name="redirectTo" value="/search?q=${encodeURIComponent(q)}${activeSpace ? `&space=${encodeURIComponent(activeSpace)}` : ''}">
          ${turnstileWidget('page_request')}
          <button>문서 작성 요청</button>
        </form>
        <div class="quick-actions">
          <a class="button ghost" href="mailto:${escapeHtml(config.supportEmail)}?subject=${encodeURIComponent(`MineWiki 검색어 제안: ${q}`)}">검색어 별칭 제안</a>
          <a class="button ghost" href="/new?title=${encodeURIComponent(q)}">새 문서 만들기</a>
          <a class="button ghost" href="/servers/new">서버 위키 만들기</a>
          ${activeSpace || activePrefix ? `<a class="button ghost" href="/search?q=${encodeURIComponent(q)}">전체에서 다시 검색</a>` : ''}
          ${canAccessAdminTools(user) ? `<a class="button ghost" href="/admin/search">검색 관리</a>` : ''}
        </div>
      </div>`
    : `<section class="empty-state search-empty-state">
        <h2>검색어를 입력하세요</h2>
        <p>문서 제목, 별칭, 초성, 본문을 함께 검색합니다.</p>
        <div class="quick-actions"><a class="button" href="/wiki">위키 대문</a><a class="button ghost" href="/mods">모드</a><a class="button ghost" href="/servers">서버</a></div>
      </section>`;
  const groupedHtml = Object.entries(groups)
    .map(
      ([space, rows]) => `<section class="search-group"><h2>${searchGroupLabel(space)} <span>${rows.length}</span></h2><ol>${rows
        .map((row, index) => {
          const meta = resultMeta(row);
          return `<li class="search-result-item">
            <a href="${searchClickUrl(q, row, index + 1, queryLogId)}"><span class="space-badge">${resultBadge(row)}</span>${escapeHtml(searchResultTitle(row))}</a>
            ${meta ? `<small class="search-result-meta">${meta}</small>` : ''}
            <p>${escapeHtml(searchExcerpt(row.excerpt ?? ''))}</p>
            <div class="tag-row">${searchResultTags(row)}</div>
          </li>`;
        })
        .join('')}</ol></section>`
    )
    .join('');
  return layout(
    '검색',
    `<main class="search-shell">
      <section class="search-head">
        <div>
          <h1>검색</h1>
          <p>${q ? `<strong>${escapeHtml(q)}</strong> 결과 ${total}개 ${prefixNotice}` : '문서 제목, 별칭, 초성, 본문을 함께 검색합니다.'}</p>
        </div>
        <form class="search-page" action="/search" method="get">
          <input name="q" value="${escapeHtml(q)}" autofocus aria-label="검색어" placeholder="검색어">
          ${activeSpace ? `<input type="hidden" name="space" value="${escapeHtml(activeSpace)}">` : ''}
          ${activePrefix ? `<input type="hidden" name="prefix" value="${escapeHtml(activePrefix)}">` : ''}
          <button>검색</button>
        </form>
      </section>
      <nav class="search-tabs">
        <a${activeSpace === '' ? ' class="active"' : ''} href="${filterHref('')}">전체 <span>${tabCounts.all}</span></a>
        <a${activeSpace === 'main' ? ' class="active"' : ''} href="${filterHref('main')}">위키 <span>${tabCounts.main}</span></a>
        <a${activeSpace === 'mod' ? ' class="active"' : ''} href="${filterHref('mod')}">모드 <span>${tabCounts.mod}</span></a>
        <a${activeSpace === 'server' ? ' class="active"' : ''} href="${filterHref('server')}">서버 <span>${tabCounts.server}</span></a>
        <a${activeSpace === 'dev' ? ' class="active"' : ''} href="${filterHref('dev')}">개발 <span>${tabCounts.dev}</span></a>
      </nav>
      ${scopeTabs}
      <section class="search-summary" aria-label="검색 요약">
        <span><strong>${escapeHtml(String(total))}</strong><small>표시 결과</small></span>
        <span><strong>${escapeHtml(scopeLabel)}</strong><small>검색 범위</small></span>
        <span><strong>${escapeHtml(String(tabCounts.all))}</strong><small>전체 후보</small></span>
      </section>
      <section class="search-layout">
        <div class="search-results">${groupedHtml || emptyHtml}</div>
        ${searchGuide}
      </section>
    </main>`,
    user,
    activeSpace || 'main'
  );
}

function searchTabCounts(results: any[]) {
  const counts = { all: results.length, main: 0, mod: 0, server: 0, dev: 0 };
  for (const row of results) {
    const namespace = String(row.namespace_code ?? 'main');
    if (namespace === 'mod') counts.mod += 1;
    else if (namespace === 'server') counts.server += 1;
    else if (namespace === 'dev') counts.dev += 1;
    else counts.main += 1;
  }
  return counts;
}

function searchClickUrl(q: string, row: any, rank: number, queryLogId: number | null = null) {
  const target = wikiUrl(row.namespace_code, row.title);
  const params = new URLSearchParams({
    q,
    pageId: String(row.page_id ?? ''),
    rank: String(rank),
    to: target
  });
  if (queryLogId) params.set('queryLogId', String(queryLogId));
  return `/search/click?${params.toString()}`;
}

function searchTabLabel(namespace: string) {
  const labels: Record<string, string> = {
    main: '위키',
    mod: '모드 위키',
    server: '서버 위키',
    dev: '개발 문서'
  };
  return labels[namespace] ?? '문서';
}

function groupResults(results: any[]) {
  return results.reduce<Record<string, any[]>>((acc, row) => {
    const key = row.namespace_code ?? 'main';
    acc[key] = acc[key] ?? [];
    acc[key].push(row);
    return acc;
  }, {});
}

function resultBadge(row: any) {
  const namespace = String(row.namespace_code ?? 'main');
  const spaceType = String(row.space_type ?? '');
  const spaceTitle = String(row.space_title ?? '').trim();
  if (spaceType === 'mod_wiki' && spaceTitle) return `모드 위키: ${escapeHtml(spaceTitle)}`;
  if (spaceType === 'server_wiki' && spaceTitle) return `서버 공식 위키: ${escapeHtml(spaceTitle)}`;
  const title = String(row.title ?? '');
  const [root] = title.split('/');
  if (namespace === 'mod' && root && title.includes('/')) return `모드 위키: ${escapeHtml(root)}`;
  if (namespace === 'server' && root && title.includes('/')) return `서버 공식 위키: ${escapeHtml(root)}`;
  return spaceTitle ? escapeHtml(spaceTitle) : spaceLabel(namespace);
}

function resultMeta(row: any) {
  const namespace = String(row.namespace_code ?? 'main');
  const parts: string[] = [];
  if (namespace === 'mod') {
    if (row.mod_loaders) parts.push(String(row.mod_loaders));
    if (row.mod_versions) parts.push(String(row.mod_versions));
  }
  if (namespace === 'server') {
    if (row.server_genres) parts.push(String(row.server_genres));
    if (row.server_edition) parts.push(String(row.server_edition));
    if (row.server_verified_status) parts.push(serverVerificationLabel(String(row.server_verified_status)));
    if (row.server_operational_status) parts.push(serverOperationalLabel(String(row.server_operational_status)));
  }
  return parts.length ? `${escapeHtml(parts.join(' · '))} · ` : '';
}

function searchResultTitle(row: any) {
  const title = String(row.title ?? '');
  if (row.space_type === 'mod_wiki' || row.space_type === 'server_wiki') return `${String(row.space_title || title).replace(/\/대문$/, '')} 위키`;
  return title.replace(/\/대문$/, '');
}

function searchExcerpt(value: unknown) {
  const cleaned = String(value ?? '')
    .replace(/\{\{[\s\S]*?\}\}/g, ' ')
    .replace(/\[\[분류:[^\]]+\]\]/g, ' ')
    .replace(/\[\[([^\]|]+)\|?([^\]]*)\]\]/g, (_match, target, label) => label || target)
    .replace(/'{2,}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return '요약 없음';
  return cleaned.length > 120 ? `${cleaned.slice(0, 118)}...` : cleaned;
}

function searchResultTags(row: any) {
  const namespace = String(row.namespace_code ?? 'main');
  const tags: string[] = [];
  if (namespace === 'mod') {
    tags.push(...splitTagText(row.mod_loaders).slice(0, 3));
    tags.push(...splitTagText(row.mod_versions).slice(0, 2));
  }
  if (namespace === 'server') {
    if (row.server_verified_status) tags.push(serverVerificationLabel(row.server_verified_status));
    if (row.server_edition) tags.push(serverEditionLabel(row.server_edition));
    tags.push(...splitTagText(row.server_genres).slice(0, 3));
  }
  if (!tags.length) tags.push(searchGroupLabel(namespace));
  return tags.map((item) => tag(item)).join('');
}

function searchGroupLabel(namespace: string) {
  const labels: Record<string, string> = {
    main: '위키',
    mod: '모드',
    modpack: '모드팩',
    server: '서버',
    dev: '개발',
    guide: '위키',
    data: '데이터',
    help: '도움말',
    project: '프로젝트',
    template: '틀',
    file: '파일'
  };
  return labels[namespace] ?? namespace;
}

function spaceLabel(namespace: string) {
  const labels: Record<string, string> = {
    main: '위키',
    mod: '모드',
    modpack: '모드팩',
    server: '서버',
    dev: '개발',
    guide: '가이드',
    data: '데이터',
    help: '도움말',
    project: '프로젝트',
    template: '틀',
    file: '파일'
  };
  return labels[namespace] ?? escapeHtml(namespace);
}

export function adminPage(rows: Record<string, any[]>, user: CurrentUser | null) {
  const workItems = rows.work ?? [];
  const reports = rows.reports ?? [];
  const users = rows.users ?? [];
  const logs = rows.logs ?? [];
  const feedback = rows.feedback ?? [];
  const openWorkCount = workItems.filter((item) => !['done', 'dismissed', 'resolved', 'closed'].includes(String(item.status ?? 'open'))).length;
  const urgentWorkCount = workItems.filter((item) => ['urgent', 'high'].includes(String(item.priority ?? ''))).length;
  const openReportCount = reports.filter((item) => !['resolved', 'rejected', 'closed'].includes(String(item.status ?? 'open'))).length;
  const activeFeedbackCount = feedback.filter((item) => !['done', 'wontfix', 'resolved', 'closed'].includes(String(item.status ?? 'open'))).length;
  const dashboardCards = [
    ['열린 업무', `${openWorkCount}건`, urgentWorkCount ? `긴급/높음 ${urgentWorkCount}건 먼저 처리` : '대기 중인 운영 업무입니다.', '/admin/work'],
    ['열린 신고', `${openReportCount}건`, '문서, 파일, 사용자 신고를 확인합니다.', '/admin/reports'],
    ['사용자 피드백', `${activeFeedbackCount}건`, '베타 화면에서 들어온 의견입니다.', '#feedback'],
    ['최근 가입', `${users.length}명`, '새 계정과 상태를 확인합니다.', '#users']
  ]
    .map(([title, value, detail, href]) => `<a class="operator-card" href="${escapeHtml(href)}"><strong>${escapeHtml(title)}</strong> <span>${escapeHtml(value)}</span> <small>${escapeHtml(detail)}</small></a>`)
    .join('');
  const triageRows = workItems
    .slice(0, 8)
    .map((item) => {
      const target = adminWorkTarget(item);
      const actionHref = target.href || '/admin/work';
      return `<tr>
        <td data-label="업무"><strong>${escapeHtml(adminWorkTypeLabel(String(item.work_type ?? '')))}</strong><small>${escapeHtml(priorityLabel(item.priority))}</small></td>
        <td data-label="대상">${escapeHtml(target.label)}${target.detail ? `<small>${escapeHtml(target.detail)}</small>` : ''}</td>
        <td data-label="상태">${escapeHtml(genericStatusLabel(String(item.status ?? 'open')))}</td>
        <td data-label="갱신">${escapeHtml(formatDateTime(item.updated_at ?? item.created_at, ''))}</td>
        <td data-label="처리"><a class="button ghost" href="${escapeHtml(actionHref)}">${target.href ? '열기' : '업무 큐'}</a></td>
      </tr>`;
    })
    .join('');
  const feedbackRows = (rows.feedback ?? [])
    .map(
      (item: any) => `<tr>
        <td data-label="제목"><strong>${escapeHtml(item.title ?? '')}</strong><small>${escapeHtml(feedbackTypeLabel(item.feedback_type))}</small></td>
        <td data-label="상태">${escapeHtml(genericStatusLabel(String(item.status ?? 'open')))}</td>
        <td data-label="내용">${escapeHtml(item.body ?? '')}</td>
        <td data-label="처리">
          <form class="inline-form" method="post" action="/admin/feedback/${escapeHtml(String(item.id))}">
            <select name="status">${['open', 'reviewing', 'done', 'wontfix'].map((status) => option(status, item.status, genericStatusLabel(status))).join('')}</select>
            <button>저장</button>
          </form>
        </td>
      </tr>`
    )
    .join('');
  return layout(
    '관리',
    `<main class="admin">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>관리</h1>
          <p>신고, 사용자, 검색, 파일, 릴리즈 준비 상태를 한 곳에서 확인합니다.</p>
        </div>
        <div class="quick-actions">
          <a class="button" href="/admin/work">관리자 업무 큐</a>
          <a class="button ghost" href="/admin/reports">신고 관리</a>
          <a class="button ghost" href="/admin/release">공개 준비</a>
          <a class="button ghost" href="/admin/search">검색 운영</a>
          <a class="button ghost" href="/admin/files">파일 관리</a>
          <a class="button ghost" href="/admin/publication">공개 운영</a>
          <a class="button ghost" href="/admin/mod-verification">모드 검증</a>
          <a class="button ghost" href="/admin/audits">감사 허브</a>
          <a class="button ghost" href="/admin/identity">사용자/권한</a>
          <a class="button ghost" href="/admin/filters">편집 필터</a>
          <a class="button ghost" href="/admin/jobs">작업 큐</a>
          <a class="button ghost" href="/admin/imports">이전 작업</a>
          <a class="button ghost" href="/admin/subwikis">서브위키</a>
          <a class="button ghost" href="/admin/project-boards">프로젝트 보드</a>
          <a class="button" href="/admin/export/backup">전체 백업 파일</a>
          <a class="button ghost" href="/admin/export/manifest">백업 매니페스트</a>
        </div>
      </section>
      <section class="operator-summary">${dashboardCards}</section>
      <section class="doc-status">
        <strong>운영 기준</strong>
        <span>긴급 업무, 열린 신고, 사용자 피드백을 먼저 확인한 뒤 검색·파일·릴리즈 같은 전문 화면으로 이동합니다.</span>
      </section>
      <section class="admin-panel">
        <h2>오늘 처리할 일</h2>
        ${componentTableMarkup(`<thead><tr><th>업무</th><th>대상</th><th>상태</th><th>갱신</th><th>처리</th></tr></thead><tbody>${triageRows || emptyTableRow(5, '오늘 처리할 운영 업무 없음', '신고, 검토, 인증, 파일 문제는 발생하면 이 목록에 우선순위와 함께 표시됩니다.', '/admin/work', '업무 큐 보기')}</tbody>`, 'admin-summary-table')}
      </section>
      <section class="admin-grid">
        ${table('관리자 업무', workItems)}
        ${table('신고', reports, 'reports')}
        ${table('사용자', users, 'users')}
        ${table('관리 로그', logs)}
      </section>
      <section class="admin-panel" id="feedback">
        <h2>사용자 피드백</h2>
        ${componentTableMarkup(`<thead><tr><th>제목</th><th>상태</th><th>내용</th><th>처리</th></tr></thead><tbody>${feedbackRows || emptyTableRow(4, '열린 사용자 피드백 없음', '베타 화면에서 들어온 피드백은 상태와 처리 버튼과 함께 이곳에 표시됩니다.', '/admin/work', '업무 큐 보기')}</tbody>`, 'admin-feedback-table')}
      </section>
    </main>`,
    user,
    'admin'
  );
}

export function adminReportsPage(rows: any[], user: CurrentUser | null) {
  const openCount = rows.filter((row) => String(row.status ?? '') === 'open').length;
  const reviewingCount = rows.filter((row) => String(row.status ?? '') === 'reviewing').length;
  const finalCount = rows.filter((row) => ['resolved', 'rejected'].includes(String(row.status ?? ''))).length;
  const summaryCards = [
    ['열림', openCount, '아직 검토를 시작하지 않은 신고입니다.'],
    ['검토 중', reviewingCount, '담당자가 내용을 확인 중인 신고입니다.'],
    ['처리 완료', finalCount, '해결 또는 반려로 마감된 신고입니다.'],
    ['최근 신고', rows.length, '최근 접수된 신고 목록입니다.']
  ]
    .map(([title, value, detail]) => `<article class="operator-card"><strong>${escapeHtml(String(title))}</strong> <span>${escapeHtml(String(value))}</span> <small>${escapeHtml(String(detail))}</small></article>`)
    .join('');
  const reportRows = rows
    .map((report) => {
      const target = reportTargetHtml(report);
      const reporter = report.reporter_display_name ?? report.reporter_username ?? '익명';
      const handler = report.handler_display_name ?? report.handler_username ?? '';
      return `<tr>
        <td data-label="대상">${target}<small>${escapeHtml(reportTargetTypeLabel(report.target_type))}</small></td>
        <td data-label="사유"><strong>${escapeHtml(reportReasonLabel(report.reason))}</strong><small>${escapeHtml(report.detail ?? '')}</small></td>
        <td data-label="상태">${escapeHtml(reportStatusLabel(report.status))}</td>
        <td data-label="신고자">${escapeHtml(reporter)}</td>
        <td data-label="일시">${escapeHtml(formatDateTime(report.created_at))}${handler ? `<small>처리: ${escapeHtml(handler)}</small>` : ''}</td>
        <td data-label="처리">
          <form class="stack-form compact-form" method="post" action="/admin/reports/${escapeHtml(String(report.id))}/resolve">
            <select name="status">
              ${['reviewing', 'resolved', 'rejected'].map((status) => option(status, report.status, reportStatusLabel(status))).join('')}
            </select>
            <input name="note" placeholder="처리 메모">
            <button>저장</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');
  return layout(
    '신고 관리',
    `<main class="admin admin-reports-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>신고 관리</h1>
          <p>문서, 파일, 사용자 신고를 확인하고 검토 중/해결/반려 상태로 처리합니다.</p>
        </div>
        <div class="quick-actions">
          <a class="button ghost" href="/admin">운영자 홈</a>
          <a class="button ghost" href="/admin/work">업무 큐</a>
        </div>
      </section>
      <section class="operator-summary">${summaryCards}</section>
      <section class="admin-guide-panel reports-guide">
        <div>
          <strong>신고 처리 순서</strong>
          <p>신고는 사용자에게 직접 영향을 주는 운영 판단입니다. 대상 문서나 파일을 먼저 확인하고, 필요한 조치를 끝낸 뒤 처리 메모와 함께 상태를 남깁니다.</p>
        </div>
        <ol>
          <li><strong>접수 확인</strong><span>열림 상태의 신고에서 대상, 사유, 신고자, 상세 내용을 먼저 확인합니다.</span></li>
          <li><strong>대상 검토</strong><span>문서, 파일, 사용자 화면을 열어 실제 위반 여부와 필요한 조치를 확인합니다.</span></li>
          <li><strong>상태 마감</strong><span>처리 중이면 검토 중, 조치가 끝나면 해결, 신고가 맞지 않으면 반려로 기록합니다.</span></li>
        </ol>
      </section>
      <section class="admin-panel">
        <h2>신고 목록</h2>
        ${componentTableMarkup(`<thead><tr><th>대상</th><th>사유</th><th>상태</th><th>신고자</th><th>일시</th><th>처리</th></tr></thead><tbody>${reportRows || emptyTableRow(6, '신고 없음', '문서나 파일 신고가 들어오면 이 화면에서 처리합니다.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function reportTargetHtml(report: any) {
  const namespace = String(report.namespace_code ?? '').trim();
  const title = String(report.page_title ?? '').trim();
  const display = String(report.page_display_title ?? '').trim();
  if (namespace && title) return `<a href="${wikiUrl(namespace as NamespaceCode, title)}">${escapeHtml(publicDocumentTitle(namespace, title, display))}</a>`;
  if (report.page_id) return '문서 지정됨';
  if (report.target_id) return `${escapeHtml(reportTargetTypeLabel(report.target_type))} 지정됨`;
  return '대상 미지정';
}

function reportStatusLabel(value: unknown) {
  const labels: Record<string, string> = {
    open: '열림',
    reviewing: '검토 중',
    resolved: '해결',
    rejected: '반려'
  };
  const key = String(value ?? 'open');
  return labels[key] ?? genericStatusLabel(key);
}

function reportReasonLabel(value: unknown) {
  const labels: Record<string, string> = {
    spam: '스팸',
    vandalism: '훼손',
    copyright: '저작권',
    harassment: '괴롭힘',
    privacy: '개인정보',
    misinformation: '잘못된 정보',
    content: '문서 내용',
    file_license: '파일 라이선스',
    duplicate: '중복 신고',
    abuse: '악용',
    license: '라이선스',
    other: '기타'
  };
  const key = String(value ?? '');
  return labels[key] ?? (key ? key.replace(/_/g, ' ') : '사유 없음');
}

function reportTargetTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    page: '문서',
    revision: '판',
    file: '파일',
    user: '사용자',
    comment: '댓글',
    discussion: '토론',
    report: '신고'
  };
  const key = String(value ?? '');
  return labels[key] ?? targetTypeLabel(key);
}

export function adminPublicationPage(data: Record<string, any>, user: CurrentUser | null) {
  const announcements = data.announcements ?? [];
  const releases = data.releaseNotes ?? [];
  const incidents = data.incidents ?? [];
  const campaigns = data.campaigns ?? [];
  const slaRules = data.reportSlaRules ?? [];
  const policyVersions = data.policyVersions ?? [];
  const settings = data.settings ?? {};
  const activeIncidents = incidents.filter((row: any) => !['resolved', 'postmortem'].includes(String(row.status ?? ''))).length;
  const activeCampaigns = campaigns.filter((row: any) => ['active', 'paused'].includes(String(row.status ?? ''))).length;
  const summaryCards = [
    ['공지', announcements.length, '상단 공지와 정책 안내입니다.'],
    ['릴리즈', releases.length, '기능 변경과 운영 변경 기록입니다.'],
    ['장애/점검', activeIncidents, '현재 공개 상태 알림입니다.'],
    ['캠페인', activeCampaigns, '작성/정비 캠페인입니다.'],
    ['SLA', slaRules.length, '신고 우선순위 기준입니다.'],
    ['정책 버전', policyVersions.length, '시행 중인 정책 문서 버전입니다.']
  ].map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`).join('');
  const announcementRows = announcements.slice(0, 12).map((row: any) => `<tr>
    <td data-label="제목"><strong>${escapeHtml(row.title ?? '')}</strong><small>${escapeHtml(row.body ?? '')}</small></td>
    <td data-label="유형">${escapeHtml(publicTypeLabel(row.type))}</td>
    <td data-label="공개">${escapeHtml(visibilityLabel(row.visibility))}</td>
    <td data-label="기간">${escapeHtml(periodLabel(row.starts_at, row.ends_at))}</td>
  </tr>`).join('');
  const releaseRows = releases.slice(0, 12).map((row: any) => `<tr>
    <td data-label="버전"><strong>${escapeHtml(row.version ?? '')}</strong><small>${escapeHtml(row.title ?? '')}</small></td>
    <td data-label="유형">${escapeHtml(releaseTypeLabel(row.release_type))}</td>
    <td data-label="공개일">${escapeHtml(formatDateTime(row.published_at, '미정'))}</td>
  </tr>`).join('');
  const incidentRows = incidents.slice(0, 12).map((row: any) => `<tr>
    <td data-label="제목"><strong>${escapeHtml(row.title ?? '')}</strong><small>${escapeHtml(row.summary ?? '')}</small></td>
    <td data-label="유형">${escapeHtml(incidentTypeLabel(row.incident_type))}</td>
    <td data-label="심각도">${escapeHtml(severityLabel(String(row.severity ?? '')))}</td>
    <td data-label="상태">${escapeHtml(genericStatusLabel(String(row.status ?? 'open')))}</td>
  </tr>`).join('');
  const campaignRows = campaigns.slice(0, 12).map((row: any) => `<tr>
    <td data-label="캠페인"><strong>${escapeHtml(row.title ?? '')}</strong><small>${escapeHtml(row.description ?? '')}</small></td>
    <td data-label="유형">${escapeHtml(campaignTypeLabel(row.campaign_type))}</td>
    <td data-label="상태">${escapeHtml(genericStatusLabel(String(row.status ?? 'draft')))}</td>
    <td data-label="기간">${escapeHtml(periodLabel(row.starts_at, row.ends_at))}</td>
  </tr>`).join('');
  const slaRows = slaRules.slice(0, 12).map((row: any) => `<tr>
    <td data-label="사유"><strong>${escapeHtml(row.reason ?? '')}</strong></td>
    <td data-label="우선순위">${escapeHtml(priorityLabel(row.priority))}</td>
    <td data-label="목표">${escapeHtml(String(row.target_minutes ?? 0))}분</td>
    <td data-label="상태">${escapeHtml(row.enabled ? '사용' : '사용 안 함')}</td>
  </tr>`).join('');
  const policyRows = policyVersions.slice(0, 12).map((row: any) => `<tr>
    <td data-label="정책"><strong>${escapeHtml(row.policy_key ?? '')}</strong><small>${adminAuditDocumentLink(row)}</small></td>
    <td data-label="버전">${escapeHtml(row.version ?? '')}</td>
    <td data-label="상태">${escapeHtml(genericStatusLabel(String(row.status ?? 'draft')))}</td>
    <td data-label="시행">${escapeHtml(formatDateTime(row.effective_at, '미정'))}</td>
  </tr>`).join('');
  const settingsSummary = [
    ['가입 방식', signupModeLabel(settings.signup_mode ?? 'closed'), '새 계정을 받을지 정합니다.'],
    ['신규 기여', settings.new_user_review_required ? '검토 후 반영' : '기본 반영', '처음 편집의 공개 방식을 정합니다.'],
    ['편집 제한', `${settings.new_user_edit_limit ?? 10}회`, '신규 사용자의 초기 편집 허용량입니다.'],
    ['외부 링크', `${settings.new_user_external_link_limit ?? 2}개`, '신규 사용자의 외부 링크 허용량입니다.'],
    ['서버 노출', genericStatusLabel(String(settings.server_listing_mode ?? 'verified_or_owner')), '서버 위키가 목록에 보이는 기준입니다.']
  ].map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`).join('');
  return layout(
    '공개 운영',
    `<main class="admin admin-publication-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>공개 운영</h1>
          <p>사용자에게 보이는 공지, 릴리즈, 운영 상태, 가입 기준, 작성 캠페인, 정책 버전을 한 곳에서 관리합니다.</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/announcements">공지 보기</a><a class="button ghost" href="/status">상태 보기</a><a class="button ghost" href="/beta">가입 안내</a><a class="button ghost" href="/admin">관리</a></div>
      </section>
      <section class="audit-summary publication-summary">${summaryCards}</section>
      <section class="admin-guide-panel publication-guide">
        <div>
          <strong>공개 운영 순서</strong>
          <p>사용자가 보는 화면에 바로 반영되는 항목입니다. 짧은 안내는 공지, 장애나 점검은 운영 상태, 기능 변경은 릴리즈 노트, 장기 규칙은 정책 버전으로 남깁니다.</p>
        </div>
        <ol>
          <li><strong>공지/상태</strong><span>오늘 사용자가 알아야 할 점검, 장애, 정책 알림을 먼저 공개합니다.</span></li>
          <li><strong>릴리즈/캠페인</strong><span>기능 변경과 문서 정비 목표를 기록해 사용자 참여 흐름을 만듭니다.</span></li>
          <li><strong>가입/정책 기준</strong><span>가입 방식, 신규 편집 제한, 신고 SLA, 정책 버전을 운영 기준으로 고정합니다.</span></li>
        </ol>
      </section>
      <section class="admin-panel">
        <h2>오픈 베타 기준</h2>
        <div class="audit-summary publication-settings-summary">${settingsSummary}</div>
        <form class="filter-bar publication-settings-form" method="post" action="/admin/publication/settings">
          <label>가입<select name="signupMode">${['closed', 'invite', 'open'].map((item) => option(item, settings.signup_mode, signupModeLabel(item))).join('')}</select></label>
          <label>서버 노출<select name="serverListingMode">${['verified_only', 'verified_or_owner', 'all'].map((item) => option(item, settings.server_listing_mode, genericStatusLabel(item))).join('')}</select></label>
          <label>신규 편집 제한<input name="newUserEditLimit" type="number" min="0" value="${escapeHtml(String(settings.new_user_edit_limit ?? 10))}"></label>
          <label>외부 링크 제한<input name="newUserExternalLinkLimit" type="number" min="0" value="${escapeHtml(String(settings.new_user_external_link_limit ?? 2))}"></label>
          <label class="inline-check"><input type="checkbox" name="newUserReviewRequired" value="1"${settings.new_user_review_required ? ' checked' : ''}> 신규 기여 검토</label>
          <button>기준 저장</button>
        </form>
      </section>
      <section class="admin-grid audit-form-grid">
        <section class="admin-panel">
          <h2>공지 작성</h2>
          <form class="stacked-form" method="post" action="/admin/publication/announcements">
            <label>제목<input name="title" required placeholder="점검 안내"></label>
            <label>유형<select name="type">${['notice', 'maintenance', 'policy', 'release', 'incident', 'campaign'].map((item) => option(item, undefined, publicTypeLabel(item))).join('')}</select></label>
            <label>공개 범위<select name="visibility">${['public', 'logged_in', 'staff'].map((item) => option(item, undefined, visibilityLabel(item))).join('')}</select></label>
            <label>본문<textarea name="body" rows="4" required></textarea></label>
            <button>공지 게시</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>릴리즈 노트 작성</h2>
          <form class="stacked-form" method="post" action="/admin/publication/release-notes">
            <label>버전<input name="version" required placeholder="2026.05.25"></label>
            <label>제목<input name="title" required placeholder="검색 개선"></label>
            <label>유형<select name="releaseType">${['feature', 'fix', 'policy', 'security', 'content'].map((item) => option(item, undefined, releaseTypeLabel(item))).join('')}</select></label>
            <label>본문<textarea name="body" rows="4" required></textarea></label>
            <button>릴리즈 게시</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>장애/점검 등록</h2>
          <form class="stacked-form" method="post" action="/admin/publication/incidents">
            <label>제목<input name="title" required placeholder="검색 지연"></label>
            <label>유형<select name="incidentType">${['availability', 'search', 'permission', 'security', 'data', 'editor', 'server_claim', 'file', 'other'].map((item) => option(item, undefined, incidentTypeLabel(item))).join('')}</select></label>
            <label>심각도<select name="severity">${['minor', 'major', 'critical'].map((item) => option(item, undefined, severityLabel(item))).join('')}</select></label>
            <label>상태<select name="status">${['investigating', 'identified', 'resolved', 'postmortem'].map((item) => option(item, undefined, genericStatusLabel(item))).join('')}</select></label>
            <label>요약<textarea name="summary" rows="3"></textarea></label>
            <button>상태 등록</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>캠페인 만들기</h2>
          <form class="stacked-form" method="post" action="/admin/publication/campaigns">
            <label>제목<input name="title" required placeholder="레드스톤 문서 정비"></label>
            <label>유형<select name="campaignType">${['vanilla', 'mod', 'server', 'guide', 'policy', 'search', 'cleanup'].map((item) => option(item, undefined, campaignTypeLabel(item))).join('')}</select></label>
            <label>상태<select name="status">${['draft', 'active', 'paused', 'completed', 'archived'].map((item) => option(item, undefined, genericStatusLabel(item))).join('')}</select></label>
            <label>설명<textarea name="description" rows="3"></textarea></label>
            <button>캠페인 생성</button>
          </form>
        </section>
      </section>
      <section class="admin-grid">
        <section class="admin-panel"><h2>공지</h2>${componentTableMarkup(`<thead><tr><th>제목</th><th>유형</th><th>공개</th><th>기간</th></tr></thead><tbody>${announcementRows || emptyTableRow(4, '공지 없음', '새 공지를 작성하면 공개 공지 페이지에 표시됩니다.')}</tbody>`)}</section>
        <section class="admin-panel"><h2>릴리즈 노트</h2>${componentTableMarkup(`<thead><tr><th>버전</th><th>유형</th><th>공개일</th></tr></thead><tbody>${releaseRows || emptyTableRow(3, '릴리즈 노트 없음', '기능 변경과 운영 변경을 버전별로 기록하세요.')}</tbody>`)}</section>
        <section class="admin-panel"><h2>장애/점검</h2>${componentTableMarkup(`<thead><tr><th>제목</th><th>유형</th><th>심각도</th><th>상태</th></tr></thead><tbody>${incidentRows || emptyTableRow(4, '상태 알림 없음', '장애나 점검이 생기면 이곳에서 공개 상태 페이지로 등록하세요.')}</tbody>`)}</section>
        <section class="admin-panel"><h2>캠페인</h2>${componentTableMarkup(`<thead><tr><th>캠페인</th><th>유형</th><th>상태</th><th>기간</th></tr></thead><tbody>${campaignRows || emptyTableRow(4, '캠페인 없음', '문서 작성이나 정비 캠페인을 만들면 사용자가 참여할 수 있습니다.')}</tbody>`)}</section>
      </section>
      <section class="admin-grid">
        <section class="admin-panel">
          <h2>신고 SLA 기준</h2>
          <form class="filter-bar" method="post" action="/admin/publication/report-sla">
            <input name="reason" placeholder="신고 사유" required>
            <select name="priority">${['low', 'normal', 'high', 'urgent'].map((item) => option(item, undefined, priorityLabel(item))).join('')}</select>
            <input name="targetMinutes" type="number" min="1" value="1440" aria-label="목표 분">
            <label class="inline-check"><input type="checkbox" name="enabled" value="1" checked> 사용</label>
            <button>기준 저장</button>
          </form>
          ${componentTableMarkup(`<thead><tr><th>사유</th><th>우선순위</th><th>목표</th><th>상태</th></tr></thead><tbody>${slaRows || emptyTableRow(4, 'SLA 기준 없음', '신고 사유별 우선순위와 목표 시간을 등록하세요.')}</tbody>`)}
        </section>
        <section class="admin-panel">
          <h2>정책 버전</h2>
          <form class="filter-bar" method="post" action="/admin/publication/policy-versions">
            <input name="pageRef" placeholder="정책 문서 제목 또는 번호" required>
            <input name="policyKey" placeholder="policy_key" required>
            <input name="version" placeholder="1.0" required>
            <select name="status">${['draft', 'beta', 'active', 'deprecated'].map((item) => option(item, undefined, genericStatusLabel(item))).join('')}</select>
            <button>버전 저장</button>
          </form>
          ${componentTableMarkup(`<thead><tr><th>정책</th><th>버전</th><th>상태</th><th>시행</th></tr></thead><tbody>${policyRows || emptyTableRow(4, '정책 버전 없음', '공개 정책 문서의 버전과 시행 상태를 등록하세요.')}</tbody>`)}
        </section>
      </section>
    </main>`,
    user,
    'admin'
  );
}

function signupModeLabel(value: unknown) {
  const labels: Record<string, string> = {
    closed: '가입 닫힘',
    invite: '초대 가입',
    open: '가입 열림'
  };
  return labels[String(value ?? '')] ?? String(value ?? '가입');
}

function campaignTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    vanilla: '바닐라',
    mod: '모드',
    server: '서버',
    guide: '가이드',
    policy: '정책',
    search: '검색',
    cleanup: '정비'
  };
  return labels[String(value ?? '')] ?? String(value ?? '캠페인');
}

export function adminEditFiltersPage(filters: any[], user: CurrentUser | null) {
  const activeCount = filters.filter((row) => row.enabled).length;
  const reviewCount = filters.filter((row) => row.enabled && String(row.action ?? '') === 'require_review').length;
  const blockCount = filters.filter((row) => row.enabled && String(row.action ?? '') === 'block_save').length;
  const hitCount = filters.reduce((sum, row) => sum + Number(row.hit_count ?? 0), 0);
  const summaryCards = [
    ['활성 필터', activeCount, '저장 시 바로 검사되는 규칙입니다.'],
    ['검토 전환', reviewCount, '편집을 검토 큐로 보내는 규칙입니다.'],
    ['저장 차단', blockCount, '명확한 위험 편집을 막는 규칙입니다.'],
    ['누적 감지', hitCount, '필터가 감지한 편집 기록입니다.']
  ].map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`).join('');
  const rows = filters.slice(0, 60).map((row) => `<tr>
    <td data-label="필터">
      <strong>${escapeHtml(row.name ?? '')}</strong>
      <small>${escapeHtml(row.description ?? '설명 없음')}</small>
    </td>
    <td data-label="종류">${escapeHtml(editFilterTypeLabel(row.filter_type))}</td>
    <td data-label="처리">${escapeHtml(editFilterActionLabel(row.action))}</td>
    <td data-label="상태">${escapeHtml(row.enabled ? '사용' : '사용 안 함')}</td>
    <td data-label="감지">${escapeHtml(String(row.hit_count ?? 0))}건</td>
    <td data-label="수정">
      <form class="stacked-form compact-form" method="post" action="/admin/filters/${escapeHtml(String(row.id))}">
        <label>이름<input name="name" value="${escapeHtml(row.name ?? '')}" required></label>
        <label>설명<input name="description" value="${escapeHtml(row.description ?? '')}"></label>
        <label>종류<select name="filterType">${['keyword', 'regex', 'link_count', 'namespace_rule', 'component_rule'].map((item) => option(item, row.filter_type, editFilterTypeLabel(item))).join('')}</select></label>
        <label>패턴<textarea name="pattern" rows="2">${escapeHtml(row.pattern ?? '')}</textarea></label>
        <label>처리<select name="action">${['warn', 'tag', 'require_review', 'block_save'].map((item) => option(item, row.action, editFilterActionLabel(item))).join('')}</select></label>
        <label class="inline-check"><input type="checkbox" name="enabled" value="1"${row.enabled ? ' checked' : ''}> 사용</label>
        <button>필터 저장</button>
      </form>
    </td>
  </tr>`).join('');
  return layout(
    '편집 필터',
    `<main class="admin admin-filters-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>편집 필터</h1>
          <p>스팸, 과도한 외부 링크, 특정 이름공간 규칙을 저장 전에 감지하고 경고·검토·차단으로 연결합니다.</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/admin/work">검토 큐</a><a class="button ghost" href="/admin/audits">감사 허브</a><a class="button ghost" href="/admin">관리</a></div>
      </section>
      <section class="audit-summary filter-summary">${summaryCards}</section>
      <section class="admin-guide-panel filter-guide">
        <div>
          <strong>필터 처리 단계</strong>
          <p>편집 필터는 저장 전 사용자 행동을 바꾸는 규칙입니다. 차단은 복구 비용이 큰 명백한 위험 편집에만 쓰고, 애매한 경우는 검토 요청으로 남깁니다.</p>
        </div>
        <ol>
          <li><strong>경고/태그</strong><span>문제 가능성을 알리거나 기록만 남깁니다. 정상 편집을 막지 않습니다.</span></li>
          <li><strong>검토 요청</strong><span>저장은 막지 않고 공개 전 검토 큐로 보냅니다. 신규 사용자나 서버 홍보성 문구에 적합합니다.</span></li>
          <li><strong>저장 차단</strong><span>명백한 스팸, 악성 링크, 반복 훼손처럼 즉시 막아야 하는 편집에만 적용합니다.</span></li>
        </ol>
      </section>
      <section class="admin-grid audit-form-grid">
        <section class="admin-panel">
          <h2>필터 만들기</h2>
          <form class="stacked-form" method="post" action="/admin/filters">
            <label>이름<input name="name" required placeholder="명백한 스팸 차단"></label>
            <label>설명<input name="description" placeholder="자동 차단 또는 검토 사유"></label>
            <label>종류<select name="filterType">${['keyword', 'regex', 'link_count', 'namespace_rule', 'component_rule'].map((item) => option(item, undefined, editFilterTypeLabel(item))).join('')}</select></label>
            <label>패턴<textarea name="pattern" rows="3" placeholder="키워드, 정규식, 숫자 기준, 이름공간 코드"></textarea></label>
            <label>처리<select name="action">${['warn', 'tag', 'require_review', 'block_save'].map((item) => option(item, undefined, editFilterActionLabel(item))).join('')}</select></label>
            <label class="inline-check"><input type="checkbox" name="enabled" value="1" checked> 즉시 사용</label>
            <button>필터 추가</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>운영 기준</h2>
          <p>차단은 명백한 스팸에만 쓰고, 애매한 문구나 서버 홍보성 표현은 검토 큐로 보내세요. 신규 사용자 제한은 사용자/권한 화면의 신뢰 등급과 함께 봅니다.</p>
          <div class="quick-actions"><a class="button ghost" href="/admin/identity">사용자/권한</a><a class="button ghost" href="/admin/recent">관리자 최근 바뀜</a></div>
        </section>
      </section>
      <section class="admin-panel">
        <h2>필터 목록</h2>
        ${componentTableMarkup(`<thead><tr><th>필터</th><th>종류</th><th>처리</th><th>상태</th><th>감지</th><th>수정</th></tr></thead><tbody>${rows || emptyTableRow(6, '편집 필터 없음', '새 필터를 추가하면 문서 저장 전에 규칙이 적용됩니다.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function editFilterTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    keyword: '키워드',
    regex: '정규식',
    link_count: '외부 링크 수',
    namespace_rule: '이름공간 규칙',
    component_rule: '컴포넌트 규칙'
  };
  return labels[String(value ?? '')] ?? String(value ?? '필터');
}

function editFilterActionLabel(value: unknown) {
  const labels: Record<string, string> = {
    warn: '경고 표시',
    tag: '태그 기록',
    require_review: '검토 요청',
    block_save: '저장 차단'
  };
  return labels[String(value ?? '')] ?? String(value ?? '처리');
}

export function adminIdentityPage(data: Record<string, any[]>, user: CurrentUser | null) {
  const users = data.users ?? [];
  const serverOwners = data.serverOwners ?? [];
  const aclGroups = data.aclGroups ?? [];
  const aclMembers = data.aclMembers ?? [];
  const blockedCount = users.filter((row: any) => String(row.status ?? '') === 'blocked').length;
  const restrictedCount = users.filter((row: any) => String(row.trust_level ?? '') === 'restricted').length;
  const activeOwnerCount = serverOwners.filter((row: any) => String(row.status ?? '') === 'active').length;
  const summaryCards = [
    ['사용자', users.length, '최근 가입자와 신뢰 상태입니다.'],
    ['차단', blockedCount, '현재 차단된 계정입니다.'],
    ['제한 신뢰', restrictedCount, '추가 검토가 필요한 계정입니다.'],
    ['서버 소유자', activeOwnerCount, '공식 서버 문서 관리 권한입니다.'],
    ['ACL 그룹', aclGroups.length, '문서 ACL에서 재사용하는 그룹입니다.'],
    ['그룹 멤버', aclMembers.length, '활성 사용자, IP, CIDR 멤버입니다.']
  ].map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`).join('');
  const userRows = users.slice(0, 30).map((row: any) => `<tr>
    <td data-label="사용자"><strong>${escapeHtml(row.display_name ?? row.username ?? '')}</strong><small>${escapeHtml(row.username ?? '')}</small></td>
    <td data-label="상태">${escapeHtml(userStatusLabel(row.status))}</td>
    <td data-label="신뢰">${escapeHtml(trustLevelLabel(row.trust_level))}</td>
    <td data-label="그룹">${escapeHtml(userGroupList(row.groups))}</td>
    <td data-label="처리">
      <form class="inline-form" method="post" action="/admin/identity/users/${escapeHtml(String(row.id))}/trust">
        <select name="trustLevel">${['new', 'normal', 'autoconfirmed', 'trusted', 'restricted'].map((item) => option(item, row.trust_level, trustLevelLabel(item))).join('')}</select>
        <button>신뢰 저장</button>
      </form>
      ${String(row.status ?? '') === 'blocked'
        ? `<form class="inline-form" method="post" action="/admin/identity/users/${escapeHtml(String(row.id))}/unblock"><input name="reason" placeholder="해제 사유"><button>차단 해제</button></form>`
        : `<form class="inline-form" method="post" action="/admin/identity/users/${escapeHtml(String(row.id))}/block"><input name="reason" placeholder="차단 사유"><button>차단</button></form>`}
    </td>
  </tr>`).join('');
  const ownerRows = serverOwners.slice(0, 30).map((row: any) => `<tr>
    <td data-label="서버"><a href="${wikiUrl('server', row.server_title ?? '')}">${escapeHtml(row.server_title ?? '')}</a></td>
    <td data-label="사용자">${escapeHtml(row.display_name ?? row.username ?? '')}<small>${escapeHtml(row.username ?? '')}</small></td>
    <td data-label="역할">${escapeHtml(roleLabel(row.role))}</td>
    <td data-label="상태">${escapeHtml(genericStatusLabel(String(row.status ?? 'active')))}</td>
    <td data-label="처리">${String(row.status ?? '') !== 'revoked' ? `<form class="inline-form" method="post" action="/admin/identity/server-owners/${escapeHtml(String(row.id))}/revoke"><button>해제</button></form>` : '해제됨'}</td>
  </tr>`).join('');
  const groupRows = aclGroups.slice(0, 30).map((row: any) => `<tr>
    <td data-label="그룹"><strong>${escapeHtml(row.title ?? row.group_key ?? '')}</strong><small>${escapeHtml(row.group_key ?? '')}</small></td>
    <td data-label="설명">${escapeHtml(row.description ?? '')}</td>
    <td data-label="상태">${escapeHtml(genericStatusLabel(String(row.status ?? 'active')))}</td>
    <td data-label="멤버">${escapeHtml(String(row.active_member_count ?? 0))}</td>
    <td data-label="추가">
      <form class="inline-form" method="post" action="/admin/identity/acl-groups/${escapeHtml(String(row.group_key))}/members">
        <select name="memberType"><option value="user">사용자</option><option value="ip">IP</option><option value="cidr">CIDR</option></select>
        <input name="value" placeholder="사용자명, IP, CIDR">
        <select name="expiresIn"><option value="">만료 없음</option><option value="24h">24시간</option><option value="3d">3일</option><option value="7d">7일</option></select>
        <input name="reason" placeholder="사유">
        <button>멤버 추가</button>
      </form>
    </td>
  </tr>`).join('');
  const memberRows = aclMembers.slice(0, 40).map((row: any) => `<tr>
    <td data-label="그룹">${escapeHtml(row.group_title ?? row.group_key ?? '')}<small>${escapeHtml(row.group_key ?? '')}</small></td>
    <td data-label="멤버">${escapeHtml(aclMemberLabel(row))}</td>
    <td data-label="사유">${escapeHtml(row.reason ?? '')}</td>
    <td data-label="만료">${escapeHtml(formatDateTime(row.expires_at, '없음'))}</td>
    <td data-label="처리"><form class="inline-form" method="post" action="/admin/identity/acl-groups/${escapeHtml(String(row.group_key))}/members/${escapeHtml(String(row.id))}/remove"><button>제거</button></form></td>
  </tr>`).join('');
  return layout(
    '사용자/권한',
    `<main class="admin admin-identity-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>사용자/권한</h1>
          <p>계정 신뢰, 차단, 서버 소유자, ACL 그룹 멤버를 위키 운영 흐름 안에서 관리합니다.</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/admin/audits">감사 허브</a><a class="button ghost" href="/admin/work">업무 큐</a><a class="button ghost" href="/admin">관리</a></div>
      </section>
      <section class="audit-summary identity-summary">${summaryCards}</section>
      <section class="admin-guide-panel identity-guide">
        <div>
          <strong>권한 변경 기준</strong>
          <p>계정 신뢰는 편집 반영 범위를 바꾸고, 서버 소유자는 서버 위키 관리 범위를 바꾸며, ACL 그룹은 특정 문서 권한에 직접 영향을 줍니다.</p>
        </div>
        <ol>
          <li><strong>신뢰 등급</strong><span>신규 사용자는 검토 흐름을 우선 적용하고, 반복 기여가 확인되면 자동 인증 또는 신뢰 사용자로 조정합니다.</span></li>
          <li><strong>서버 소유자</strong><span>운영자 인증이나 신청 내역을 확인한 뒤 서버 문서 관리 역할을 부여합니다.</span></li>
          <li><strong>ACL 그룹</strong><span>보호 문서 편집, IP/CIDR 제한처럼 문서 접근에 직접 닿는 권한은 사유와 만료를 남깁니다.</span></li>
        </ol>
      </section>
      <section class="admin-grid audit-form-grid">
        <section class="admin-panel">
          <h2>서버 소유자 부여</h2>
          <form class="stacked-form" method="post" action="/admin/identity/server-owners">
            <label>서버 문서<input name="pageRef" required placeholder="서버 문서 제목 또는 번호"></label>
            <label>사용자<input name="userRef" required placeholder="사용자명 또는 번호"></label>
            <label>역할<select name="role">${['owner', 'manager', 'editor'].map((item) => option(item, undefined, roleLabel(item))).join('')}</select></label>
            <label>상태<select name="status">${['active', 'pending'].map((item) => option(item, undefined, genericStatusLabel(item))).join('')}</select></label>
            <button>소유자 저장</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>사용자 찾기</h2>
          <p>최근 가입자, 차단 계정, 신뢰 등급을 표에서 바로 조정합니다. 사용자 문서와 공개 기여는 각 사용자 링크에서 확인합니다.</p>
          <div class="quick-actions"><a class="button ghost" href="/admin/recent">관리자 최근 바뀜</a><a class="button ghost" href="/special/revision-search">리비전 검색</a></div>
        </section>
      </section>
      <section class="admin-panel">
        <h2>사용자 신뢰와 차단</h2>
        ${componentTableMarkup(`<thead><tr><th>사용자</th><th>상태</th><th>신뢰</th><th>그룹</th><th>처리</th></tr></thead><tbody>${userRows || emptyTableRow(5, '사용자 없음', '최근 가입자와 신뢰 평가는 이곳에 표시됩니다.')}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>서버 소유자</h2>
        ${componentTableMarkup(`<thead><tr><th>서버</th><th>사용자</th><th>역할</th><th>상태</th><th>처리</th></tr></thead><tbody>${ownerRows || emptyTableRow(5, '서버 소유자 없음', '서버 공식 위키 소유자를 위 폼에서 부여하세요.')}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>ACL 그룹</h2>
        ${componentTableMarkup(`<thead><tr><th>그룹</th><th>설명</th><th>상태</th><th>멤버</th><th>추가</th></tr></thead><tbody>${groupRows || emptyTableRow(5, 'ACL 그룹 없음', '문서 ACL에서 재사용할 그룹이 생성되면 이곳에 표시됩니다.')}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>ACL 그룹 멤버</h2>
        ${componentTableMarkup(`<thead><tr><th>그룹</th><th>멤버</th><th>사유</th><th>만료</th><th>처리</th></tr></thead><tbody>${memberRows || emptyTableRow(5, '활성 멤버 없음', '그룹별 사용자, IP, CIDR 멤버를 추가하면 여기에 표시됩니다.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function userStatusLabel(value: unknown) {
  const labels: Record<string, string> = {
    active: '활성',
    pending: '대기',
    blocked: '차단',
    disabled: '사용 안 함'
  };
  return labels[String(value ?? '')] ?? String(value ?? '알 수 없음');
}

function userGroupList(value: unknown) {
  const groups = String(value ?? '').split(',').map((item) => item.trim()).filter(Boolean);
  return groups.length ? groups.map((group) => roleLabel(group)).join(', ') : '일반 사용자';
}

function aclMemberLabel(row: any) {
  if (row.member_type === 'user') return `사용자 · ${row.display_name ?? row.username ?? row.user_id ?? ''}`;
  if (row.member_type === 'ip') return `IP · ${row.ip_text ?? ''}`;
  if (row.member_type === 'cidr') return `CIDR · ${row.cidr ?? ''}`;
  return String(row.member_type ?? '');
}

export function adminAuditHubPage(data: Record<string, any[]>, user: CurrentUser | null) {
  const contentAudits = data.contentAudits ?? [];
  const searchAudits = data.searchAudits ?? [];
  const securityTests = data.securityTests ?? [];
  const permissionAudits = data.permissionAudits ?? [];
  const performanceChecks = data.performanceChecks ?? [];
  const trustRows = data.userTrust ?? [];
  const needsWork = [
    ...contentAudits.filter((row) => ['failed', 'needs_fix', 'pending'].includes(String(row.status ?? ''))),
    ...searchAudits.filter((row) => ['pending', 'needs_alias', 'needs_page', 'bad_ranking'].includes(String(row.status ?? ''))),
    ...securityTests.filter((row) => ['failed', 'pending', 'blocked'].includes(String(row.status ?? ''))),
    ...permissionAudits.filter((row) => ['failed', 'pending'].includes(String(row.status ?? ''))),
    ...performanceChecks.filter((row) => ['failed', 'needs_work', 'pending'].includes(String(row.status ?? '')))
  ].length;
  const summaryCards = [
    ['처리 필요', needsWork, '실패, 대기, 보강 필요 항목입니다.'],
    ['본문 감사', contentAudits.length, '문서 품질과 정책 점검입니다.'],
    ['검색 감사', searchAudits.length, '대표 검색어와 기대 문서 연결입니다.'],
    ['보안/권한', securityTests.length + permissionAudits.length, '보안 테스트와 ACL 기대 결과입니다.'],
    ['성능', performanceChecks.length, '검색, 목록, 공개 화면 성능 점검입니다.'],
    ['사용자 신뢰', trustRows.length, '제한 또는 승급 검토 대상입니다.']
  ]
    .map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`)
    .join('');
  const contentRows = contentAudits
    .slice(0, 20)
    .map((row) => `<tr>
      <td data-label="문서">${adminAuditDocumentLink(row)}</td>
      <td data-label="유형">${escapeHtml(releaseAuditTypeLabel(row.audit_type))}</td>
      <td data-label="상태">${escapeHtml(genericStatusLabel(String(row.status ?? 'pending')))}</td>
      <td data-label="메모">${escapeHtml(row.note ?? '')}</td>
    </tr>`)
    .join('');
  const searchRows = searchAudits
    .slice(0, 20)
    .map((row) => `<tr>
      <td data-label="검색어"><strong>${escapeHtml(row.query ?? '')}</strong></td>
      <td data-label="상태">${escapeHtml(genericStatusLabel(String(row.status ?? 'pending')))}</td>
      <td data-label="기대 문서">${adminAuditDocumentLink(row, 'expected')}</td>
      <td data-label="메모">${escapeHtml(row.note ?? '')}</td>
    </tr>`)
    .join('');
  const securityRows = [...securityTests, ...permissionAudits]
    .slice(0, 20)
    .map((row) => `<tr>
      <td data-label="키"><strong>${escapeHtml(row.test_key ?? row.audit_key ?? '')}</strong></td>
      <td data-label="영역">${escapeHtml(releaseCheckLabel(row.category ?? row.target_type ?? 'security'))}</td>
      <td data-label="상태">${escapeHtml(genericStatusLabel(String(row.status ?? 'pending')))}</td>
      <td data-label="메모">${escapeHtml(row.note ?? '')}</td>
    </tr>`)
    .join('');
  const performanceRows = performanceChecks
    .slice(0, 20)
    .map((row) => `<tr>
      <td data-label="키"><strong>${escapeHtml(row.check_key ?? '')}</strong></td>
      <td data-label="영역">${escapeHtml(releaseTargetAreaLabel(row.target_area))}</td>
      <td data-label="상태">${escapeHtml(genericStatusLabel(String(row.status ?? 'pending')))}</td>
      <td data-label="메모">${escapeHtml(row.note ?? '')}</td>
    </tr>`)
    .join('');
  const trustTableRows = trustRows
    .slice(0, 20)
    .map((row) => `<tr>
      <td data-label="사용자"><strong>${escapeHtml(row.display_name ?? row.username ?? '')}</strong><small>${escapeHtml(row.username ?? '')}</small></td>
      <td data-label="신뢰">${escapeHtml(trustLevelLabel(row.trust_level))}</td>
      <td data-label="좋은 편집">${escapeHtml(String(row.good_edits ?? 0))}</td>
      <td data-label="신고">${escapeHtml(String(row.reports_received ?? 0))}</td>
      <td data-label="처리"><form class="inline-form" method="post" action="/admin/audits/user-trust/${escapeHtml(String(row.id))}/evaluate"><button>재평가</button></form></td>
    </tr>`)
    .join('');
  return layout(
    '감사 허브',
    `<main class="admin admin-audit-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>감사 허브</h1>
          <p>본문 품질, 검색 품질, 보안, 권한, 성능, 사용자 신뢰 점검을 HTML 화면에서 바로 기록합니다.</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/admin/release">공개 준비</a><a class="button ghost" href="/admin/work">업무 큐</a><a class="button ghost" href="/admin">관리</a></div>
      </section>
      <section class="audit-summary">${summaryCards}</section>
      <section class="admin-grid audit-form-grid">
        <section class="admin-panel">
          <h2>본문 감사 기록</h2>
          <form class="stacked-form" method="post" action="/admin/audits/content">
            <label>문서<input name="pageRef" placeholder="문서 제목 또는 번호" required></label>
            <label>유형<select name="auditType">${['style', 'accuracy', 'structure', 'policy', 'source', 'search'].map((item) => option(item, undefined, releaseAuditTypeLabel(item))).join('')}</select></label>
            <label>상태<select name="status">${['pending', 'needs_fix', 'failed', 'passed'].map((item) => option(item, undefined, genericStatusLabel(item))).join('')}</select></label>
            <label>메모<textarea name="note" rows="3" placeholder="보강할 내용이나 통과 근거"></textarea></label>
            <button>감사 저장</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>검색 감사 기록</h2>
          <form class="stacked-form" method="post" action="/admin/audits/search">
            <label>검색어<input name="query" placeholder="예: 페이퍼, Create 기어박스" required></label>
            <label>기대 문서<input name="expectedPageRef" placeholder="문서 제목 또는 번호"></label>
            <label>메모<textarea name="note" rows="3" placeholder="기대 결과와 실제 결과 차이"></textarea></label>
            <button>검색 감사 실행</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>보안/권한 점검</h2>
          <form class="stacked-form" method="post" action="/admin/audits/security">
            <label>테스트 키<input name="testKey" placeholder="예: xss-editor-preview" required></label>
            <label>심각도<select name="severity">${['low', 'medium', 'high', 'critical'].map((item) => option(item, undefined, severityLabel(item))).join('')}</select></label>
            <label>상태<select name="status">${['pending', 'passed', 'failed'].map((item) => option(item, undefined, genericStatusLabel(item))).join('')}</select></label>
            <label>메모<textarea name="note" rows="3" placeholder="실행 결과와 근거"></textarea></label>
            <button>보안 점검 저장</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>성능 점검</h2>
          <form class="stacked-form" method="post" action="/admin/audits/performance">
            <label>체크 키<input name="checkKey" placeholder="예: mobile-recent-overflow" required></label>
            <label>영역<select name="targetArea">${['page', 'search', 'recent_changes', 'category', 'server_list', 'mod_list', 'admin', 'edit', 'job'].map((item) => option(item, undefined, releaseTargetAreaLabel(item))).join('')}</select></label>
            <label>상태<select name="status">${['pending', 'needs_work', 'failed', 'passed'].map((item) => option(item, undefined, genericStatusLabel(item))).join('')}</select></label>
            <label>메모<textarea name="note" rows="3" placeholder="측정 조건과 결과"></textarea></label>
            <button>성능 점검 저장</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>일관성 점검 실행</h2>
          <form class="stacked-form" method="post" action="/admin/audits/consistency">
            <p>검색 색인, 렌더 캐시, 링크, 분류, 서버 보호 상태처럼 자동 점검 가능한 항목을 다시 검사합니다.</p>
            <label class="inline-check"><input type="checkbox" name="autoFix" value="1"> 가능한 항목 자동 보정</label>
            <button>일관성 점검 실행</button>
          </form>
        </section>
      </section>
      <section class="admin-grid">
        <section class="admin-panel"><h2>본문 감사</h2>${componentTableMarkup(`<thead><tr><th>문서</th><th>유형</th><th>상태</th><th>메모</th></tr></thead><tbody>${contentRows || emptyTableRow(4, '본문 감사 기록 없음', '문서별 품질 점검을 위 폼에서 추가하세요.')}</tbody>`)}</section>
        <section class="admin-panel"><h2>검색 감사</h2>${componentTableMarkup(`<thead><tr><th>검색어</th><th>상태</th><th>기대 문서</th><th>메모</th></tr></thead><tbody>${searchRows || emptyTableRow(4, '검색 감사 기록 없음', '대표 검색어를 실행하면 결과 품질과 정비 작업이 남습니다.')}</tbody>`)}</section>
        <section class="admin-panel"><h2>보안/권한</h2>${componentTableMarkup(`<thead><tr><th>키</th><th>영역</th><th>상태</th><th>메모</th></tr></thead><tbody>${securityRows || emptyTableRow(4, '보안/권한 점검 없음', '릴리즈 전 보안 테스트와 권한 기대 결과를 기록하세요.')}</tbody>`)}</section>
        <section class="admin-panel"><h2>성능 점검</h2>${componentTableMarkup(`<thead><tr><th>키</th><th>영역</th><th>상태</th><th>메모</th></tr></thead><tbody>${performanceRows || emptyTableRow(4, '성능 점검 없음', '모바일, 검색, 최근 변경처럼 반복 사용 화면을 측정하세요.')}</tbody>`)}</section>
      </section>
      <section class="admin-panel">
        <h2>사용자 신뢰 재평가</h2>
        ${componentTableMarkup(`<thead><tr><th>사용자</th><th>신뢰</th><th>좋은 편집</th><th>신고</th><th>처리</th></tr></thead><tbody>${trustTableRows || emptyTableRow(5, '재평가 대상 없음', '사용자 활동이 쌓이면 신뢰 수준과 신고 이력이 이곳에 표시됩니다.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function adminAuditDocumentLink(row: any, prefix = '') {
  const namespace = String(row[`${prefix}_namespace_code`] ?? row.namespace_code ?? '');
  const title = String(row[`${prefix}_title`] ?? row.title ?? '').trim();
  const id = row[`${prefix}_page_id`] ?? row.page_id ?? row.expected_page_id;
  if (namespace && title) return `<a href="${wikiUrl(namespace as NamespaceCode, title)}">${escapeHtml(publicDocumentTitle(namespace, title, row.display_title ?? ''))}</a>`;
  if (title) return escapeHtml(title);
  if (id) return `문서 지정됨`;
  return '미지정';
}

function trustLevelLabel(value: unknown) {
  const labels: Record<string, string> = {
    restricted: '제한',
    new: '신규',
    normal: '일반',
    autoconfirmed: '자동 인증',
    trusted: '신뢰'
  };
  const key = String(value ?? 'new');
  return labels[key] ?? key.replace(/_/g, ' ');
}

export function adminBackupManifestPage(manifest: any, user: CurrentUser | null) {
  const includes = manifest?.includes ?? {};
  const documentTotal = Number(includes.pageSources ?? 0) + Number(includes.revisions ?? 0);
  const spaceTotal = Number(includes.wikiSpaces ?? 0) + Number(includes.sidebarItems ?? 0) + Number(includes.subwikiRoles ?? 0) + Number(includes.subwikiSettings ?? 0);
  const operationTotal = Number(includes.searchAliases ?? 0) + Number(includes.serverClaims ?? 0) + Number(includes.gitbookImports ?? 0);
  const fileTotal = Number(includes.files ?? 0);
  const summaryCards = [
    ['문서/판', documentTotal, '문서 본문과 판 이력입니다.'],
    ['파일', fileTotal, '업로드 파일과 라이선스 확인 대상입니다.'],
    ['위키 구조', spaceTotal, '서브위키, 사이드바, 역할, 설정입니다.'],
    ['운영 기록', operationTotal, '검색 별칭, 서버 인증, 이전 작업 기록입니다.']
  ]
    .map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`)
    .join('');
  const rows = [
    ['문서', includes.pageSources],
    ['판', includes.revisions],
    ['파일', includes.files],
    ['위키 공간', includes.wikiSpaces],
    ['사이드바 항목', includes.sidebarItems],
    ['위키 역할', includes.subwikiRoles],
    ['검색 별칭', includes.searchAliases],
    ['서버 인증', includes.serverClaims],
    ['위키 설정', includes.subwikiSettings],
    ['이전 작업', includes.gitbookImports]
  ]
    .map(([label, value]) => `<tr><th>${escapeHtml(String(label))}</th><td>${escapeHtml(String(value ?? 0))}</td></tr>`)
    .join('');
  const excluded = Array.isArray(manifest?.excludedRegenerable)
    ? manifest.excludedRegenerable.map((item: string) => tag(exportExclusionLabel(item))).join('')
    : '';
  return layout(
    '백업 매니페스트',
    `<main class="admin admin-backup-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>백업 매니페스트</h1>
          <p>${escapeHtml(formatDateTime(manifest?.generatedAt, '방금 생성'))} 기준 백업 포함 범위를 확인합니다.</p>
        </div>
        <div class="quick-actions">
          <a class="button" href="/admin/export/backup">전체 백업 파일</a>
          <a class="button ghost" href="/admin/export/manifest?download=1">매니페스트 파일</a>
          <a class="button ghost" href="/admin">관리</a>
        </div>
      </section>
      <section class="audit-summary backup-summary">${summaryCards}</section>
      <section class="admin-guide-panel backup-guide">
        <div>
          <strong>백업 확인 순서</strong>
          <p>매니페스트는 백업 파일이 어떤 운영 데이터를 포함하는지 확인하는 복구 기준표입니다. 다운로드 전 포함 범위와 재생성 항목을 함께 확인하세요.</p>
        </div>
        <ol>
          <li><strong>포함 범위 확인</strong><span>문서, 판, 파일, 서브위키 구조가 예상 수량과 맞는지 먼저 봅니다.</span></li>
          <li><strong>재생성 항목 구분</strong><span>검색 색인과 렌더 캐시는 복원 뒤 다시 만들 수 있으므로 백업 크기에서 제외합니다.</span></li>
          <li><strong>파일 보관</strong><span>전체 백업 파일과 매니페스트 파일을 같은 시점 기록으로 함께 보관합니다.</span></li>
        </ol>
      </section>
      <section class="admin-panel">
        <h2>포함 데이터</h2>
        ${componentTableMarkup(`<tbody>${rows}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>재생성 데이터</h2>
        <p>아래 데이터는 백업 파일에 넣지 않고 복원 후 다시 만들 수 있습니다.</p>
        <div class="tag-row">${excluded || tag('없음')}</div>
      </section>
    </main>`,
    user,
    'admin'
  );
}

function exportExclusionLabel(value: string) {
  const labels: Record<string, string> = {
    search_index: '검색 색인',
    page_render_cache: '문서 렌더 캐시'
  };
  return labels[value] ?? value;
}

export function adminReleasePage(data: Record<string, any>, user: CurrentUser | null) {
  const statusRows = (items: any[] = [], labelKey = 'status') =>
    items.map((item) => `<span class="tag">${escapeHtml(releaseStatusLabel(item[labelKey]))}: ${escapeHtml(String(item.count))}</span>`).join('') || '<span class="tag">기록 없음</span>';
  const gates = data.gates ?? [];
  const issues = data.issues ?? [];
  const blockers = data.blockers ?? [];
  const securityChecks = data.securityChecks ?? [];
  const performanceChecks = data.performanceChecks ?? [];
  const releaseRehearsals = data.releaseRehearsals ?? [];
  const openBlockers = blockers.filter((row: any) => !['resolved', 'waived', 'fixed', 'closed'].includes(String(row.status ?? 'open'))).length;
  const openIssues = issues.filter((row: any) => !['fixed', 'wontfix', 'duplicate', 'resolved', 'closed'].includes(String(row.status ?? 'open'))).length;
  const failedChecks = [
    ...gates.filter((row: any) => ['failed'].includes(String(row.status ?? ''))),
    ...securityChecks.filter((row: any) => ['failed', 'blocked'].includes(String(row.status ?? ''))),
    ...performanceChecks.filter((row: any) => ['failed', 'needs_work'].includes(String(row.status ?? ''))),
    ...releaseRehearsals.filter((row: any) => ['failed', 'blocked'].includes(String(row.status ?? '')))
  ].length;
  const releaseSummaryCards = [
    ['공개 판정', data.status?.ready ? '공개 가능' : '차단 항목 있음', data.status?.ready ? '주요 공개 게이트가 통과 상태입니다.' : '블로커, 실패 점검, 미완료 게이트를 먼저 확인하세요.'],
    ['열린 블로커', `${openBlockers}건`, '공개를 막는 항목입니다.'],
    ['열린 이슈', `${openIssues}건`, '공개 전 처리하거나 예외 승인할 항목입니다.'],
    ['실패 점검', `${failedChecks}건`, '게이트, 보안, 성능, 리허설 실패입니다.']
  ]
    .map(([label, value, detail]) => `<span><small>${escapeHtml(label)}</small><strong>${escapeHtml(value)}</strong><small>${escapeHtml(detail)}</small></span>`)
    .join('');
  const gateRows = gates
    .map(
      (gate: any) => `<tr>
        <td><strong>${escapeHtml(gate.title)}</strong><small>${escapeHtml(releaseCheckLabel(gate.gate_key))}</small></td>
        <td>${escapeHtml(releaseGateStatusLabel(gate.status))}</td>
        <td>${escapeHtml(gate.note ?? '')}</td>
        <td>
          <form class="inline-form" method="post" action="/admin/release/gates/${escapeHtml(gate.gate_key)}">
            <select name="status">${['not_started', 'checking', 'passed', 'failed', 'waived'].map((status) => option(status, gate.status, releaseGateStatusLabel(status))).join('')}</select>
            <input name="note" value="${escapeHtml(gate.note ?? '')}" placeholder="점검 메모">
            <button>저장</button>
          </form>
        </td>
      </tr>`
    )
    .join('');
  const issueRows = issues
    .map(
      (issue: any) => `<tr>
        <td><strong>${escapeHtml(issue.title)}</strong><small>${escapeHtml(releaseIssueTypeLabel(issue.issue_type))}</small></td>
        <td>${escapeHtml(severityLabel(String(issue.severity ?? '')))}</td>
        <td>${escapeHtml(releaseIssueStatusLabel(issue.status))}</td>
        <td>${escapeHtml(formatDateTime(issue.updated_at))}</td>
        <td>
          <form class="inline-form" method="post" action="/admin/release/issues/${escapeHtml(String(issue.id))}">
            <select name="status">${['open', 'triaged', 'in_progress', 'fixed', 'wontfix', 'duplicate'].map((status) => option(status, issue.status, releaseIssueStatusLabel(status))).join('')}</select>
            <button>저장</button>
          </form>
        </td>
      </tr>`
    )
    .join('');
  const blockerRows = blockers
    .map(
      (blocker: any) => `<tr>
        <td><strong>${escapeHtml(blocker.title)}</strong><small>${escapeHtml(releaseBlockerTypeLabel(blocker.blocker_type))}</small></td>
        <td>${escapeHtml(severityLabel(String(blocker.severity ?? '')))}</td>
        <td>${escapeHtml(releaseIssueStatusLabel(blocker.status))}</td>
        <td>${escapeHtml(blocker.description ?? '')}</td>
        <td>
          <form class="inline-form" method="post" action="/admin/release/blockers/${escapeHtml(String(blocker.id))}">
            <select name="status">${['open', 'in_progress', 'resolved', 'waived'].map((status) => option(status, blocker.status, releaseIssueStatusLabel(status))).join('')}</select>
            <button>저장</button>
          </form>
        </td>
      </tr>`
    )
    .join('');
  const auditRows = (data.contentAudits ?? [])
    .map((audit: any) => `<tr><td>${escapeHtml(audit.title ?? adminPageRefLabel(audit.page_id))}</td><td>${escapeHtml(releaseAuditTypeLabel(audit.audit_type))}</td><td>${escapeHtml(releaseIssueStatusLabel(audit.status))}</td><td>${escapeHtml(audit.note ?? '')}</td></tr>`)
    .join('');
  const searchAuditRows = (data.searchAudits ?? [])
    .map((audit: any) => `<tr><td>${escapeHtml(audit.query)}</td><td>${escapeHtml(releaseIssueStatusLabel(audit.status))}</td><td>${escapeHtml(releaseExpectedPageLabel(audit))}</td><td>${escapeHtml(audit.note ?? '')}</td></tr>`)
    .join('');
  const securityRows = securityChecks
    .map((check: any) => `<tr><td>${escapeHtml(releaseCheckLabel(check.test_key ?? check.check_key))}</td><td>${escapeHtml(severityLabel(String(check.severity ?? '')))}</td><td>${escapeHtml(releaseIssueStatusLabel(check.status))}</td><td>${escapeHtml(check.note ?? '')}</td></tr>`)
    .join('');
  const performanceRows = performanceChecks
    .map((check: any) => `<tr><td>${escapeHtml(releaseCheckLabel(check.check_key))}</td><td>${escapeHtml(releaseTargetAreaLabel(check.target_area))}</td><td>${escapeHtml(releaseIssueStatusLabel(check.status))}</td><td>${escapeHtml(check.note ?? '')}</td></tr>`)
    .join('');
  const rehearsalTitle: Record<string, string> = {
    signup: '신규 가입',
    edit: '문서 편집',
    edit_filter: '편집 필터',
    pending_review: '검토 큐',
    server_claim: '서버 인증',
    permission_denial: '권한 차단',
    mod_link_review: '모드 링크',
    file_license: '파일 라이선스',
    report: '신고 처리',
    revision_visibility: '리비전 숨김',
    search_alias: '검색 별칭',
    job_retry: '작업 재시도'
  };
  const rehearsalRows = releaseRehearsals
    .map((run: any) => {
      const evidence = typeof run.evidence_json === 'string' ? run.evidence_json : JSON.stringify(run.evidence_json ?? {});
      return `<tr>
        <td><strong>${escapeHtml(rehearsalTitle[run.scenario] ?? run.scenario)}</strong><small>${escapeHtml(run.run_key)}</small></td>
        <td>${escapeHtml(releaseIssueStatusLabel(run.status))}</td>
        <td>${escapeHtml(run.note ?? '')}</td>
        <td>${escapeHtml(formatDateTime(run.run_at))}</td>
        <td>${escapeHtml(evidence && evidence !== '{}' ? '증적 등록됨' : '없음')}</td>
      </tr>`;
    })
    .join('');
  return layout(
    '공개 준비',
    `<main class="admin admin-release-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>공개 준비</h1>
          <p>공개 게이트, 보안 리허설, 성능 점검, 릴리즈 블로커를 관리합니다.</p>
        </div>
        <div class="quick-actions">
          <form class="inline-form" method="post" action="/admin/release/rebuild-gates"><button>자동 게이트 판정</button></form>
          <form class="inline-form" method="post" action="/admin/release/rehearsal/run"><button>최종 리허설 실행</button></form>
          <form class="inline-form" method="post" action="/admin/release/rebuild-weekly"><button>주간 요약 재계산</button></form>
          <form class="inline-form" method="post" action="/admin/release/rebuild-daily"><button>일일 요약 재계산</button></form>
          <form class="inline-form" method="post" action="/admin/release/rebuild-stats"><button>오늘 통계 재계산</button></form>
        </div>
      </section>
      <section class="directory-summary release-summary" aria-label="공개 준비 요약">${releaseSummaryCards}</section>
      <section class="admin-guide-panel release-guide">
        <div>
          <strong>공개 전 점검 순서</strong>
          <p>차단 항목을 먼저 없애고, 게이트 자동 판정과 최종 리허설 증적을 남긴 뒤 공개 상태를 판단합니다.</p>
        </div>
        <ol>
          <li><strong>블로커 확인</strong><span>보안, 권한, 데이터 손실 항목은 공개 전에 해결하거나 예외 승인합니다.</span></li>
          <li><strong>게이트 판정</strong><span>자동 게이트 판정으로 파일, 검색, 성능, 권한 기준을 다시 계산합니다.</span></li>
          <li><strong>리허설 증적</strong><span>가입, 편집, 검색, 신고 처리 같은 실제 운영 흐름을 실행하고 기록합니다.</span></li>
        </ol>
      </section>
      <section class="admin-grid">
        <div class="admin-panel"><h2>준비 상태</h2><p>${data.status?.ready ? '공개 가능' : '차단 항목 있음'}</p><div class="tag-row">${statusRows(data.status?.gates)}${statusRows(data.status?.blockers)}${statusRows(data.status?.performance)}${statusRows(data.status?.rehearsals)}<span class="tag">라이선스 검토 필요: ${escapeHtml(String(data.status?.fileLicenses?.license_needed ?? 0))}</span></div></div>
        <div class="admin-panel"><h2>설정</h2><p>가입: ${escapeHtml(genericStatusLabel(String(data.status?.settings?.signup_mode ?? 'closed')))} · 신규 검토: ${data.status?.settings?.new_user_review_required ? '사용' : '미사용'}</p><p>서버 목록: ${escapeHtml(genericStatusLabel(String(data.status?.settings?.server_listing_mode ?? 'verified_or_owner')))}</p></div>
      </section>
      <section class="admin-panel">
        <h2>릴리즈 게이트</h2>
        ${componentTableMarkup(`<thead><tr><th>항목</th><th>상태</th><th>메모</th><th>처리</th></tr></thead><tbody>${gateRows || emptyTableRow(4, '릴리즈 게이트 없음', '공개 전 확인해야 할 기준을 게이트로 등록하면 여기에서 통과 여부를 관리합니다.')}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>공개 이슈</h2>
        <form class="inline-form" method="post" action="/admin/release/issues">
          <input name="title" placeholder="이슈 제목">
          <select name="issueType">${['bug', 'permission', 'security', 'editor', 'search', 'server_wiki', 'mod_wiki', 'content', 'other'].map((type) => option(type, undefined, releaseIssueTypeLabel(type))).join('')}</select>
          <select name="severity">${['medium', 'high', 'critical', 'low'].map((severity) => option(severity, undefined, severityLabel(severity))).join('')}</select>
          <button>추가</button>
        </form>
        ${componentTableMarkup(`<thead><tr><th>이슈</th><th>심각도</th><th>상태</th><th>수정일</th><th>처리</th></tr></thead><tbody>${issueRows || emptyTableRow(5, '공개 이슈 없음', '공개 전 해결해야 할 버그, 권한, 검색, 콘텐츠 문제를 위 폼에서 추가합니다.')}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>릴리즈 블로커</h2>
        <form class="inline-form" method="post" action="/admin/release/blockers">
          <input name="title" placeholder="블로커 제목">
          <select name="blockerType">${['security', 'permission', 'data_loss', 'search', 'content', 'server_policy', 'mod_policy', 'admin', 'performance', 'other'].map((type) => option(type, undefined, releaseBlockerTypeLabel(type))).join('')}</select>
          <select name="severity">${['high', 'critical'].map((severity) => option(severity, undefined, severityLabel(severity))).join('')}</select>
          <button>추가</button>
        </form>
        ${componentTableMarkup(`<thead><tr><th>블로커</th><th>심각도</th><th>상태</th><th>설명</th><th>처리</th></tr></thead><tbody>${blockerRows || emptyTableRow(5, '릴리즈 블로커 없음', '보안, 권한, 데이터 손실처럼 공개를 막는 항목이 생기면 여기에 등록합니다.')}</tbody>`)}
      </section>
      <section class="admin-grid">
        <div class="admin-panel"><h2>문서 감사</h2>${componentTableMarkup(`<thead><tr><th>문서</th><th>유형</th><th>상태</th><th>메모</th></tr></thead><tbody>${auditRows || emptyTableRow(4, '문서 감사 없음', '공개 전 문서 품질 감사가 실행되면 결과와 메모가 표시됩니다.')}</tbody>`)}</div>
        <div class="admin-panel"><h2>검색 감사</h2>${componentTableMarkup(`<thead><tr><th>검색어</th><th>상태</th><th>기대 문서</th><th>메모</th></tr></thead><tbody>${searchAuditRows || emptyTableRow(4, '검색 감사 없음', '대표 검색어가 기대 문서로 이어지는지 점검한 결과가 표시됩니다.')}</tbody>`)}</div>
      </section>
      <section class="admin-grid">
        <div class="admin-panel"><h2>보안 리허설</h2>${componentTableMarkup(`<thead><tr><th>키</th><th>심각도</th><th>상태</th><th>메모</th></tr></thead><tbody>${securityRows || emptyTableRow(4, '보안 리허설 없음', '권한, CSRF, 숨김 리비전 같은 공개 전 보안 점검 결과가 표시됩니다.')}</tbody>`)}</div>
        <div class="admin-panel"><h2>성능 점검</h2>${componentTableMarkup(`<thead><tr><th>키</th><th>영역</th><th>상태</th><th>메모</th></tr></thead><tbody>${performanceRows || emptyTableRow(4, '성능 점검 없음', '검색, 최근 바뀜, 목록 화면의 공개 전 성능 점검 결과가 표시됩니다.')}</tbody>`)}</div>
      </section>
      <section class="admin-panel">
        <h2>최종 리허설</h2>
        ${componentTableMarkup(`<thead><tr><th>시나리오</th><th>상태</th><th>메모</th><th>실행일</th><th>증적</th></tr></thead><tbody>${rehearsalRows || emptyTableRow(5, '최종 리허설 기록 없음', '공개 전 리허설을 실행하면 시나리오, 결과, 증적이 여기에 남습니다.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function adminPageRefLabel(pageId: unknown) {
  const id = String(pageId ?? '').trim();
  return id ? '문서 지정됨' : '-';
}

function releaseExpectedPageLabel(audit: any) {
  const title = String(audit.expected_title ?? '').trim();
  const displayTitle = String(audit.expected_display_title ?? '').trim();
  if (title || displayTitle) return publicDocumentTitle(audit.expected_namespace_code ?? 'main', title, displayTitle);
  return adminPageRefLabel(audit.expected_page_id);
}

function releaseStatusLabel(value: unknown) {
  return genericStatusLabel(String(value ?? ''));
}

function releaseGateStatusLabel(value: unknown) {
  return genericStatusLabel(String(value ?? 'not_started'));
}

function releaseIssueStatusLabel(value: unknown) {
  return genericStatusLabel(String(value ?? 'open'));
}

function releaseIssueTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    bug: '버그',
    permission: '권한',
    security: '보안',
    editor: '편집기',
    search: '검색',
    server_wiki: '서버 위키',
    mod_wiki: '모드 위키',
    content: '문서',
    other: '기타'
  };
  const key = String(value ?? 'other');
  return labels[key] ?? key.replace(/_/g, ' ');
}

function releaseBlockerTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    security: '보안',
    permission: '권한',
    data_loss: '데이터 손실',
    search: '검색',
    content: '문서',
    server_policy: '서버 정책',
    mod_policy: '모드 정책',
    admin: '관리',
    performance: '성능',
    other: '기타'
  };
  const key = String(value ?? 'other');
  return labels[key] ?? key.replace(/_/g, ' ');
}

function releaseAuditTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    style: '표현',
    accuracy: '정확성',
    structure: '구조',
    source: '출처',
    content: '본문',
    policy: '정책',
    license: '라이선스',
    link: '링크',
    search: '검색',
    quality: '문서 품질'
  };
  const key = String(value ?? '');
  return labels[key] ?? key.replace(/_/g, ' ');
}

function releaseTargetAreaLabel(value: unknown) {
  const labels: Record<string, string> = {
    page: '문서',
    search: '검색',
    editor: '편집기',
    edit: '편집',
    recent_changes: '최근 바뀜',
    category: '분류',
    server_list: '서버 목록',
    mod_list: '모드 목록',
    job: '작업 큐',
    server: '서버',
    mod: '모드',
    admin: '관리',
    public: '공개 화면'
  };
  const key = String(value ?? '');
  return labels[key] ?? key.replace(/_/g, ' ');
}

function releaseCheckLabel(value: unknown) {
  const labels: Record<string, string> = {
    signup: '가입',
    edit: '편집',
    search: '검색',
    permissions: '권한',
    file_license: '파일 라이선스',
    server_claim: '서버 인증',
    mod_link_review: '모드 링크 검토',
    performance: '성능',
    security: '보안'
  };
  const key = String(value ?? '');
  return labels[key] ?? key.replace(/_/g, ' ');
}

export function adminWorkPage(items: any[], assignees: any[], user: CurrentUser | null) {
  const openCount = items.filter((item) => !['done', 'dismissed'].includes(String(item.status ?? 'open'))).length;
  const inProgressCount = items.filter((item) => String(item.status ?? '') === 'in_progress').length;
  const urgentCount = items.filter((item) => String(item.priority ?? '') === 'urgent').length;
  const unassignedCount = items.filter((item) => !item.assigned_to).length;
  const summaryCards = [
    ['열린 업무', openCount, '처리 중이거나 아직 시작하지 않은 운영 업무입니다.'],
    ['진행 중', inProgressCount, '담당자가 잡고 처리하고 있는 업무입니다.'],
    ['긴급', urgentCount, '신고, 인증, 파일 문제 중 먼저 봐야 할 항목입니다.'],
    ['미배정', unassignedCount, '담당자를 지정해야 흐름이 멈추지 않습니다.']
  ].map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`).join('');
  const rows = items
    .map((item) => {
      const target = adminWorkTarget(item);
      return `<tr>
        <td data-label="유형"><strong>${escapeHtml(adminWorkTypeLabel(item.work_type))}</strong></td>
        <td data-label="대상"><strong>${escapeHtml(target.label)}</strong>${target.href ? ` <a class="button ghost" href="${escapeHtml(target.href)}">대상 열기</a>` : ''}<small>${escapeHtml(target.detail)}</small></td>
        <td data-label="우선순위">${escapeHtml(priorityLabel(item.priority))}</td>
        <td data-label="상태">${escapeHtml(genericStatusLabel(String(item.status ?? 'open')))}</td>
        <td data-label="담당자">${escapeHtml(item.assigned_display_name ?? item.assigned_username ?? '미배정')}</td>
        <td data-label="갱신">${escapeHtml(formatDateTime(item.updated_at))}</td>
        <td data-label="처리">
          <form class="inline-form" method="post" action="/admin/work/${escapeHtml(String(item.id))}">
            <select name="assignedTo">
              <option value="">미배정</option>
              ${assignees.map((assignee) => `<option value="${escapeHtml(String(assignee.id))}"${Number(item.assigned_to) === Number(assignee.id) ? ' selected' : ''}>${escapeHtml(assignee.display_name ?? assignee.username)}</option>`).join('')}
            </select>
            <select name="priority">
              ${['urgent', 'high', 'normal', 'low'].map((priority) => option(priority, item.priority, priorityLabel(priority))).join('')}
            </select>
            <select name="status">
              ${['open', 'in_progress', 'done', 'dismissed'].map((status) => option(status, item.status, genericStatusLabel(status))).join('')}
            </select>
            <button>저장</button>
          </form>
        </td>
      </tr>`;
    })
    .join('');
  return layout(
    '관리자 업무 큐',
    `<main class="admin admin-work-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>관리자 업무 큐</h1>
          <p>신고, 검토, 서버 인증, 파일 문제 등 운영 작업을 배정하고 처리합니다.</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/admin/reports">신고</a><a class="button ghost" href="/admin/subwikis">서브위키</a><a class="button ghost" href="/admin/files">파일</a></div>
      </section>
      <section class="audit-summary work-summary">${summaryCards}</section>
      <section class="admin-guide-panel work-guide">
        <div>
          <strong>업무 처리 순서</strong>
          <p>긴급하거나 미배정인 항목부터 담당자를 정하고, 실제 대상 화면을 열어 확인한 뒤 상태를 진행 중 또는 완료로 바꿉니다.</p>
        </div>
        <ol>
          <li><strong>긴급/미배정 확인</strong><span>신고, 서버 인증, 파일 라이선스처럼 사용자에게 영향이 큰 일을 먼저 맡깁니다.</span></li>
          <li><strong>대상 화면 검토</strong><span>대상 열기로 문서, 신청, 파일 화면을 확인하고 필요한 조치를 처리합니다.</span></li>
          <li><strong>상태 정리</strong><span>처리 중이면 진행 중, 끝났으면 완료, 운영 대상이 아니면 기각으로 남깁니다.</span></li>
        </ol>
      </section>
      <section class="admin-panel">
        ${componentTableMarkup(`<thead><tr><th>유형</th><th>대상</th><th>우선순위</th><th>상태</th><th>담당자</th><th>갱신</th><th>처리</th></tr></thead><tbody>${rows || emptyTableRow(7, '열린 관리자 업무 없음', '신고, 검토, 서버 인증, 파일 문제는 발생하면 이 큐에 쌓입니다.', '/admin/recent', '관리자 최근 바뀜')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

export function adminSubwikiRequestPage(requestRow: any, workItem: any, user: CurrentUser | null) {
  const meta = parseRequestNote(requestRow.note);
  const requestId = Number(requestRow.id ?? 0);
  const requestType = subwikiRequestTypeLabel(String(requestRow.request_type ?? 'server'));
  const currentStatus = genericStatusLabel(String(requestRow.status ?? 'pending'));
  const statusDetail = workItem
    ? `${priorityLabel(workItem.priority)} · ${genericStatusLabel(String(workItem.status ?? 'open'))}`
    : '연결된 업무 없음';
  const fieldRows = [
    ['종류', requestType],
    ['제목', requestRow.title],
    ['슬러그', meta.slug],
    ['주소', meta.host],
    ['에디션', meta.edition],
    ['지원 버전', meta.supportedVersions],
    ['장르', meta.genres],
    ['초기 문서', meta.starterSet],
    ['이전 필요', meta.needsImport === 'true' ? '필요' : '없음'],
    ['이전 메모', meta.sourceNote],
    ['신청 메모', meta.note],
    ['신청자', requestRow.requester_display_name ?? requestRow.requester_username ?? requestRow.requested_by],
    ['신청일', formatDateTime(requestRow.created_at)]
  ]
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([label, value]) => `<tr><th>${escapeHtml(String(label))}</th><td>${escapeHtml(String(value))}</td></tr>`)
    .join('');
  const rawStatus = String(requestRow.status ?? '');
  const disabled = rawStatus === 'created' || rawStatus === 'rejected';
  const disabledReason = rawStatus === 'created'
    ? '이미 승인되어 전용 위키가 생성된 신청입니다.'
    : rawStatus === 'rejected'
      ? '이미 반려로 마감된 신청입니다.'
      : '';
  const disabledNoticeId = disabled ? `subwiki-request-${requestId}-completed` : '';
  const disabledButtonAttrs = disabled
    ? ` disabled title="${escapeHtml(disabledReason)}" aria-describedby="${escapeHtml(disabledNoticeId)}"`
    : '';
  const slug = String(meta.slug ?? '').trim();
  const targetHref = subwikiRequestTargetHref(String(requestRow.request_type ?? 'server'), slug);
  const starterDocs = subwikiRequestStarterDocs(String(requestRow.request_type ?? 'server'), meta.starterSet);
  const requestCards = [
    ['생성 경로', targetHref || '슬러그 확인 필요', targetHref ? '승인하면 이 주소의 전용 위키가 생성됩니다.' : '슬러그가 없으면 승인 전 신청 내용을 보완해야 합니다.'],
    ['초기 문서', starterDocs.title, starterDocs.detail],
    ['이전 작업', meta.needsImport === 'true' ? '필요' : '없음', meta.needsImport === 'true' ? (meta.sourceNote || 'GitBook/Markdown 이전 메모를 확인하세요.') : '승인 후 기본 문서부터 바로 편집할 수 있습니다.'],
    ['신청자', String(requestRow.requester_display_name ?? requestRow.requester_username ?? requestRow.requested_by ?? '알 수 없음'), '승인하면 신청자가 기본 관리자로 연결됩니다.']
  ]
    .map(([title, value, detail]) => `<article class="operator-card"><strong>${escapeHtml(title)}</strong> <span>${escapeHtml(value)}</span> <small>${escapeHtml(detail)}</small></article>`)
    .join('');
  return layout(
    `위키 신청 #${requestId}`,
    `<main class="admin">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>${escapeHtml(requestRow.title ?? '위키 신청')}</h1>
          <p>${escapeHtml(currentStatus)} · ${escapeHtml(statusDetail)}</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/admin/work">업무 큐</a></div>
      </section>
      <section class="operator-summary">${requestCards}</section>
      <section class="doc-status">
        <strong>승인 전 확인</strong>
        <span>${escapeHtml(subwikiRequestApprovalHint(String(requestRow.request_type ?? 'server'), slug, meta))}</span>
      </section>
      ${disabled ? `<section class="doc-status official" id="${escapeHtml(disabledNoticeId)}">
        <strong>처리 완료</strong>
        <span>${escapeHtml(disabledReason)} 버튼은 잠겨 있으며, 필요한 경우 업무 큐에서 새 검토 업무를 만들어 다시 처리하세요.</span>
        <div class="quick-actions">
          ${targetHref ? `<a class="button ghost" href="${escapeHtml(targetHref)}">생성된 위키 보기</a>` : ''}
          <a class="button ghost" href="/admin/work">업무 큐로 돌아가기</a>
        </div>
      </section>` : ''}
      <section class="admin-panel">
        <h2>신청 내용</h2>
        ${componentTableMarkup(`<tbody>${fieldRows || emptyTableRow(2, '표시할 신청 내용 없음', '신청자가 입력한 서버/모드 정보가 없으므로 처리 전 원본 요청을 확인하세요.', '/admin/work', '업무 큐 보기')}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>처리</h2>
        <form class="stack-form compact-form" method="post" action="/admin/subwiki-requests/${requestId}">
          <label>처리 메모<input name="note" placeholder="승인/반려 사유"></label>
          <div class="quick-actions">
            <button name="action" value="approve"${disabledButtonAttrs}>승인하고 위키 생성</button>
            <button class="ghost" name="action" value="reject"${disabledButtonAttrs}>반려</button>
          </div>
        </form>
      </section>
    </main>`,
    user,
    'admin'
  );
}

function subwikiRequestTargetHref(type: string, slug: string) {
  if (!slug) return '';
  if (type === 'server') return `/server/${slug}`;
  if (type === 'mod') return `/mod/${slug}`;
  if (type === 'develop') return `/dev/${slug}`;
  return `/wiki/${slug}`;
}

function subwikiRequestStarterDocs(type: string, starterSet: unknown) {
  const key = String(starterSet ?? '').trim();
  if (type === 'server') {
    const label = key || 'server-basic';
    return { title: label, detail: '대문, 규칙, 접속 안내 같은 서버 공식 문서 세트를 생성합니다.' };
  }
  if (type === 'mod') {
    const label = key || 'mod-basic';
    return { title: label, detail: '대문, 설치, 호환성, 변경점 같은 모드 위키 기본 문서를 생성합니다.' };
  }
  return { title: key || '기본 세트', detail: '승인 후 전용 위키의 첫 문서를 생성합니다.' };
}

function subwikiRequestApprovalHint(type: string, slug: string, meta: Record<string, string>) {
  if (!slug) return '슬러그가 없어 승인 후 생성될 주소를 확정할 수 없습니다. 신청 내용을 먼저 보완하세요.';
  if (type === 'server' && !meta.host) return '서버 주소가 비어 있습니다. 운영자 인증과 상태 점검을 위해 주소 확인이 필요합니다.';
  if (type === 'mod' && !meta.officialLink && !meta.sourceUrl) return '공식 링크나 소스 코드가 없으면 제작자/공식성 검증이 어려울 수 있습니다.';
  return '주소, 초기 문서, 신청자 연결 상태를 확인한 뒤 승인하거나 반려하세요.';
}

function parseRequestNote(note: unknown) {
  const meta: Record<string, string> = {};
  for (const line of String(note ?? '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim();
  }
  return meta;
}

function subwikiRequestTypeLabel(type: string) {
  const labels: Record<string, string> = {
    server: '서버 위키',
    mod: '모드 위키',
    develop: '개발 위키'
  };
  return labels[type] ?? type;
}

export function adminSubwikisPage(data: { spaces: any[]; requests: any[] }, user: CurrentUser | null) {
  const spaces = data.spaces ?? [];
  const requests = data.requests ?? [];
  const serverCount = spaces.filter((space) => String(space.space_type) === 'server_wiki').length;
  const modCount = spaces.filter((space) => String(space.space_type) === 'mod_wiki').length;
  const needsWork = spaces.filter((space) => ['pending', 'needs_maintainer', 'outdated', 'verification_expired'].includes(String(space.status ?? ''))).length;
  const summaryCards = [
    ['서버 위키', serverCount, '공식 서버 문서 공간입니다.'],
    ['모드 위키', modCount, '모드별 전용 문서 공간입니다.'],
    ['관리 필요', needsWork, '상태 확인이나 관리자가 필요한 위키입니다.'],
    ['신청', requests.filter((row) => String(row.status ?? '') === 'pending').length, '승인 대기 중인 위키 신청입니다.']
  ]
    .map(([title, value, detail]) => `<article class="operator-card"><strong>${escapeHtml(String(title))}</strong> <span>${escapeHtml(String(value))}</span> <small>${escapeHtml(String(detail))}</small></article>`)
    .join('');
  const rows = spaces
    .map((space) => {
      const code = String(space.code ?? space.space_key ?? '');
      const publicHref = subwikiAdminPublicHref(space);
      const modSlug = String(space.slug ?? '').trim();
      const isMod = String(space.space_type ?? '') === 'mod_wiki';
      return `<tr>
        <td data-label="위키">
          <strong>${publicHref ? `<a href="${escapeHtml(publicHref)}">${escapeHtml(space.title ?? space.name ?? code)}</a>` : escapeHtml(space.title ?? space.name ?? code)}</strong>
          <small>${escapeHtml(wikiSpaceTypeLabel(space.space_type))} · ${escapeHtml(code)}</small>
        </td>
        <td data-label="상태">${escapeHtml(subwikiStatusLabel(space.status))}</td>
        <td data-label="문서">${escapeHtml(String(space.doc_count ?? 0))}쪽<small>사이드바 ${escapeHtml(String(space.sidebar_count ?? 0))} · 역할 ${escapeHtml(String(space.role_count ?? 0))}</small></td>
        <td data-label="핵심 정보">${escapeHtml(subwikiAdminDetail(space))}</td>
        <td data-label="상태 변경">
          <form class="stack-form compact-form" method="post" action="/admin/subwikis/${encodeURIComponent(code)}/status">
            <select name="status">${subwikiStatusOptions(String(space.status ?? 'active'))}</select>
            <input name="reason" placeholder="변경 사유">
            <button>상태 저장</button>
          </form>
        </td>
        <td data-label="사이드바">
          <form class="stack-form compact-form" method="post" action="/admin/subwikis/${encodeURIComponent(code)}/sidebar">
            <input name="label" placeholder="라벨" required>
            <input name="targetTitle" placeholder="대상 문서 제목">
            <input name="targetUrl" placeholder="외부 링크">
            <input name="sortOrder" inputmode="numeric" placeholder="정렬">
            <button>항목 추가</button>
          </form>
          ${String(space.space_type ?? '') === 'server_wiki' && space.root_page_id ? `<form class="stack-form compact-form" method="post" action="/admin/servers/${escapeHtml(String(space.root_page_id))}/status">
            <strong>서버 상태</strong>
            <select name="operationalStatus">${serverOperationalOptions(String(space.operational_status ?? 'unverified'))}</select>
            <select name="verifiedStatus">${serverVerifiedOptions(String(space.verified_status ?? 'pending'))}</select>
            <input name="note" placeholder="처리 메모">
            <button>상태 저장</button>
          </form>` : ''}
          ${isMod ? `<form class="inline-form" method="post" action="/admin/mod-wikis/${encodeURIComponent(modSlug)}/creator-verification">
            <select name="verified">${option('1', space.creator_verified ? '1' : '0', '제작자 확인')}${option('0', space.creator_verified ? '1' : '0', '확인 해제')}</select>
            <button>제작자 상태</button>
          </form>` : ''}
        </td>
      </tr>`;
    })
    .join('');
  const requestRows = requests
    .map((request) => `<tr>
      <td data-label="신청"><strong>${escapeHtml(request.title ?? '위키 신청')}</strong><small>${escapeHtml(subwikiRequestTypeLabel(String(request.request_type ?? 'server')))}</small></td>
      <td data-label="상태">${escapeHtml(genericStatusLabel(String(request.status ?? 'pending')))}</td>
      <td data-label="신청자">${escapeHtml(request.requester_display_name ?? request.requester_username ?? '알 수 없음')}</td>
      <td data-label="신청일">${escapeHtml(formatDateTime(request.created_at))}</td>
      <td data-label="처리"><a class="button ghost" href="/admin/subwiki-requests/${escapeHtml(String(request.id))}">신청 보기</a></td>
    </tr>`)
    .join('');
  return layout(
    '서브위키 관리',
    `<main class="admin admin-subwikis-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>서브위키 관리</h1>
          <p>서버/모드 위키를 생성하고 상태, 사이드바, 제작자 확인을 관리합니다.</p>
        </div>
        <div class="quick-actions">
          <a class="button ghost" href="/admin/work">업무 큐</a>
          <a class="button ghost" href="/admin/imports">이전 작업</a>
        </div>
      </section>
      <section class="operator-summary">${summaryCards}</section>
      <section class="admin-guide-panel subwikis-guide">
        <div>
          <strong>서브위키 운영 순서</strong>
          <p>서버/모드 위키는 신청 승인, 초기 문서 생성, 상태·사이드바 정비가 이어지는 운영 단위입니다. 공개 주소와 공식성 검증을 먼저 확인한 뒤 사용자에게 노출하세요.</p>
        </div>
        <ol>
          <li><strong>신청 검토</strong><span>신청 보기에서 주소, 슬러그, 신청자, 초기 문서 세트를 확인한 뒤 승인하거나 반려합니다.</span></li>
          <li><strong>상태 정리</strong><span>운영 중, 관리자 필요, 인증 만료처럼 사용자에게 보일 상태를 실제 운영 상황에 맞춥니다.</span></li>
          <li><strong>탐색 구조 확인</strong><span>사이드바, 서버 상태, 제작자 확인을 맞춰 전용 위키 첫 화면에서 길을 잃지 않게 합니다.</span></li>
        </ol>
      </section>
      <section class="admin-grid audit-form-grid">
        <section class="admin-panel">
          <h2>서버 위키 만들기</h2>
          <form class="stacked-form" method="post" action="/admin/subwikis/server">
            <label>서버 이름<input name="title" placeholder="크리퍼타운 SMP" required></label>
            <label>슬러그<input name="slug" placeholder="creeper-town" required></label>
            <label>서버 주소<input name="host" placeholder="play.example.kr"></label>
            <label>에디션<select name="edition">${['java', 'bedrock', 'crossplay', 'unknown'].map((item) => option(item, undefined, serverEditionLabel(item))).join('')}</select></label>
            <label>지원 버전<input name="supportedVersions" placeholder="1.20.1-1.21.x"></label>
            <label>장르<input name="genres" placeholder="야생, 경제, RPG"></label>
            <label>초기 문서<select name="starterSet">${['server-basic', 'server-community', 'server-rules-heavy'].map((item) => option(item, undefined, starterSetLabel(item))).join('')}</select></label>
            <button>서버 위키 생성</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>모드 위키 만들기</h2>
          <form class="stacked-form" method="post" action="/admin/subwikis/mod">
            <label>모드 이름<input name="title" placeholder="Create" required></label>
            <label>슬러그<input name="slug" placeholder="create" required></label>
            <label>분류<input name="category" placeholder="기술, 최적화, 월드 생성"></label>
            <label>로더<input name="loader" placeholder="Forge, Fabric, NeoForge"></label>
            <label>지원 버전<input name="supportedVersions" placeholder="1.20.1, 1.21.x"></label>
            <label>공식 링크<input name="officialLink" placeholder="https://"></label>
            <label>라이선스<input name="license" placeholder="MIT, GPL, All Rights Reserved"></label>
            <label class="inline-check"><input type="checkbox" name="creatorVerified" value="1"> 제작자 확인으로 시작</label>
            <button>모드 위키 생성</button>
          </form>
        </section>
      </section>
      <section class="admin-panel">
        <h2>서버/모드 위키</h2>
        ${componentTableMarkup(`<thead><tr><th>위키</th><th>상태</th><th>문서</th><th>핵심 정보</th><th>상태 변경</th><th>사이드바/확인</th></tr></thead><tbody>${rows || emptyTableRow(6, '관리할 서브위키 없음', '서버나 모드 위키를 만들면 상태와 사이드바를 이 화면에서 관리합니다.')}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>최근 위키 신청</h2>
        ${componentTableMarkup(`<thead><tr><th>신청</th><th>상태</th><th>신청자</th><th>신청일</th><th>처리</th></tr></thead><tbody>${requestRows || emptyTableRow(5, '최근 신청 없음', '사용자가 서버/모드 위키를 신청하면 이 목록에서 확인합니다.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function subwikiStatusLabel(value: unknown) {
  const labels: Record<string, string> = {
    pending: '대기',
    active: '운영 중',
    readonly: '읽기 전용',
    verification_expired: '인증 만료',
    inactive: '비활성',
    closed: '닫힘',
    needs_maintainer: '관리자 필요',
    outdated: '오래됨',
    merged: '병합됨',
    archived: '보관됨',
    hidden: '숨김'
  };
  const key = String(value ?? 'active');
  return labels[key] ?? key.replace(/_/g, ' ');
}

function subwikiStatusOptions(selected: string) {
  return ['active', 'readonly', 'needs_maintainer', 'outdated', 'verification_expired', 'inactive', 'closed', 'archived', 'hidden']
    .map((item) => option(item, selected, subwikiStatusLabel(item)))
    .join('');
}

function subwikiAdminPublicHref(space: any) {
  const slug = String(space.slug ?? '').trim();
  if (String(space.space_type ?? '') === 'server_wiki') return slug ? `/server/${encodeURIComponent(slug)}` : '';
  if (String(space.space_type ?? '') === 'mod_wiki') return slug ? `/mod/${encodeURIComponent(slug)}` : '';
  return String(space.root_path ?? '').trim();
}

function subwikiAdminDetail(space: any) {
  if (String(space.space_type ?? '') === 'server_wiki') {
    return [space.host, serverEditionLabel(String(space.edition ?? 'unknown')), serverVerificationLabel(String(space.verified_status ?? 'pending')), serverOperationalLabel(String(space.operational_status ?? 'unverified'))].filter(Boolean).join(' · ');
  }
  if (String(space.space_type ?? '') === 'mod_wiki') {
    const verified = space.creator_verified ? '제작자 확인됨' : '제작자 미확인';
    return [space.category, space.loaders, space.supported_versions, verified].filter(Boolean).join(' · ');
  }
  return '';
}

function serverOperationalOptions(selected: string) {
  return ['active', 'checking_failed', 'inactive', 'closed', 'disputed', 'unverified']
    .map((item) => option(item, selected, serverOperationalLabel(item)))
    .join('');
}

function serverVerifiedOptions(selected: string) {
  return ['pending', 'verified', 'failed', 'expired', 'disputed']
    .map((item) => option(item, selected, serverVerificationLabel(item)))
    .join('');
}

function starterSetLabel(value: unknown) {
  const labels: Record<string, string> = {
    'server-basic': '기본 서버 문서',
    'server-community': '커뮤니티 서버 문서',
    'server-rules-heavy': '규칙 중심 서버 문서',
    'mod-minimal': '기본 모드 문서',
    'mod-docs': '상세 모드 문서'
  };
  const key = String(value ?? '');
  return labels[key] ?? key.replace(/-/g, ' ');
}

export function adminImportsPage(data: { spaces: any[]; gitbookJobs: any[]; markdownJobs: any[] }, user: CurrentUser | null) {
  const spaces = data.spaces ?? [];
  const gitbookJobs = data.gitbookJobs ?? [];
  const markdownJobs = data.markdownJobs ?? [];
  const spaceOptions = spaces
    .map((space) => option(String(space.id), undefined, `${space.title ?? space.name ?? space.code} · ${wikiSpaceTypeLabel(space.space_type)}`))
    .join('');
  const gitbookDisabledReason = '대상 서버/모드 위키를 먼저 만들어야 합니다.';
  const gitbookSpaceGate = spaceOptions
    ? ''
    : `<aside class="doc-status warning import-space-gate" id="import-space-gate">
        <strong>대상 위키 필요</strong>
        <span>GitBook 이전은 서버/모드 위키에 연결해서 실행합니다. 먼저 서브위키 관리에서 대상 위키를 만들거나 활성화하세요.</span>
        <a class="button ghost" href="/admin/subwikis">서브위키 관리</a>
      </aside>`;
  const gitbookSubmitAttrs = spaceOptions
    ? ''
    : ` disabled title="${escapeHtml(gitbookDisabledReason)}" aria-describedby="import-space-gate"`;
  const summaryCards = [
    ['GitBook 대기', gitbookJobs.filter((job) => ['pending', 'mapping', 'review'].includes(String(job.status ?? ''))).length, '문서 매핑이나 실행이 필요한 이전 작업입니다.'],
    ['GitBook 실패', gitbookJobs.filter((job) => String(job.status ?? '') === 'failed').length, '오류 메시지를 확인하고 다시 실행합니다.'],
    ['Markdown 작업', markdownJobs.length, '수동 이전 체크리스트와 소스 기록입니다.'],
    ['대상 위키', spaces.length, '이전 작업을 연결할 서버/모드 위키입니다.']
  ]
    .map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`)
    .join('');
  const gitbookRows = gitbookJobs
    .map((job) => `<tr>
      <td data-label="소스"><strong>${escapeHtml(gitbookImportSourceLabel(job.source_type))}</strong><small>${escapeHtml(job.source_note ?? '소스 메모 없음')}</small></td>
      <td data-label="대상">${escapeHtml(job.space_title ?? job.space_code ?? '연결된 위키 없음')}</td>
      <td data-label="상태">${escapeHtml(genericStatusLabel(String(job.status ?? 'pending')))}</td>
      <td data-label="결과">${escapeHtml(String(job.imported_pages ?? 0))}쪽</td>
      <td data-label="갱신">${escapeHtml(formatDateTime(job.updated_at ?? job.created_at))}</td>
      <td data-label="오류">${escapeHtml(importJobErrorLabel(job.error_message))}</td>
      <td data-label="실행">
        <form class="stack-form compact-form" method="post" action="/admin/imports/gitbook/${escapeHtml(String(job.id))}/run">
          <textarea name="summary" rows="2" placeholder="SUMMARY.md 목차"></textarea>
          <textarea name="markdown" rows="3" placeholder="# 문서 제목&#10;&#10;문서 내용&#10;---&#10;# 다음 문서"></textarea>
          <button>실행</button>
        </form>
      </td>
    </tr>`)
    .join('');
  const markdownRows = markdownJobs
    .map((job) => {
      const checklist = safeStringArray(job.checklist_json);
      return `<tr>
        <td data-label="소스"><strong>${escapeHtml(job.source_name ?? 'Markdown 소스')}</strong><small>${escapeHtml(markdownImportSourceLabel(job.source_type))}</small></td>
        <td data-label="대상">${escapeHtml(job.space_title ?? job.space_code ?? '공통')}</td>
        <td data-label="상태">${escapeHtml(genericStatusLabel(String(job.status ?? 'pending')))}</td>
        <td data-label="결과">${escapeHtml(String(job.imported_pages ?? 0))}쪽</td>
        <td data-label="체크리스트">${escapeHtml(checklist.length ? checklist.join(', ') : '체크리스트 없음')}</td>
        <td data-label="갱신">${escapeHtml(formatDateTime(job.updated_at ?? job.created_at))}</td>
      </tr>`;
    })
    .join('');
  return layout(
    '이전 작업',
    `<main class="admin admin-imports-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>이전 작업</h1>
          <p>GitBook, Notion, Markdown 문서를 서버/모드 위키로 옮기는 관리자 화면입니다.</p>
        </div>
        <div class="quick-actions">
          <a class="button ghost" href="/admin/work">업무 큐</a>
          <a class="button ghost" href="/admin/jobs">작업 큐</a>
        </div>
      </section>
      <section class="audit-summary jobs-summary">${summaryCards}</section>
      <section class="admin-guide-panel imports-guide">
        <div>
          <strong>문서 이전 순서</strong>
          <p>이전 작업은 기존 문서를 새 위키 구조에 맞게 넣는 절차입니다. 대상 위키를 먼저 고르고, 목차와 본문을 확인한 뒤 실행 결과를 실제 문서와 사이드바에서 검증합니다.</p>
        </div>
        <ol>
          <li><strong>대상 위키 선택</strong><span>서버/모드 위키가 맞는지 확인하고 소스 메모에 원본 위치와 날짜를 남깁니다.</span></li>
          <li><strong>목차/본문 검토</strong><span>SUMMARY 목차와 Markdown 본문을 나눠 넣어 문서 트리와 페이지가 어긋나지 않게 합니다.</span></li>
          <li><strong>실행 후 확인</strong><span>생성된 문서, 이미지 링크, 외부 링크, 공식 영역과 사이드바 순서를 다시 점검합니다.</span></li>
        </ol>
      </section>
      <section class="admin-grid audit-form-grid">
        <section class="admin-panel">
          <h2>GitBook 이전 만들기</h2>
          <form class="stacked-form" method="post" action="/admin/imports/gitbook">
            <label>대상 위키<select name="spaceId" required>${spaceOptions || '<option value="">대상 위키 없음</option>'}</select></label>
            <label>소스 유형<select name="sourceType">${['manual', 'markdown_zip', 'notion_export', 'other'].map((item) => option(item, undefined, gitbookImportSourceLabel(item))).join('')}</select></label>
            <label>소스 메모<input name="sourceNote" placeholder="예: 기존 GitBook export 2026-05"></label>
            <label>체크리스트<textarea name="checklist" rows="4" placeholder="접속 문서&#10;규칙 문서&#10;공지 문서&#10;사이드바 매핑"></textarea></label>
            ${gitbookSpaceGate}
            <button${gitbookSubmitAttrs}>이전 작업 만들기</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>Markdown 체크리스트</h2>
          <form class="stacked-form" method="post" action="/admin/imports/markdown">
            <label>연결 위키<select name="spaceId"><option value="">공통 작업</option>${spaceOptions}</select></label>
            <label>소스 유형<select name="sourceType">${['markdown', 'gitbook', 'manual'].map((item) => option(item, undefined, markdownImportSourceLabel(item))).join('')}</select></label>
            <label>소스 이름<input name="sourceName" placeholder="예: rules-export.md" required></label>
            <label>체크리스트<textarea name="checklist" rows="4" placeholder="이미지 링크 확인&#10;외부 링크 확인&#10;공식 영역 확인"></textarea></label>
            <button>체크리스트 저장</button>
          </form>
        </section>
      </section>
      <section class="admin-panel">
        <h2>GitBook 실행 작업</h2>
        ${componentTableMarkup(`<thead><tr><th>소스</th><th>대상</th><th>상태</th><th>결과</th><th>갱신</th><th>오류</th><th>실행</th></tr></thead><tbody>${gitbookRows || emptyTableRow(7, 'GitBook 이전 작업 없음', '위 폼에서 대상 위키와 소스를 지정해 이전 작업을 만드세요.')}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>Markdown 작업 기록</h2>
        ${componentTableMarkup(`<thead><tr><th>소스</th><th>대상</th><th>상태</th><th>결과</th><th>체크리스트</th><th>갱신</th></tr></thead><tbody>${markdownRows || emptyTableRow(6, 'Markdown 작업 없음', '수동 이전 체크리스트가 필요하면 위 폼에서 추가하세요.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function safeStringArray(value: unknown) {
  if (Array.isArray(value)) return value.map((item) => String(item)).filter(Boolean);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map((item) => String(item)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

function wikiSpaceTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    server_wiki: '서버 위키',
    mod_wiki: '모드 위키',
    develop_wiki: '개발 위키'
  };
  const key = String(value ?? '');
  return labels[key] ?? key.replace(/_/g, ' ');
}

function gitbookImportSourceLabel(value: unknown) {
  const labels: Record<string, string> = {
    manual: '수동 입력',
    markdown_zip: 'Markdown 압축',
    notion_export: 'Notion 내보내기',
    other: '기타'
  };
  const key = String(value ?? 'manual');
  return labels[key] ?? key.replace(/_/g, ' ');
}

function markdownImportSourceLabel(value: unknown) {
  const labels: Record<string, string> = {
    gitbook: 'GitBook',
    markdown: 'Markdown',
    manual: '수동 입력'
  };
  const key = String(value ?? 'markdown');
  return labels[key] ?? key.replace(/_/g, ' ');
}

function importJobErrorLabel(value: unknown) {
  return String(value ?? '').trim() ? '오류 확인 필요' : '-';
}

export function adminJobsPage(rows: any[], user: CurrentUser | null) {
  const pendingCount = rows.filter((job) => String(job.status ?? '') === 'pending').length;
  const failedCount = rows.filter((job) => String(job.status ?? '') === 'failed').length;
  const runningCount = rows.filter((job) => String(job.status ?? '') === 'running').length;
  const summaryCards = [
    ['대기', pendingCount, '실행 순서를 기다리는 작업입니다.'],
    ['실행 중', runningCount, '현재 처리 중인 백그라운드 작업입니다.'],
    ['실패', failedCount, '오류 메시지를 확인하고 다시 큐에 넣어야 합니다.'],
    ['최근 작업', rows.length, '최근 작업 큐 기록입니다.']
  ].map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`).join('');
  const jobRows = rows
    .map(
      (job) => `<tr>
        <td data-label="작업"><strong>${escapeHtml(jobTypeLabel(job.job_type))}</strong></td>
        <td data-label="대상">${escapeHtml(jobPayloadLabel(job))}</td>
        <td data-label="상태">${escapeHtml(genericStatusLabel(String(job.status ?? 'pending')))}</td>
        <td data-label="시도">${escapeHtml(String(job.attempts ?? 0))}/${escapeHtml(String(job.max_attempts ?? 0))}</td>
        <td data-label="예약">${escapeHtml(formatDateTime(job.run_after, '즉시'))}</td>
        <td data-label="오류">${escapeHtml(job.error_message ?? '')}</td>
        <td data-label="생성">${escapeHtml(formatDateTime(job.created_at))}</td>
      </tr>`
    )
    .join('');
  return layout(
    '작업 큐',
    `<main class="admin admin-jobs-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>작업 큐</h1>
          <p>검색, 렌더링, 파일, 서버 상태 점검 작업의 실행 상태를 확인합니다.</p>
        </div>
        <div class="quick-actions">
          <form class="inline-form" method="post" action="/admin/jobs/run-next"><button>다음 작업 실행</button></form>
          <form class="inline-form" method="post" action="/admin/jobs/sync-spaces"><button>위키 공간 동기화</button></form>
          <a class="button ghost" href="/admin/imports">이전 작업</a>
        </div>
      </section>
      <section class="audit-summary jobs-summary">${summaryCards}</section>
      <section class="admin-guide-panel jobs-guide">
        <div>
          <strong>작업 큐 운용 순서</strong>
          <p>대기 작업은 사이트가 바뀐 뒤 검색, 렌더링, 링크 정보를 맞추기 위한 백그라운드 처리입니다. 실패 항목은 오류 원인을 먼저 확인하고 같은 작업을 다시 예약합니다.</p>
        </div>
        <ol>
          <li><strong>대기/실패 확인</strong><span>실패가 있으면 오류 메시지를 먼저 보고, 대기 작업은 실행 순서와 예약 시간을 확인합니다.</span></li>
          <li><strong>필요 작업 추가</strong><span>문서 단위 색인, 링크 재계산, 파일 점검처럼 대상이 분명한 작업만 새로 넣습니다.</span></li>
          <li><strong>실행 후 검증</strong><span>다음 작업 실행 뒤 최근 바뀜, 감사 허브, 검색 화면에서 결과가 반영됐는지 확인합니다.</span></li>
        </ol>
      </section>
      <section class="admin-grid audit-form-grid">
        <section class="admin-panel">
          <h2>작업 추가</h2>
          <form class="stacked-form" method="post" action="/admin/jobs">
            <label>작업 종류<select name="jobType">${['render_page', 'reindex_page', 'rebuild_links', 'rebuild_categories', 'check_file_usage', 'check_mod_links', 'check_server_status', 'run_consistency_check'].map((item) => option(item, undefined, jobTypeLabel(item))).join('')}</select></label>
            <label>문서 번호<input name="pageId" inputmode="numeric" placeholder="문서 대상 작업일 때 입력"></label>
            <label>처리 개수<input name="limit" type="number" min="1" max="1000" value="100"></label>
            <label>예약 시간<input name="runAfter" type="datetime-local"></label>
            <label class="inline-check"><input type="checkbox" name="autoFix" value="1"> 가능한 항목 자동 보정</label>
            <button>작업 추가</button>
          </form>
        </section>
        <section class="admin-panel">
          <h2>운영 기준</h2>
          <p>문서 렌더링, 검색 색인, 링크·분류 재계산은 문서 번호가 필요합니다. 서버 상태와 파일 점검은 문서 번호 없이 전체 또는 일부만 실행할 수 있습니다. 위키 공간 동기화는 문서와 모드·서버·개발 위키 연결을 다시 맞춥니다.</p>
          <div class="quick-actions"><a class="button ghost" href="/admin/audits">감사 허브</a><a class="button ghost" href="/admin/recent">관리자 최근 바뀜</a></div>
        </section>
      </section>
      <section class="admin-panel">
        <h2>작업 목록</h2>
        ${componentTableMarkup(`<thead><tr><th>작업</th><th>대상</th><th>상태</th><th>시도</th><th>예약</th><th>오류</th><th>생성</th></tr></thead><tbody>${jobRows || emptyTableRow(7, '대기 중인 작업 없음', '검색 색인, 렌더링, 파일 점검 같은 백그라운드 작업이 생성되면 이 큐에 표시됩니다.', '/admin', '대시보드')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function jobPayloadLabel(job: any) {
  const payload = safeObject(job.payload_json);
  const type = String(job.job_type ?? '');
  if (['render_page', 'reindex_page', 'rebuild_links', 'rebuild_categories'].includes(type)) return payload.pageId ? `문서 #${payload.pageId}` : '문서 지정 필요';
  if (type === 'check_file_usage') return payload.pageId ? `문서 #${payload.pageId} 파일` : '전체 파일';
  if (type === 'check_server_status') return payload.pageId ? `서버 문서 #${payload.pageId}` : `서버 최대 ${payload.limit ?? 100}건`;
  if (type === 'run_consistency_check') return payload.autoFix ? '자동 보정 포함' : '점검만 실행';
  return '전체';
}

export function adminFilesPage(data: { licenseIssues: any[]; unusedFiles: any[] }, user: CurrentUser | null) {
  const statusOption = (value: string, current: string, label: string) => `<option value="${value}"${current === value ? ' selected' : ''}>${label}</option>`;
  const licenseIssues = data.licenseIssues ?? [];
  const unusedFiles = data.unusedFiles ?? [];
  const summaryCards = [
    ['라이선스/출처 필요', licenseIssues.length, '저작권 표기가 부족한 파일입니다.'],
    ['미사용 파일', unusedFiles.length, '문서에서 참조되지 않는 파일입니다.'],
    ['관리 작업', licenseIssues.length + unusedFiles.length, '숨김/삭제는 문서 표시와 파일 링크에 바로 반영됩니다.']
  ]
    .map(([label, value, detail]) => `<div><strong>${escapeHtml(String(value))}</strong><span>${escapeHtml(String(label))}</span><small>${escapeHtml(String(detail))}</small></div>`)
    .join('');
  const fileRows = (rows: any[], emptyTitle: string, emptyDetail: string) =>
    rows.length
      ? rows
          .map((file) => {
            const status = String(file.status ?? 'normal');
            const fileName = String(file.file_name ?? '');
            return `<tr>
              <td data-label="파일"><a href="/file/${encodeURIComponent(fileName)}">${escapeHtml(fileName)}</a><small>${escapeHtml(file.mime_type ?? '')} · ${escapeHtml(formatBytes(Number(file.size_bytes ?? 0)))}</small></td>
              <td data-label="라이선스">${escapeHtml(fileLicenseLabel(file.license))}</td>
              <td data-label="출처">${fileSourceHtml(file.source_text, file.source_url)}</td>
              <td data-label="상태">${escapeHtml(fileStatusLabel(status))}</td>
              <td data-label="수정">
                <form class="stack-form compact-form file-admin-form" method="post" action="/admin/files/${escapeHtml(String(file.id))}">
                  <label><span>라이선스</span><input name="license" value="${escapeHtml(file.license ?? '')}" placeholder="CC BY-SA 4.0"></label>
                  <label><span>출처 URL</span><input name="sourceUrl" value="${escapeHtml(file.source_url ?? '')}" placeholder="https://"></label>
                  <label><span>출처 설명</span><input name="sourceText" value="${escapeHtml(file.source_text ?? '')}" placeholder="작성자/사이트/원본 문서"></label>
                  <label><span>표시 상태</span><select name="status">
                      ${statusOption('normal', status, '정상')}
                      ${statusOption('license_needed', status, '라이선스 필요')}
                      ${statusOption('hidden', status, '숨김')}
                      ${statusOption('deleted', status, '삭제')}
                    </select></label>
                  <small class="file-admin-warning">숨김/삭제는 일반 문서의 파일 표시를 제한합니다.</small>
                  <button>파일 정보 저장</button>
                </form>
              </td>
            </tr>`;
          })
          .join('')
      : emptyTableRow(5, emptyTitle, emptyDetail);
  return layout(
    '파일 관리',
    `<main class="admin">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>파일 관리</h1>
          <p>라이선스, 출처, 미사용 파일을 운영 화면에서 바로 확인합니다.</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/file/upload">파일 업로드</a><a class="button ghost" href="/help/파일_업로드">업로드 기준</a><a class="button ghost" href="/admin/work">업무 큐</a></div>
      </section>
      <section class="admin-panel">
        <h2>검토 요약</h2>
        <div class="admin-file-summary">${summaryCards}</div>
      </section>
      <section class="admin-panel">
        <h2>라이선스/출처 필요</h2>
        ${componentTableMarkup(`<thead><tr><th>파일</th><th>라이선스</th><th>출처</th><th>상태</th><th>수정</th></tr></thead><tbody>${fileRows(licenseIssues, '라이선스 확인 대상 없음', '출처나 라이선스가 부족한 파일이 생기면 이 목록에서 바로 보강합니다.')}</tbody>`)}
      </section>
      <section class="admin-panel">
        <h2>미사용 파일</h2>
        ${componentTableMarkup(`<thead><tr><th>파일</th><th>라이선스</th><th>출처</th><th>상태</th><th>수정</th></tr></thead><tbody>${fileRows(unusedFiles, '미사용 파일 없음', '문서에서 더 이상 참조하지 않는 파일이 발견되면 정리 대상으로 표시됩니다.')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function adminWorkTypeLabel(type: string) {
  const labels: Record<string, string> = {
    report: '신고',
    pending_review: '검토 대기',
    server_claim: '서버 인증',
    server_dispute: '서버 분쟁',
    file_license: '파일 문제',
    edit_filter_hit: '편집 필터',
    restore_request: '복구 요청',
    mod_link_review: '모드 링크',
    subwiki_request: '위키 신청',
    gitbook_import: 'GitBook 이전',
    develop_review: '개발 문서',
    search_alias: '검색 별칭'
  };
  return labels[type] ?? type;
}

function adminWorkTarget(item: any) {
  if (item.work_type === 'pending_review') {
    return {
      label: item.review_title ? `${searchGroupLabel(String(item.review_namespace ?? 'main'))} · ${item.review_title}` : '검토 요청',
      detail: `${item.review_status ? genericStatusLabel(String(item.review_status)) : ''} ${item.review_reason ?? ''}`.trim(),
      href: item.review_status ? `/admin/reviews/${encodeURIComponent(String(item.target_id))}` : ''
    };
  }
  if (item.work_type === 'mod_link_review') {
    return {
      label: item.review_title ? `모드 링크 검토 · ${item.review_title}` : '모드 링크 검토',
      detail: `${item.review_status ? genericStatusLabel(String(item.review_status)) : ''} ${item.review_reason ?? ''}`.trim(),
      href: item.review_status ? `/admin/reviews/${encodeURIComponent(String(item.target_id))}` : ''
    };
  }
  if (item.work_type === 'report') {
    return { label: '신고 접수', detail: `${item.report_status ? genericStatusLabel(String(item.report_status)) : ''} ${item.report_reason ?? ''}`.trim(), href: '' };
  }
  if (item.work_type === 'file_license') {
    return { label: '파일 라이선스 점검', detail: `${item.report_status ? genericStatusLabel(String(item.report_status)) : ''} ${item.report_reason ?? ''}`.trim(), href: '/admin/files' };
  }
  if (item.work_type === 'server_claim') {
    return { label: item.claim_page_title ?? '서버 인증 요청', detail: `${item.claim_status ? serverVerificationLabel(String(item.claim_status)) : ''} ${item.claim_method ?? ''}`.trim(), href: '/my/servers' };
  }
  if (item.work_type === 'server_dispute') {
    return { label: item.dispute_page_title ?? '서버 분쟁', detail: '운영 상태 분쟁', href: item.dispute_page_title ? `/server/${encodeURIComponent(item.dispute_page_title)}` : '' };
  }
  if (item.work_type === 'subwiki_request') {
    return {
      label: item.subwiki_title ?? '위키 신청',
      detail: item.subwiki_status ? genericStatusLabel(String(item.subwiki_status)) : '',
      href: item.target_id ? `/admin/subwiki-requests/${encodeURIComponent(String(item.target_id))}` : ''
    };
  }
  if (item.work_type === 'gitbook_import') {
    return { label: item.gitbook_source_note ?? 'GitBook 이전', detail: item.gitbook_status ? genericStatusLabel(String(item.gitbook_status)) : '', href: '/admin/imports' };
  }
  if (item.target_type === 'contributor_task') {
    return { label: item.task_title ?? '기여 작업', detail: item.task_status ? genericStatusLabel(String(item.task_status)) : '', href: '/tasks' };
  }
  return { label: targetTypeLabel(item.target_type), detail: '', href: '' };
}

export function adminSearchPage(data: { failed: any[]; noClicks?: any[]; pins: any[]; disambiguations: any[]; dictionary: any[]; aliases?: any[] }, user: CurrentUser | null) {
  const aliases = data.aliases ?? [];
  const noClicks = data.noClicks ?? [];
  const issueCount = data.failed.length + noClicks.length;
  const summaryCards = [
    ['실패 검색어', `${data.failed.length}건`, '결과가 없어서 사용자가 막힌 검색어입니다.'],
    ['클릭 없음', `${noClicks.length}건`, '결과는 있지만 사용자가 문서를 열지 않은 검색어입니다.'],
    ['고정 결과', `${data.pins.length}건`, '대표 문서로 바로 연결할 검색어입니다.'],
    ['검색 사전', `${data.dictionary.length}건`, '별칭, 동음이의, 무시 규칙입니다.'],
    ['문서 별칭', `${aliases.length}건`, '오탈자와 다른 표기를 실제 문서로 연결합니다.']
  ]
    .map(([title, value, detail]) => `<article class="operator-card"><strong>${escapeHtml(title)}</strong> <span>${escapeHtml(value)}</span> <small>${escapeHtml(detail)}</small></article>`)
    .join('');
  const failedRows = data.failed
    .map(
      (row) => `<tr>
        <td><strong>${escapeHtml(row.query)}</strong><small>${escapeHtml(row.normalized_query)}</small></td>
        <td>${escapeHtml(String(row.attempts))}</td>
        <td>${escapeHtml(formatDateTime(row.last_seen))}</td>
        <td>
          <form class="inline-form" method="post" action="/admin/search/dictionary">
            <input type="hidden" name="term" value="${escapeHtml(row.query)}">
            <input name="targetPageRef" placeholder="대상 문서 제목 또는 번호">
            <select name="action"><option value="alias">별칭</option><option value="disambiguation">동음이의</option><option value="ignore">무시</option></select>
            <input name="note" placeholder="메모">
            <button>처리</button>
          </form>
        </td>
      </tr>`
    )
    .join('');
  const noClickRows = noClicks
    .map(
      (row) => `<tr>
        <td><strong>${escapeHtml(row.query)}</strong><small>${escapeHtml(row.normalized_query)}</small></td>
        <td>${escapeHtml(String(row.attempts))}</td>
        <td>${escapeHtml(String(row.last_result_count ?? ''))}</td>
        <td>${escapeHtml(formatDateTime(row.last_seen))}</td>
      </tr>`
    )
    .join('');
  const pinRows = data.pins
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.query)}</td>
        <td><a href="${wikiUrl(row.namespace_code, row.title)}">${escapeHtml(row.title)}</a></td>
        <td>${escapeHtml(spaceLabel(String(row.namespace_code ?? '')))}</td>
        <td>${escapeHtml(row.note ?? '')}</td>
        <td>${row.enabled ? '사용' : '중지'}</td>
      </tr>`
    )
    .join('');
  const disambRows = data.disambiguations
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.query)}</td>
        <td><a href="${wikiUrl(row.namespace_code, row.title)}">${escapeHtml(row.title)}</a></td>
        <td>${escapeHtml(spaceLabel(String(row.namespace_code ?? '')))}</td>
        <td>${escapeHtml(row.label ?? '')}</td>
        <td>${escapeHtml(row.note ?? '')}</td>
        <td>${row.enabled ? '사용' : '중지'}</td>
      </tr>`
    )
    .join('');
  const dictionaryRows = data.dictionary
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.term)}</td>
        <td>${escapeHtml(searchDictionaryActionLabel(row.action))}</td>
        <td>${row.target_page_id ? `<a href="${wikiUrl(row.namespace_code, row.title)}">${escapeHtml(row.title)}</a><small>${escapeHtml(spaceLabel(String(row.namespace_code ?? '')))}</small>` : '-'}</td>
        <td>${escapeHtml(row.note ?? '')}</td>
        <td>${row.enabled ? '사용' : '중지'}</td>
      </tr>`
    )
    .join('');
  const aliasRows = aliases
    .map(
      (row) => `<tr>
        <td>${escapeHtml(row.alias_title ?? '')}<small>${escapeHtml(spaceLabel(String(row.alias_namespace_code ?? '')))}</small></td>
        <td>${escapeHtml(aliasTypeLabel(row.alias_type))}</td>
        <td><a href="${wikiUrl(row.target_namespace_code, row.target_title)}">${escapeHtml(row.target_title ?? '')}</a><small>${escapeHtml(spaceLabel(String(row.target_namespace_code ?? '')))}</small></td>
        <td>${escapeHtml(formatDateTime(row.created_at, ''))}</td>
      </tr>`
    )
    .join('');
  return layout(
    '검색 운영',
    `<main class="admin admin-search-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>검색 운영</h1>
          <p>검색 실패어, 고정 결과, 동음이의 후보, 검색 사전을 관리합니다.</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/admin/work">업무 큐</a></div>
      </section>
      <section class="operator-summary">${summaryCards}</section>
      <section class="admin-guide-panel search-ops-guide">
        <div>
          <strong>검색 정비 흐름</strong>
          <p>실패어는 별칭, 동음이의, 무시 규칙 중 하나로 정리하고 클릭 없는 검색어는 결과 품질을 업무 큐에서 점검합니다.</p>
        </div>
        <ol>
          <li><strong>막힌 검색어 확인</strong><span>${escapeHtml(String(issueCount))}건의 실패/무클릭 검색어를 먼저 봅니다.</span></li>
          <li><strong>문서 연결</strong><span>대표 문서는 고정 결과나 문서 별칭으로 바로 연결합니다.</span></li>
          <li><strong>사전 정리</strong><span>애매한 검색어는 동음이의 후보, 불필요한 검색어는 무시로 남깁니다.</span></li>
        </ol>
        <p class="muted">문서 번호를 몰라도 문서 제목이나 네임스페이스 제목(예: 개발:Paper API, 모드:Create/회전력)으로 검색 규칙을 연결할 수 있습니다.</p>
      </section>
      <section class="admin-grid search-admin-grid">
        <section class="admin-panel search-admin-primary">
          <h2>반복 실패 검색어</h2>
          ${componentTableMarkup(`<thead><tr><th>검색어</th><th>횟수</th><th>마지막</th><th>처리</th></tr></thead><tbody>${failedRows || emptyTableRow(4, '반복 실패 검색어 없음', '검색 실패가 반복되면 별칭, 동음이의, 무시 처리로 정리합니다.')}</tbody>`)}
        </section>
        <section class="admin-panel">
          <h2>클릭 없는 검색어</h2>
          <form class="inline-form" method="post" action="/admin/search/no-click-tasks">
            <button>업무 큐로 등록</button>
          </form>
          ${componentTableMarkup(`<thead><tr><th>검색어</th><th>횟수</th><th>최근 결과 수</th><th>마지막</th></tr></thead><tbody>${noClickRows || emptyTableRow(4, '클릭 없는 검색어 없음', '결과는 나오지만 아무 문서도 열지 않는 검색어가 반복되면 업무 큐에 등록합니다.')}</tbody>`)}
        </section>
      </section>
      <section class="admin-grid search-admin-grid">
        <section class="admin-panel">
          <h2>검색 결과 고정</h2>
          <form class="inline-form" method="post" action="/admin/search/pins">
            <input name="query" placeholder="검색어">
            <input name="pageRef" placeholder="문서 제목 또는 번호">
            <input name="note" placeholder="운영 메모">
            <button>고정 추가</button>
          </form>
          ${componentTableMarkup(`<thead><tr><th>검색어</th><th>문서</th><th>공간</th><th>메모</th><th>상태</th></tr></thead><tbody>${pinRows || emptyTableRow(5, '고정 결과 없음', '특정 검색어가 항상 대표 문서로 이어져야 할 때 위 폼으로 추가합니다.')}</tbody>`)}
        </section>
        <section class="admin-panel">
          <h2>문서 별칭</h2>
          <form class="inline-form" method="post" action="/admin/search/aliases">
            <input name="aliasTitle" placeholder="별칭 또는 오탈자">
            <select name="namespace">
              ${['main', 'mod', 'server', 'dev', 'guide', 'data', 'help', 'project', 'template'].map((item) => option(item, undefined, spaceLabel(item))).join('')}
            </select>
            <input name="targetPageRef" placeholder="대상 문서 제목 또는 번호">
            <select name="aliasType">${['alias', 'redirect', 'typo', 'english', 'korean_alt', 'search'].map((item) => option(item, undefined, aliasTypeLabel(item))).join('')}</select>
            <button>별칭 추가</button>
          </form>
          ${componentTableMarkup(`<thead><tr><th>별칭</th><th>종류</th><th>대상</th><th>생성</th></tr></thead><tbody>${aliasRows || emptyTableRow(4, '문서 별칭 없음', '오탈자, 영문 표기, 다른 이름을 대상 문서로 연결하면 검색과 링크 해석이 안정됩니다.')}</tbody>`)}
        </section>
      </section>
      <section class="admin-grid search-admin-grid">
        <section class="admin-panel">
          <h2>애매한 검색어 후보</h2>
          <form class="inline-form" method="post" action="/admin/search/disambiguations">
            <input name="query" placeholder="검색어 예: 페이퍼">
            <input name="pageRef" placeholder="후보 문서 제목 또는 번호">
            <input name="label" placeholder="후보 라벨">
            <input name="note" placeholder="설명">
            <button>후보 추가</button>
          </form>
          ${componentTableMarkup(`<thead><tr><th>검색어</th><th>문서</th><th>공간</th><th>라벨</th><th>설명</th><th>상태</th></tr></thead><tbody>${disambRows || emptyTableRow(6, '동음이의 후보 없음', '뜻이 여러 개인 검색어가 생기면 후보 문서를 등록해 사용자가 바로 고를 수 있게 합니다.')}</tbody>`)}
        </section>
        <section class="admin-panel">
          <h2>검색 사전</h2>
          <form class="inline-form" method="post" action="/admin/search/dictionary">
            <input name="term" placeholder="검색어">
            <select name="action"><option value="alias">별칭</option><option value="disambiguation">동음이의</option><option value="boost">우선</option><option value="ignore">무시</option></select>
            <input name="targetPageRef" placeholder="대상 문서 제목 또는 번호">
            <input name="replacement" placeholder="대체 검색어">
            <input name="note" placeholder="운영 메모">
            <button>사전 추가</button>
          </form>
          ${componentTableMarkup(`<thead><tr><th>검색어</th><th>동작</th><th>대상</th><th>메모</th><th>상태</th></tr></thead><tbody>${dictionaryRows || emptyTableRow(5, '검색 사전 항목 없음', '반복 실패 검색어를 처리하면 사전에 남아 다음 검색 품질을 안정화합니다.')}</tbody>`)}
        </section>
      </section>
    </main>`,
    user,
    'admin'
  );
}

function aliasTypeLabel(value: unknown) {
  const labels: Record<string, string> = {
    alias: '별칭',
    redirect: '넘겨주기',
    typo: '오탈자',
    english: '영문 표기',
    korean_alt: '한글 표기',
    search: '검색 보정'
  };
  return labels[String(value ?? '')] ?? String(value ?? '별칭');
}

export function modVerificationPage(tasks: any[], assignees: any[], user: CurrentUser | null) {
  const openCount = tasks.filter((task) => String(task.status ?? 'open') === 'open').length;
  const inProgressCount = tasks.filter((task) => String(task.status ?? '') === 'in_progress').length;
  const doneCount = tasks.filter((task) => String(task.status ?? '') === 'done').length;
  const unassignedCount = tasks.filter((task) => !task.assigned_to).length;
  const summaryCards = [
    ['열린 검증', openCount, '아직 담당자가 확인하지 않은 모드 작업입니다.'],
    ['진행 중', inProgressCount, '링크와 버전 정보를 확인 중인 작업입니다.'],
    ['완료', doneCount, '검증 메모와 함께 마감된 작업입니다.'],
    ['미배정', unassignedCount, '담당자를 지정해야 하는 작업입니다.']
  ]
    .map(([label, value, detail]) => `<span><strong>${escapeHtml(String(value))}</strong>${escapeHtml(String(label))}<small>${escapeHtml(String(detail))}</small></span>`)
    .join('');
  const rows = tasks
    .map(
      (task) => `<tr>
        <td data-label="모드"><a href="${wikiUrl('mod', task.title)}">${escapeHtml(task.title)}</a><small>${escapeHtml(taskTypeLabel(task.task_type))}</small></td>
        <td data-label="상태">${escapeHtml(genericStatusLabel(String(task.status ?? 'open')))}</td>
        <td data-label="담당자">${escapeHtml(task.assigned_display_name ?? task.assigned_username ?? '미배정')}</td>
        <td data-label="기한">${escapeHtml(formatDateTime(task.due_at, '미정'))}</td>
        <td data-label="메모">${escapeHtml(task.note ?? '')}</td>
        <td data-label="처리">
          <form class="inline-form" method="post" action="/admin/mod-verification/${escapeHtml(String(task.id))}">
            <select name="assignedTo">
              <option value="">미배정</option>
              ${assignees.map((assignee) => `<option value="${escapeHtml(String(assignee.id))}"${Number(task.assigned_to) === Number(assignee.id) ? ' selected' : ''}>${escapeHtml(assignee.display_name ?? assignee.username)}</option>`).join('')}
            </select>
            <select name="status">
              ${['open', 'in_progress', 'done', 'skipped'].map((status) => option(status, task.status, genericStatusLabel(status))).join('')}
            </select>
            <input name="note" value="${escapeHtml(task.note ?? '')}" placeholder="검증 메모">
            <button>저장</button>
          </form>
        </td>
      </tr>`
    )
    .join('');
  return layout(
    '모드 검증',
    `<main class="admin admin-mod-verification-page">
      <section class="admin-hero">
        <div>
          <span class="space-badge">관리</span>
          <h1>모드 검증</h1>
          <p>오래된 모드 문서, 링크 검증, 담당자 배정 상태를 확인합니다.</p>
        </div>
        <div class="quick-actions"><a class="button ghost" href="/mods">모드</a><a class="button ghost" href="/admin/work">업무 큐</a></div>
      </section>
      <section class="audit-summary mod-verification-summary">${summaryCards}</section>
      <section class="admin-guide-panel mod-verification-guide">
        <div>
          <strong>모드 검증 순서</strong>
          <p>모드 검증은 사용자에게 노출되는 공식 링크, 지원 버전, 제작자 정보가 신뢰 가능한지 확인하는 절차입니다. 오래된 문서와 링크 문제를 먼저 잡고 검증 메모를 남깁니다.</p>
        </div>
        <ol>
          <li><strong>대상 생성</strong><span>오래된 모드 작업 생성을 눌러 검증이 필요한 문서를 큐에 올립니다.</span></li>
          <li><strong>링크/버전 확인</strong><span>모드 문서를 열어 공식 링크, 소스, 로더, 지원 버전이 현재 정보와 맞는지 봅니다.</span></li>
          <li><strong>상태 마감</strong><span>확인 중이면 진행 중, 끝났으면 완료, 검증 대상이 아니면 건너뜀으로 기록합니다.</span></li>
        </ol>
      </section>
      <section class="admin-panel">
        <h2>검증 작업 생성</h2>
        <form class="inline-form" method="post" action="/admin/mod-verification/generate">
          <button>오래된 모드 작업 생성</button>
        </form>
      </section>
      <section class="admin-panel">
        <h2>작업 목록</h2>
        ${componentTableMarkup(`<thead><tr><th>모드</th><th>상태</th><th>담당자</th><th>기한</th><th>메모</th><th>처리</th></tr></thead><tbody>${rows || emptyTableRow(6, '검증할 모드 작업 없음', '오래된 모드 문서나 링크 점검이 필요하면 위 버튼으로 작업을 생성합니다.', '/mods', '모드 목록 보기')}</tbody>`)}
      </section>
    </main>`,
    user,
    'admin'
  );
}

function table(title: string, rows: Record<string, unknown>[], id = '') {
  const hiddenKeys = new Set(['id', 'target_id', 'entity_id']);
  const keys = Object.keys(rows[0] ?? {}).filter((key) => !hiddenKeys.has(key));
  const idAttr = id ? ` id="${escapeHtml(id)}"` : '';
  if (!rows.length || !keys.length) return `<div class="admin-panel"${idAttr}><h2>${title}</h2><div class="empty-state compact"><strong>${escapeHtml(title)} 없음</strong><p>${escapeHtml(adminEmptyPanelMessage(title))}</p></div></div>`;
  return `<div class="admin-panel"${idAttr}><h2>${title}</h2>${componentTableMarkup(`<thead><tr>${keys.map((key) => `<th>${escapeHtml(adminColumnLabel(key))}</th>`).join('')}</tr></thead><tbody>${rows
    .map((row) => `<tr>${keys.map((key) => `<td data-label="${escapeHtml(adminColumnLabel(key))}">${escapeHtml(adminTableValue(key, row[key]))}</td>`).join('')}</tr>`)
    .join('')}</tbody>`, 'admin-summary-table')}</div>`;
}

function adminEmptyPanelMessage(title: string) {
  const messages: Record<string, string> = {
    '관리자 업무': '신고, 검토, 인증처럼 운영자가 처리할 일이 생기면 이 패널에 표시됩니다.',
    '신고': '열린 신고가 없으면 문서와 파일 신고 대기열은 비어 있습니다.',
    '사용자': '최근 가입 또는 관리 대상 사용자가 있으면 상태와 함께 표시됩니다.',
    '관리 로그': '관리자가 수행한 주요 처리 내역이 있으면 시간순으로 표시됩니다.'
  };
  return messages[title] ?? '표시할 항목이 생기면 이 패널에 표 형식으로 표시됩니다.';
}

function adminTableValue(key: string, value: unknown) {
  if (key === 'page_id') return adminPageRefLabel(value);
  if (key === 'work_type') return adminWorkTypeLabel(String(value ?? ''));
  if (key === 'priority') return priorityLabel(value);
  if (key === 'status') return genericStatusLabel(String(value ?? 'open'));
  if (key === 'target_type' || key === 'entity_type') return targetTypeLabel(value);
  if (key === 'target_id' || key === 'entity_id') return value ? `#${String(value)}` : '';
  if (key === 'action') return adminActionLabel(value);
  if (key === 'role') return roleLabel(value);
  return formatDisplayValue(key, value);
}

function adminActionLabel(value: unknown) {
  const key = String(value ?? '');
  const labels: Record<string, string> = {
    'server.permissions': '서버 권한 변경',
    'server_owner.revoke': '서버 운영자 해지',
    'mod_verification.complete': '모드 검증 완료',
    'revision.hide': '판 숨김',
    'revision.unhide': '판 숨김 해제',
    'page.protect': '문서 보호',
    'page.delete': '문서 삭제',
    'report.resolve': '신고 처리'
  };
  return labels[key] ?? key.replace(/[._]/g, ' ');
}

function adminColumnLabel(key: string) {
  const labels: Record<string, string> = {
    id: '번호',
    page_id: '문서',
    work_type: '업무 유형',
    target_type: '대상',
    target_id: '대상',
    priority: '우선순위',
    status: '상태',
    assigned_to: '담당자',
    created_at: '생성',
    updated_at: '수정',
    report_reason: '신고 사유',
    report_status: '신고 상태',
    reporter_name: '신고자',
    target_label: '대상',
    username: '계정',
    display_name: '표시 이름',
    email: '이메일',
    role: '역할',
    action: '작업',
    entity_type: '대상 종류',
    entity_id: '대상',
    actor: '수행자'
  };
  return labels[key] ?? key.replace(/_/g, ' ');
}

function safeJson<T>(value: string | T[] | null): T[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    return JSON.parse(value);
  } catch {
    return [];
  }
}

function safeObject(value: unknown): Record<string, any> {
  try {
    return JSON.parse(String(value ?? '{}'));
  } catch {
    return {};
  }
}
