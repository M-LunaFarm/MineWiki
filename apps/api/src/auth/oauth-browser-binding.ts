import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { parse, serialize } from 'cookie';

export const OAUTH_BROWSER_COOKIE = '__Host-mw_oauth_browser';
const OAUTH_BROWSER_TTL_SECONDS = 15 * 60;
const BINDING_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function readOAuthBrowserBinding(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  const value = parse(cookieHeader)[OAUTH_BROWSER_COOKIE];
  return value && BINDING_PATTERN.test(value) ? value : undefined;
}

export function issueOAuthBrowserBinding(cookieHeader?: string): {
  readonly value: string;
  readonly cookie: string;
} {
  const value = readOAuthBrowserBinding(cookieHeader) ?? randomBytes(32).toString('base64url');
  return {
    value,
    cookie: serialize(OAUTH_BROWSER_COOKIE, value, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'lax',
      maxAge: OAUTH_BROWSER_TTL_SECONDS
    })
  };
}

export function hashOAuthBrowserBinding(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function matchesOAuthBrowserBinding(value: string, expectedHash: string): boolean {
  const actual = Buffer.from(hashOAuthBrowserBinding(value), 'hex');
  const expected = Buffer.from(expectedHash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}
