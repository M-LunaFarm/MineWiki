import { NextResponse, type NextRequest } from 'next/server';
import { resolveLegacyRedirect } from './lib/legacy-redirects.mjs';
import {
  CUSTOM_DOMAIN_HOST_HEADER,
  CUSTOM_DOMAIN_SITE_SLUG_HEADER,
} from './lib/server-wiki-public-route';

const SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/u;
const INTERNAL_PREFIXES = ['/api', '/auth', '/login', '/me', '/admin', '/servers', '/wiki', '/serverWiki'] as const;

export async function middleware(request: NextRequest) {
  const requestHeaders = new Headers(request.headers);
  requestHeaders.delete(CUSTOM_DOMAIN_HOST_HEADER);
  requestHeaders.delete(CUSTOM_DOMAIN_SITE_SLUG_HEADER);
  const hostname = normalizeRequestHostname(request.headers.get('host'));
  if (hostname && !platformHostnames().has(hostname)) {
    return routeCustomDomainRequest(request, requestHeaders, hostname);
  }

  const redirect = resolveLegacyRedirect(request.nextUrl);
  if (!redirect) {
    return NextResponse.next({ request: { headers: requestHeaders } });
  }

  // Reverse proxies expose the internal Next.js origin through request.url.
  // Build redirects from the configured public origin so Location never leaks localhost.
  const publicOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin;
  const target = new URL(redirect.destination, publicOrigin);
  return NextResponse.redirect(target, redirect.status);
}

async function routeCustomDomainRequest(
  request: NextRequest,
  requestHeaders: Headers,
  hostname: string,
): Promise<NextResponse> {
  if (request.method !== 'GET' && request.method !== 'HEAD') return customDomainNotFound();
  const pathname = request.nextUrl.pathname;
  if (INTERNAL_PREFIXES.some((prefix) => pathname === prefix || pathname.startsWith(`${prefix}/`))) {
    return customDomainNotFound();
  }

  const route = await resolveCustomDomain(hostname);
  if (!route) return customDomainNotFound();
  const publicOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://minewiki.kr';
  if (pathname === '/_tools' || pathname.startsWith('/_tools/')) {
    const destination = new URL(`/serverWiki/${encodeURIComponent(route.siteSlug)}${pathname}`, publicOrigin);
    destination.search = request.nextUrl.search;
    return NextResponse.redirect(destination, 307);
  }

  // Custom hosts are anonymous, published-document surfaces. Never forward credentials
  // or accept tenant markers supplied by the internet-facing request.
  for (const header of ['authorization', 'cookie', 'x-csrf-token', 'x-forwarded-user']) {
    requestHeaders.delete(header);
  }
  requestHeaders.set(CUSTOM_DOMAIN_HOST_HEADER, hostname);
  requestHeaders.set(CUSTOM_DOMAIN_SITE_SLUG_HEADER, route.siteSlug);

  const target = request.nextUrl.clone();
  const suffix = pathname === '/' ? '' : pathname;
  target.pathname = `/serverWiki/${encodeURIComponent(route.siteSlug)}${suffix}`;
  return NextResponse.rewrite(target, { request: { headers: requestHeaders } });
}

async function resolveCustomDomain(hostname: string): Promise<{ readonly siteSlug: string } | null> {
  const apiBase = (process.env.INTERNAL_API_BASE_URL?.trim() || 'http://127.0.0.1:4321').replace(/\/+$/u, '');
  try {
    const response = await fetch(`${apiBase}/v1/wiki/domain-routes/${encodeURIComponent(hostname)}`, {
      cache: 'no-store',
      headers: { accept: 'application/json' },
    });
    if (!response.ok) return null;
    const body = await response.json() as { siteSlug?: unknown };
    return typeof body.siteSlug === 'string' && SITE_SLUG_PATTERN.test(body.siteSlug)
      ? { siteSlug: body.siteSlug }
      : null;
  } catch {
    return null;
  }
}

function normalizeRequestHostname(host: string | null): string | null {
  if (!host) return null;
  const value = host.trim().toLowerCase().replace(/\.+$/u, '');
  if (!value || /[\s/@\\\p{Cc}\p{Cf}]/u.test(value)) return null;
  if (value.startsWith('[')) {
    const end = value.indexOf(']');
    return end > 0 ? value.slice(1, end) : null;
  }
  return value.replace(/:\d+$/u, '');
}

function platformHostnames(): ReadonlySet<string> {
  const hosts = new Set(['minewiki.kr', 'www.minewiki.kr', 'localhost', '127.0.0.1', '::1']);
  try {
    const configured = new URL(process.env.NEXT_PUBLIC_SITE_URL?.trim() || 'https://minewiki.kr').hostname.toLowerCase();
    hosts.add(configured);
    if (configured.startsWith('www.')) hosts.add(configured.slice(4));
    else hosts.add(`www.${configured}`);
  } catch {
    // The deployment validator reports malformed public origins; fail closed here.
  }
  return hosts;
}

function customDomainNotFound(): NextResponse {
  return new NextResponse('Not Found', {
    status: 404,
    headers: {
      'cache-control': 'private, no-store',
      'content-type': 'text/plain; charset=utf-8',
      'x-robots-tag': 'noindex, nofollow',
    },
  });
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|assets|cdn).*)']
};
