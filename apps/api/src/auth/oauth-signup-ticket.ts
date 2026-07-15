import { createHash, randomBytes } from 'node:crypto';
import { parse, serialize } from 'cookie';

export const OAUTH_SIGNUP_COOKIE = '__Host-mw_oauth_signup';
const OAUTH_SIGNUP_TTL_SECONDS = 10 * 60;
const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/u;

export function issueOAuthSignupTicket(): { readonly token: string; readonly hash: string; readonly cookie: string } {
  const token = randomBytes(32).toString('base64url');
  return {
    token,
    hash: hashOAuthSignupTicket(token),
    cookie: serialize(OAUTH_SIGNUP_COOKIE, token, {
      path: '/',
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      maxAge: OAUTH_SIGNUP_TTL_SECONDS
    })
  };
}

export function readOAuthSignupTicket(cookieHeader?: string): string | undefined {
  if (!cookieHeader) return undefined;
  const token = parse(cookieHeader)[OAUTH_SIGNUP_COOKIE];
  return token && TOKEN_PATTERN.test(token) ? token : undefined;
}

export function clearOAuthSignupTicketCookie(): string {
  return serialize(OAUTH_SIGNUP_COOKIE, '', {
    path: '/',
    httpOnly: true,
    secure: true,
    sameSite: 'strict',
    maxAge: 0
  });
}

export function hashOAuthSignupTicket(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}
