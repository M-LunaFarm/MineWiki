interface ServerRouteTarget {
  readonly id?: string | null;
  readonly shortCode?: string | null;
  readonly joinHost?: string | null;
  readonly name?: string | null;
}

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const UUID_AT_END_PATTERN =
  /(?:^|--)([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i;
const SHORT_CODE_PATTERN = /^[a-z0-9]{5,12}$/;

export function buildServerPath(server: ServerRouteTarget): string {
  const shortCode = normalizeShortCode(server.shortCode);
  if (shortCode) {
    return `/servers/${shortCode}`;
  }

  if (!server.id) {
    return '/servers';
  }

  return `/servers/${buildServerRouteId(server)}`;
}

export function buildServerRouteId(server: ServerRouteTarget): string {
  const slug = buildServerSlug(server);
  return server.id ? `${slug}--${server.id.toLowerCase()}` : slug;
}

export function resolveServerRouteId(routeId: string): string {
  const decodedRouteId = decodeRouteSegment(routeId).trim();
  if (UUID_PATTERN.test(decodedRouteId)) {
    return decodedRouteId.toLowerCase();
  }

  const match = decodedRouteId.match(UUID_AT_END_PATTERN);
  if (match) {
    return match[1].toLowerCase();
  }

  const shortCode = normalizeShortCode(decodedRouteId);
  return shortCode || decodedRouteId;
}

function buildServerSlug(server: ServerRouteTarget): string {
  const source = normalizeHost(server.joinHost) || server.name?.trim() || 'server';
  const slug = source
    .normalize('NFKD')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');

  return slug || 'server';
}

function normalizeHost(host?: string | null): string {
  const value = host?.trim();
  if (!value) {
    return '';
  }

  const withoutProtocol = value.replace(/^[a-z][a-z0-9+.-]*:\/\//i, '');
  const withoutPath = withoutProtocol.split(/[/?#]/, 1)[0] ?? '';
  const withoutPort = withoutPath.replace(/^\[([^\]]+)\](?::\d+)?$/, '$1').replace(/:\d+$/, '');

  return withoutPort;
}

function normalizeShortCode(shortCode?: string | null): string {
  const normalized = shortCode?.trim().toLowerCase() ?? '';
  return SHORT_CODE_PATTERN.test(normalized) ? normalized : '';
}

function decodeRouteSegment(routeId: string): string {
  try {
    return decodeURIComponent(routeId);
  } catch {
    return routeId;
  }
}
