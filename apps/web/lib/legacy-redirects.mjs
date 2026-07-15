const WIKI_NAMESPACE_REDIRECTS = new Map([
  ['서버', 'server'],
  ['모드', 'mod'],
  ['모드팩', 'modpack'],
  ['개발', 'dev'],
  ['도움말', 'help'],
  ['프로젝트', 'project'],
  ['파일', 'file']
]);

const GUILD_DETAIL_LEGACY_TABS = new Set([
  'actions',
  'logs',
  'members',
  'messages',
  'routing',
  'servers'
]);

const NAMESPACE_FRONT_PAGES = new Map([
  ['/mod', '/mod/대문'],
  ['/dev', '/dev/대문'],
  ['/guide', '/guide/대문'],
  ['/data', '/data/대문'],
  ['/help', '/help/대문'],
  ['/project', '/project/대문'],
  ['/template', '/template/대문'],
  ['/file', '/file/대문']
]);

export function resolveLegacyRedirect(urlLike) {
  const pathname = normalizePathname(urlLike.pathname);
  const search = urlLike.search ?? '';
  const segments = pathname.split('/').filter(Boolean);
  const decoded = segments.map(decodePathSegment);
  const head = decoded[0]?.toLowerCase();

  if (pathname === '/wiki') {
    return permanent('/wiki/대문', search);
  }

  if (decoded[0] === 'wiki' && decoded[1] && WIKI_NAMESPACE_REDIRECTS.has(decoded[1])) {
    const canonicalPrefix = WIKI_NAMESPACE_REDIRECTS.get(decoded[1]);
    const rest = segments.slice(2).join('/');
    return permanent(rest ? `/${canonicalPrefix}/${rest}` : `/${canonicalPrefix}`, search);
  }

  if (head === 'develop') {
    return permanent(rewritePrefix('dev', segments.slice(1)), search);
  }

  if (head === 'files') {
    return permanent(rewritePrefix('file', segments.slice(1)), search);
  }

  if (head === 'file' && segments.length >= 3 && decoded.at(-1)?.toLowerCase() === 'raw') {
    return permanent(rewritePrefix('file', segments.slice(1, -1)), search);
  }

  if (pathname === '/server') {
    return permanent('/servers', search);
  }

  if (pathname === '/servers/new') {
    return temporary('/servers/register', search);
  }

  if (pathname === '/servers/import') {
    return temporary('/servers/register', mergeSearch(search, 'import=1'));
  }

  if (pathname === '/mods') {
    return permanent('/mod/대문', search);
  }

  if (pathname === '/mods/new') {
    return temporary('/mod', search);
  }

  if (NAMESPACE_FRONT_PAGES.has(pathname)) {
    return permanent(NAMESPACE_FRONT_PAGES.get(pathname), search);
  }

  if (pathname === '/modpack') {
    return permanent('/modpack/대문', search);
  }

  if (segments.length >= 3 && head === 'server' && decoded[2]?.toLowerCase() === 'manage') {
    return temporary('/dashboard', mergeSearch(search, `server=${encodeURIComponent(decoded[1])}`));
  }

  if (segments.length >= 3 && head === 'server' && decoded[2]?.toLowerCase() === 'claim') {
    return temporary('/claim', mergeSearch(search, `server=${encodeURIComponent(decoded[1])}`));
  }

  if (segments.length >= 3 && head === 'server' && decoded[2]?.toLowerCase() === 'export') {
    return permanent(`/server/${segments[1]}`, search);
  }

  if (segments.length >= 3 && head === 'mod' && decoded[2]?.toLowerCase() === 'manage') {
    return temporary(`/mod/${segments[1]}`, search);
  }

  if (pathname === '/verify') {
    return temporary('/me', mergeSearch(search, 'verifyMigration=legacy'));
  }

  if (head === 'verify' && segments[1]) {
    return temporary('/me', mergeSearch(search, `verifySessionId=${encodeURIComponent(decoded[1])}`));
  }

  if (pathname === '/verify-email') {
    return temporary('/auth', search);
  }

  if (pathname === '/join') {
    return temporary('/auth', mergeSearch(search, 'mode=register'));
  }

  if (pathname === '/forgot-password') {
    return temporary('/login/forgot-password', search);
  }

  if (pathname === '/reset-password') {
    return temporary('/login/reset-password', search);
  }

  if (pathname === '/auth/discord') {
    return temporary('/auth', search);
  }

  if (pathname === '/auth/discord/callback') {
    return temporary('/auth/callback/discord', search);
  }

  if (pathname === '/auth/microsoft') {
    return temporary('/me', search);
  }

  if (pathname === '/auth/microsoft/callback') {
    return temporary('/minecraft/callback', search);
  }

  if (pathname === '/auth/microsoft/result') {
    return temporary('/me', search);
  }

  if (pathname === '/logout') {
    return temporary('/me', search);
  }

  if (pathname === '/guilds/select') {
    return temporary('/guilds', search);
  }

  if (head === 'guilds' && segments.length >= 3 && GUILD_DETAIL_LEGACY_TABS.has(decoded[2]?.toLowerCase())) {
    return temporary(`/guilds/${segments[1]}`, search);
  }

  if (pathname === '/privacy') {
    return permanent('/policies/privacy', search);
  }

  if (pathname === '/terms') {
    return permanent('/policies/terms', search);
  }

  if (pathname === '/info') {
    return permanent('/support', search);
  }

  return null;
}

function permanent(destination, search) {
  return { destination: appendSearch(destination, search), status: 301 };
}

function temporary(destination, search) {
  return { destination: appendSearch(destination, search), status: 302 };
}

function rewritePrefix(prefix, restSegments) {
  const rest = restSegments.join('/');
  return rest ? `/${prefix}/${rest}` : `/${prefix}`;
}

function normalizePathname(pathname) {
  if (!pathname || pathname === '/') {
    return '/';
  }
  return pathname.length > 1 ? pathname.replace(/\/+$/g, '') : pathname;
}

function decodePathSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

function appendSearch(destination, search) {
  if (!search) {
    return destination;
  }
  return `${destination}${destination.includes('?') ? '&' : '?'}${search.replace(/^\?/, '')}`;
}

function mergeSearch(search, extra) {
  const cleanSearch = search.replace(/^\?/, '');
  if (!cleanSearch) {
    return `?${extra}`;
  }
  return `?${cleanSearch}&${extra}`;
}
