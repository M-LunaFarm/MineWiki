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
