import type { CurrentUser } from '../auth.js';
import { escapeHtml } from '../wiki/markup.js';

export function navActiveSpace(currentSpace: string) {
  return currentSpace === 'modpack'
    ? 'mod'
    : ['guide', 'data', 'help', 'project', 'special', 'template', 'file', 'user'].includes(currentSpace)
      ? 'main'
      : currentSpace;
}

export function pageIntentStrip(title: string, currentSpace: string, user: CurrentUser | null, isAdminLayout: boolean) {
  const escapedTitle = escapeHtml(title);
  const spaceLabel = currentSpaceLabel(currentSpace, isAdminLayout);
  const links = pageIntentLinks(currentSpace, user, isAdminLayout)
    .map(([href, label]) => `<a href="${escapeHtml(href)}">${escapeHtml(label)}</a>`)
    .join('');
  return `<nav class="page-intent-strip${isAdminLayout ? ' admin-intent-strip' : ''}" aria-label="현재 화면 바로가기">
    <span class="intent-context">${escapeHtml(spaceLabel)}</span>
    <span class="intent-title">${escapedTitle}</span>
    <span class="intent-links">${links}</span>
  </nav>`;
}

export function pageIntentLinks(currentSpace: string, user: CurrentUser | null, isAdminLayout: boolean): Array<[string, string]> {
  if (isAdminLayout) {
    return [
      ['/admin/work', '검토 큐'],
      ['/admin/reports', '신고'],
      ['/admin/audits', '감사'],
      ['/admin/release', '공개 준비']
    ];
  }
  const canModerate = canAccessAdminTools(user);
  const canVerifyMods = Boolean(user?.permissions.includes('mod.verify') || canModerate);
  const loggedInDefaults: Array<[string, string]> = [
    ['/me', '내 위키'],
    ['/watchlist', '감시문서'],
    ['/tasks', '작업'],
    ['/new', '새 문서']
  ];
  const publicDefaults: Array<[string, string]> = [
    ['/wiki', '위키 대문'],
    ['/search', '검색'],
    ['/mods', '모드'],
    ['/servers', '서버']
  ];
  const spaceLinks: Record<string, Array<[string, string]>> = {
    mod: [
      ['/mods', '모드 목록'],
      ['/mods/new', '모드 위키 만들기'],
      ['/new/mod-page', '모드 문서 추가'],
      [canVerifyMods ? '/admin/mod-verification' : '/search?space=mod', canVerifyMods ? '모드 검증' : '모드 검색']
    ],
    modpack: [
      ['/mods', '모드 목록'],
      ['/mods/new', '모드팩 위키 만들기'],
      ['/new/mod-page', '모드팩 문서 추가'],
      [canVerifyMods ? '/admin/mod-verification' : '/search?space=mod', canVerifyMods ? '모드 검증' : '모드 검색']
    ],
    server: [
      ['/servers', '서버 목록'],
      ['/servers/new', '서버 위키 신청'],
      [user ? '/my/servers' : '/login?next=%2Fmy%2Fservers', '내 서버'],
      ['/new/server-page', '서버 문서 추가']
    ],
    dev: [
      ['/dev', '개발 대문'],
      ['/new/dev', '개발 문서 만들기'],
      ['/search?space=dev', '개발 문서 검색'],
      ['/help/위키_문법', '문법 도움말']
    ],
    guide: [
      ['/wiki/가이드/처음_시작하기', '처음 시작'],
      ['/new/wiki?namespace=guide', '가이드 만들기'],
      ['/search?space=guide', '가이드 검색'],
      ['/help/위키_문법', '문법 도움말']
    ],
    data: [
      ['/wiki/데이터', '데이터 대문'],
      ['/new/wiki?namespace=data', '데이터 문서 만들기'],
      ['/search?space=data', '데이터 검색'],
      ['/special/needed-pages', '필요 문서']
    ],
    file: [
      ['/file', '파일 홈'],
      ['/file/upload', '파일 업로드'],
      [canModerate ? '/admin/files' : '/help/파일_업로드', canModerate ? '파일 관리' : '업로드 기준'],
      ['/special/needed-pages', '필요 문서']
    ],
    help: [
      ['/help/처음_편집하기', '처음 편집하기'],
      ['/help/위키_문법', '위키 문법'],
      ['/help/파일_업로드', '파일 도움말'],
      ['/new', '새 문서']
    ],
    project: [
      ['/project', '프로젝트 홈'],
      ['/special/page-requests', '작성 요청'],
      ['/tasks', '정비 작업'],
      ['/recent', '최근 바뀜']
    ],
    template: [
      ['/template', '틀 홈'],
      ['/templates/new', '틀 만들기'],
      ['/search?space=template', '틀 검색'],
      ['/new', '새 문서']
    ],
    user: [
      [user ? '/me' : '/login', user ? '내 위키' : '로그인'],
      ['/watchlist', '감시문서'],
      ['/tasks', '작업'],
      ['/new', '새 문서']
    ],
    special: [
      ['/special', '특수 문서'],
      ['/special/needed-pages', '필요 문서'],
      ['/special/page-requests', '작성 요청'],
      ['/special/revision-search', '리비전 검색']
    ]
  };
  return spaceLinks[currentSpace] ?? (user ? loggedInDefaults : publicDefaults);
}

export function currentSpaceLabel(currentSpace: string, isAdminLayout: boolean) {
  if (isAdminLayout) return '관리';
  const labels: Record<string, string> = {
    main: '위키',
    mod: '모드',
    modpack: '모드',
    server: '서버',
    dev: '개발',
    file: '파일',
    help: '도움말',
    guide: '가이드',
    data: '데이터',
    project: '프로젝트',
    special: '특수',
    template: '틀',
    user: '사용자'
  };
  return labels[currentSpace] ?? '위키';
}

export function userRoleChrome(user: CurrentUser | null) {
  const groups = user?.groups ?? [];
  const permissions = user?.permissions ?? [];
  if (groups.includes('developer')) {
    return { label: '개발자', title: '개발자 권한으로 관리와 시스템 도구를 사용할 수 있습니다.', bodyClass: 'role-developer' };
  }
  if (groups.includes('admin') || permissions.includes('report.handle')) {
    return { label: '관리자', title: '관리자 권한으로 신고, 검토, 운영 도구를 사용할 수 있습니다.', bodyClass: 'role-admin' };
  }
  if (permissions.includes('mod.verify')) {
    return { label: '모드 검증', title: '모드 링크와 버전 정보를 검증할 수 있습니다.', bodyClass: 'role-reviewer' };
  }
  if (groups.includes('server_owner') || permissions.includes('server.official_edit')) {
    return { label: '서버 운영자', title: '서버 위키 공식 영역과 운영자 문서를 관리할 수 있습니다.', bodyClass: 'role-server-owner' };
  }
  if (groups.some((group) => ['trusted', 'moderator', 'autoconfirmed'].includes(group))) {
    return { label: '인증 사용자', title: '일부 보호 문서를 더 빠르게 편집할 수 있습니다.', bodyClass: 'role-trusted' };
  }
  return { label: '로그인', title: '내 문서, 감시문서, 작업 목록을 사용할 수 있습니다.', bodyClass: 'role-member' };
}

export function canAccessAdminTools(user: CurrentUser | null) {
  return Boolean(user?.permissions.includes('report.handle') || user?.groups.includes('admin') || user?.groups.includes('developer'));
}

export function pageTitle(title: string, currentSpace: string) {
  const suffix: Record<string, string> = {
    mod: 'MineWiki 모드',
    modpack: 'MineWiki 모드팩',
    server: 'MineWiki 서버',
    dev: 'MineWiki 개발',
    guide: 'MineWiki 가이드',
    data: 'MineWiki 데이터',
    main: 'MineWiki',
    help: 'MineWiki 도움말',
    project: 'MineWiki 프로젝트',
    template: 'MineWiki 틀',
    file: 'MineWiki 파일',
    admin: 'MineWiki 관리'
  };
  return `${title} - ${suffix[currentSpace] ?? 'MineWiki'}`;
}
