import { NextResponse, type NextRequest } from 'next/server';
import { resolveLegacyRedirect } from './lib/legacy-redirects.mjs';

export function middleware(request: NextRequest) {
  const redirect = resolveLegacyRedirect(request.nextUrl);
  if (!redirect) {
    return NextResponse.next();
  }

  const target = new URL(redirect.destination, request.url);
  return NextResponse.redirect(target, redirect.status);
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|assets|cdn).*)']
};
