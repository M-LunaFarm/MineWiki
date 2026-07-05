import { pool } from '../src/db.js';
import { actorCookie, finalPath, htmlHasVisibleHeading, type AuditUsers, type RouteCheck } from './audit-route-helpers.js';
import { auditRouteSet, auditUsers } from './audit-route-catalog.js';

const baseUrl = (process.env.MINEWIKI_AUDIT_BASE ?? 'http://127.0.0.1:3026').replace(/\/$/, '');
const cssVersion = process.env.MINEWIKI_AUDIT_CSS_VERSION ?? 'semantic-grid-86';
const failures: string[] = [];

function fail(path: string, message: string) {
  failures.push(`${path}: ${message}`);
}

async function checkRoute(route: RouteCheck, users: AuditUsers) {
  const cookie = actorCookie(route, users);
  if (route.actor === 'admin' && !users.adminId) {
    fail(route.path, 'no active admin/developer user available for admin audit');
    return;
  }
  if (route.actor === 'member' && !cookie) {
    fail(route.path, 'no active user available for member audit');
    return;
  }

  const response = await fetch(`${baseUrl}${route.path}`, {
    redirect: 'follow',
    headers: cookie ? { cookie } : undefined
  });
  const html = await response.text();
  const label = route.actor ? `${route.actor} ${route.path}` : route.path;
  const allowedStatuses = route.statuses ?? [200];
  if (!allowedStatuses.includes(response.status)) {
    fail(label, `status ${response.status}, expected ${allowedStatuses.join('|')}`);
  }
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/html')) {
    fail(label, `content-type ${contentType || '(none)'}`);
  }
  if (route.finalPath && !route.finalPath.test(finalPath(response))) {
    fail(label, `final path ${finalPath(response)} did not match ${route.finalPath}`);
  }
  for (const needle of [
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    '<body class="minewiki',
    '<main class="',
    'class="topbar nav-wrapper',
    'class="page-intent-strip',
    'class="mobile-menu"',
    'class="site-footer"',
    cssVersion
  ]) {
    if (!html.includes(needle)) fail(label, `missing ${needle}`);
  }
  if (route.actor === 'member' && !html.includes('class="user-chip"')) {
    fail(label, 'missing logged-in user chip');
  }
  if (route.actor === 'admin' && !html.includes('class="admin-mode-chip"') && !html.includes('class="user-chip"')) {
    fail(label, 'missing authenticated admin chrome');
  }
  if (!htmlHasVisibleHeading(html)) {
    fail(label, 'missing visible h1 heading');
  }
  checkIntentStrip(label, html);
  for (const needle of route.mustInclude ?? []) {
    if (!html.includes(needle)) fail(label, `missing ${needle}`);
  }
  for (const needle of route.mustNotInclude ?? []) {
    if (html.includes(needle)) fail(label, `unexpected ${needle}`);
  }
  if (/^\s*[\[{]/.test(html)) fail(label, 'looks like raw JSON');
  if (html.includes('undefined') || html.includes('[object Object]')) {
    fail(label, 'contains placeholder runtime text');
  }
}

function checkIntentStrip(label: string, html: string) {
  const strip = html.match(/<nav class="page-intent-strip[^"]*" aria-label="현재 화면 바로가기">([\s\S]*?)<\/nav>/)?.[1] ?? '';
  if (!strip) {
    fail(label, 'missing page intent strip content');
    return;
  }
  if (!/<span class="intent-context">[^<]+<\/span>/.test(strip)) fail(label, 'missing page intent context');
  if (!/<span class="intent-title">[^<]+<\/span>/.test(strip)) fail(label, 'missing page intent title');
  const links = [...strip.matchAll(/<a href="([^"]+)">([^<]+)<\/a>/g)].map((match) => ({ href: match[1] ?? '', label: match[2] ?? '' }));
  if (links.length < 3) fail(label, `page intent has only ${links.length} links`);
  const seen = new Set<string>();
  for (const link of links) {
    if (!link.label.trim()) fail(label, 'page intent has empty link label');
    if (seen.has(link.href)) fail(label, `page intent duplicate link ${link.href}`);
    seen.add(link.href);
    if (!isSafeIntentHref(link.href)) fail(label, `page intent unsafe link ${link.href}`);
  }
}

function isSafeIntentHref(href: string) {
  if (!href || href.startsWith('//') || /[\u0000-\u001f\u007f]/.test(href)) return false;
  if (href.startsWith('/')) return true;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

try {
  const users = await auditUsers();
  const routeSet = await auditRouteSet(users);
  for (const route of routeSet) {
    await checkRoute(route, users);
  }

  if (failures.length) {
    console.error(`Route audit failed for ${failures.length} checks:`);
    for (const failure of failures) console.error(`- ${failure}`);
    process.exitCode = 1;
  } else {
    const actorSummary = `anonymous/member/admin routes, admin user ${users.adminId ?? 'none'}, member user ${users.memberId ?? 'admin fallback'}`;
    console.log(`Route audit passed: ${routeSet.length} routes at ${baseUrl} (${actorSummary})`);
  }
} finally {
  await pool.end();
}
