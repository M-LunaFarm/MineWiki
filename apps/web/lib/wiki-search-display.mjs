const NAMESPACE_LABELS = new Map([
  ['main', '일반'],
  ['server', '서버 위키'],
  ['mod', '모드'],
  ['modpack', '모드팩'],
  ['dev', '개발'],
  ['help', '도움말'],
  ['project', '프로젝트'],
  ['template', '틀'],
  ['file', '파일'],
]);

export function formatWikiNamespace(namespace) {
  return NAMESPACE_LABELS.get(namespace) ?? namespace;
}

export function formatWikiResultPath(routePath) {
  return routePath.split('/').map((segment) => {
    try {
      return decodeURIComponent(segment).replaceAll('_', ' ');
    } catch {
      return segment.replaceAll('_', ' ');
    }
  }).join('/');
}

export function isMissingServerWikiRoot(pathname) {
  return /^\/serverWiki\/[^/]+\/?$/u.test(pathname);
}
