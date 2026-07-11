export function buildApiTargetUrl(baseUrl, path, search = '') {
  const target = new URL(baseUrl);
  target.pathname = `${target.pathname.replace(/\/+$/, '')}/${path
    .map((segment) => encodeURIComponent(segment))
    .join('/')}`;
  target.search = search;
  return target;
}
