import { sign } from '@fastify/cookie';
import { config } from '../src/config.js';

export type RouteCheck = {
  path: string;
  actor?: 'anonymous' | 'member' | 'admin';
  statuses?: number[];
  finalPath?: RegExp;
  mustInclude?: string[];
  mustNotInclude?: string[];
};

export type AuditUsers = {
  memberId: number | null;
  adminId: number | null;
};

export function finalPath(response: Response) {
  const url = new URL(response.url);
  return `${url.pathname}${url.search}`;
}

export function actorCookie(route: RouteCheck, users: AuditUsers) {
  if (route.actor === 'admin') return cookieForUser(users.adminId);
  if (route.actor === 'member') return cookieForUser(users.memberId ?? users.adminId);
  return null;
}

export function addRouteIfNew(routeList: RouteCheck[], seen: Set<string>, route: RouteCheck) {
  const key = uniqueRouteKey(route);
  if (seen.has(key)) return;
  seen.add(key);
  routeList.push(route);
}

export function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function htmlHasVisibleHeading(html: string) {
  const match = html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i);
  if (!match) return false;
  const text = match[1]
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&#39;|&quot;|&amp;|&lt;|&gt;/g, 'x')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > 0;
}

function cookieForUser(userId: number | null) {
  if (!userId) return null;
  return `uid=${encodeURIComponent(sign(String(userId), config.cookieSecret))}`;
}

function uniqueRouteKey(route: RouteCheck) {
  return `${route.actor ?? 'anonymous'} ${route.path}`;
}
