export function decodeWikiRouteSegment(segment) {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function buildWikiRoutePath(prefix, segments = []) {
  const suffix = segments.map(decodeWikiRouteSegment).join('/');
  return `/${prefix}${suffix ? `/${suffix}` : '/대문'}`;
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
