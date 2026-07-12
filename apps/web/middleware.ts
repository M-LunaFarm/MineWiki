import { NextResponse, type NextRequest } from 'next/server';
import { resolveLegacyRedirect } from './lib/legacy-redirects.mjs';

export function middleware(request: NextRequest) {
  const redirect = resolveLegacyRedirect(request.nextUrl);
  if (!redirect) {
    return NextResponse.next();
  }

  // Reverse proxies expose the internal Next.js origin through request.url.
  // Build redirects from the configured public origin so Location never leaks localhost.
  const publicOrigin = process.env.NEXT_PUBLIC_SITE_URL?.trim() || request.nextUrl.origin;
  const target = new URL(redirect.destination, publicOrigin);
  return NextResponse.redirect(target, redirect.status);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|assets|cdn).*)']
};
