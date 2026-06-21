import { readFileSync } from 'node:fs';
import { pool } from '../src/db.js';
import { actorCookie, type AuditUsers, type RouteCheck } from './audit-route-helpers.js';
import { auditRouteSet, auditUsers } from './audit-route-catalog.js';

type ServerRoute = {
  method: 'get' | 'post' | 'put' | 'delete';
  pattern: RegExp;
  source: string;
};

type Affordance = {
  kind: 'link' | 'form';
  method: 'get' | 'post';
  path: string;
  label: string;
};

const baseUrl = (process.env.MINEWIKI_AUDIT_BASE ?? 'http://127.0.0.1:3026').replace(/\/$/, '');
const failures: string[] = [];
const serverRoutes = readServerRoutes();
const ignoredPrefixes = ['/assets/', '/cdn/'];
const ignoredExactPaths = new Set(['/favicon.ico']);

function fail(label: string, message: string) {
  failures.push(`${label}: ${message}`);
}

async function checkRoute(route: RouteCheck, users: AuditUsers) {
  const cookie = actorCookie(route, users);
  const label = `${route.actor ?? 'anonymous'} ${route.path}`;
  const response = await fetch(`${baseUrl}${route.path}`, {
    redirect: 'follow',
    headers: cookie ? { cookie } : undefined
  });
  const html = await response.text();
  if (!response.headers.get('content-type')?.includes('text/html')) return;

  for (const affordance of renderedAffordances(html, response.url)) {
    if (isIgnoredPath(affordance.path)) continue;
    if (!routeExists(affordance.method, affordance.path)) {
      fail(label, `${affordance.kind} ${affordance.method.toUpperCase()} ${affordance.path} has no server route (${affordance.label})`);
    }
    if (affordance.kind === 'link' && affordance.path.startsWith('/api/')) {
      fail(label, `visible link points at JSON API ${affordance.path} (${affordance.label})`);
    }
  }
}

function renderedAffordances(html: string, currentUrl: string): Affordance[] {
  const items: Affordance[] = [];
  for (const tag of html.matchAll(/<a\b[^>]*>/gi)) {
    const href = attr(tag[0], 'href');
    const path = sameOriginPath(href, currentUrl);
    if (!path) continue;
    items.push({ kind: 'link', method: 'get', path, label: labelForTag(tag[0]) });
  }
  for (const tag of html.matchAll(/<form\b[^>]*>/gi)) {
    const method = (attr(tag[0], 'method') || 'get').toLowerCase();
    if (method === 'dialog') continue;
    const action = attr(tag[0], 'action') || currentUrl;
    const path = sameOriginPath(action, currentUrl);
    if (!path) continue;
    if (method !== 'get' && method !== 'post') {
      items.push({ kind: 'form', method: 'post', path, label: `unsupported method ${method}` });
      continue;
    }
    items.push({ kind: 'form', method: method as 'get' | 'post', path, label: labelForTag(tag[0]) });
  }
  return items;
}

function sameOriginPath(value: string | null, currentUrl: string) {
  if (!value || value === '#' || value.startsWith('javascript:') || value.startsWith('mailto:') || value.startsWith('tel:')) return null;
  try {
    const url = new URL(decodeHtml(value), currentUrl);
    if (url.origin !== new URL(baseUrl).origin) return null;
    return `${url.pathname}`.replace(/\/+$/, '') || '/';
  } catch {
    return null;
  }
}

function routeExists(method: 'get' | 'post', path: string) {
  return serverRoutes.some((route) => route.method === method && route.pattern.test(path));
}

function isIgnoredPath(path: string) {
  return ignoredExactPaths.has(path) || ignoredPrefixes.some((prefix) => path.startsWith(prefix));
}

function readServerRoutes(): ServerRoute[] {
  const source = readFileSync(new URL('../src/server.ts', import.meta.url), 'utf8');
  return [...source.matchAll(/app\.(get|post|put|delete)\('([^']+)'/g)]
    .map((match) => ({
      method: match[1] as ServerRoute['method'],
      source: match[2] ?? '',
      pattern: routePattern(match[2] ?? '')
    }))
    .filter((route) => route.source.length > 0);
}

function routePattern(route: string) {
  const placeholder = '__MINEWIKI_PARAM__';
  const wildcard = '__MINEWIKI_WILDCARD__';
  const normalized = route
    .replace(/\/:[A-Za-z0-9_]+/g, `/${placeholder}`)
    .replace(/\*/g, wildcard);
  const escaped = escapeRegExp(normalized)
    .replaceAll(placeholder, '[^/]+')
    .replaceAll(wildcard, '.*');
  return new RegExp(`^${escaped}/?$`);
}

function attr(tag: string, name: string) {
  const pattern = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)'|([^\\s>]+))`, 'i');
  const match = tag.match(pattern);
  return match ? decodeHtml(match[2] ?? match[3] ?? match[4] ?? '') : null;
}

function labelForTag(tag: string) {
  return decodeHtml(attr(tag, 'aria-label') || attr(tag, 'title') || tag.replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || '(no label)';
}

function decodeHtml(value: string) {
  return value
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>');
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

try {
  const users = await auditUsers();
  const routes = await auditRouteSet(users);
  for (const route of routes) {
    await checkRoute(route, users);
  }
  if (failures.length) {
    console.error(`Live affordance audit failed for ${failures.length} checks:`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    console.log(`Live affordance audit passed: rendered links and forms from ${routes.length} routes match server routes at ${baseUrl}`);
  }
} finally {
  await pool.end();
}
