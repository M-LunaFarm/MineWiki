export function decodeWikiRouteSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function buildWikiRoutePath(prefix, segments = []) {
  const suffix = segments.map(decodeWikiRouteSegment).join('/');
  const base = prefix === 'category' ? '/wiki/category' : `/${prefix}`;
  return `${base}${suffix ? `/${suffix}` : '/대문'}`;
}

export const CATEGORY_WIKI_TOOLS = Object.freeze(['edit', 'history']);

export function buildCategoryWikiToolPath(routePath, tool) {
  if (!CATEGORY_WIKI_TOOLS.includes(tool)) {
    throw new Error(`Unsupported category wiki tool: ${tool}`);
  }
  const prefix = '/wiki/category/';
  if (!routePath.startsWith(prefix)) {
    throw new Error(`Not a category wiki route: ${routePath}`);
  }
  const documentPath = routePath.slice(prefix.length);
  if (!documentPath || documentPath.startsWith('_tools/')) {
    throw new Error(`Invalid category document route: ${routePath}`);
  }
  return `${prefix}_tools/${tool}/${documentPath}`;
}

export const SERVER_WIKI_TOOLS = Object.freeze([
  'raw',
  'backlinks',
  'discuss',
  'requests',
  'blame',
  'acl',
  'edit',
  'history',
]);

export function parseServerWikiToolRoute(segments = []) {
  if (segments.length < 3 || segments[1] !== '_tools' || !SERVER_WIKI_TOOLS.includes(segments[2])) {
    return null;
  }
  return {
    tool: segments[2],
    documentSegments: [segments[0], ...segments.slice(3)],
  };
}

export function buildServerWikiToolPath(routePath, tool) {
  if (!SERVER_WIKI_TOOLS.includes(tool)) {
    throw new TypeError(`Unknown server wiki tool: ${tool}`);
  }
  const match = /^\/server\/([^/]+)(?:\/(.*))?$/.exec(routePath);
  if (!match) {
    throw new TypeError(`Not a server wiki route: ${routePath}`);
  }
  const documentPath = match[2] ? `/${match[2]}` : '';
  return `/server/${match[1]}/_tools/${tool}${documentPath}`;
}
