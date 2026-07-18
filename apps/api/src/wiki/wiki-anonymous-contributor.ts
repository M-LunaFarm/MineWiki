import { createHash, randomBytes } from 'node:crypto';
import { parse, serialize } from 'cookie';

export const WIKI_ANONYMOUS_CONTRIBUTOR_COOKIE = '__Host-mw_wiki_contributor';
export const WIKI_ANONYMOUS_CONTRIBUTOR_TTL_SECONDS = 60 * 60 * 24 * 180;

export function createWikiAnonymousContributorToken(): string {
  return randomBytes(32).toString('base64url');
}

export function wikiAnonymousContributorDigest(token: string): string | null {
  if (!/^[A-Za-z0-9_-]{43}$/u.test(token)) return null;
  return createHash('sha256').update(`minewiki:anonymous-contributor:v1:${token}`).digest('hex');
}

export function readWikiAnonymousContributorToken(cookieHeader?: string): string | null {
  if (!cookieHeader) return null;
  const token = parse(cookieHeader)[WIKI_ANONYMOUS_CONTRIBUTOR_COOKIE];
  return token && wikiAnonymousContributorDigest(token) ? token : null;
}

export function serializeWikiAnonymousContributorCookie(token: string): string {
  return serialize(WIKI_ANONYMOUS_CONTRIBUTOR_COOKIE, token, {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: WIKI_ANONYMOUS_CONTRIBUTOR_TTL_SECONDS,
  });
}

export function clearWikiAnonymousContributorCookie(): string {
  return serialize(WIKI_ANONYMOUS_CONTRIBUTOR_COOKIE, '', {
    httpOnly: true,
    secure: true,
    sameSite: 'lax',
    path: '/',
    maxAge: 0,
  });
}
