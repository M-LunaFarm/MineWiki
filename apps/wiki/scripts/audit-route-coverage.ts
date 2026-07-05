import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const serverPath = resolve('src/server.ts');
const serverSource = readFileSync(serverPath, 'utf8');

const auditedHtmlRoutePatterns = new Set([
  '/',
  '/new',
  '/new/wiki',
  '/new/mod-page',
  '/new/server-page',
  '/new/dev',
  '/login',
  '/join',
  '/verify-email',
  '/forgot-password',
  '/reset-password',
  '/logout',
  '/recent',
  '/admin/recent',
  '/watchlist',
  '/tasks',
  '/search',
  '/category/*',
  '/file',
  '/file/upload',
  '/files/new',
  '/file/*',
  '/servers',
  '/servers/import',
  '/servers/new',
  '/wiki',
  '/mods',
  '/mods/new',
  '/mod',
  '/modpack',
  '/server',
  '/my/servers',
  '/special/my-servers',
  '/server/:slug/manage',
  '/mod/:slug/manage',
  '/dev',
  '/templates/new',
  '/mod/:slug/templates/new',
  '/server/:slug/templates/new',
  '/mod/:slug/new',
  '/server/:slug/new',
  '/dev/new',
  '/help',
  '/project',
  '/special',
  '/template',
  '/server/:slug/claim',
  '/me',
  '/me/sandbox',
  '/users/:id',
  '/user/*',
  '/mod/*',
  '/modpack/*',
  '/server/*',
  '/dev/*',
  '/help/*',
  '/project/*',
  '/announcements',
  '/release-notes',
  '/status',
  '/special/recent-revisions',
  '/special/hidden-revisions',
  '/special/operator-home',
  '/special/운영자_홈',
  '/admin/operator',
  '/special/revision-search',
  '/special/:kind',
  '/revision/:revisionId',
  '/wiki/*',
  '/admin',
  '/admin/reports',
  '/admin/publication',
  '/admin/identity',
  '/admin/audits',
  '/admin/search',
  '/admin/filters',
  '/beta',
  '/admin/project-boards',
  '/admin/reviews/:id',
  '/admin/work',
  '/admin/subwiki-requests/:id',
  '/admin/release',
  '/admin/mod-verification',
  '/admin/files',
  '/admin/export/manifest',
  '/admin/jobs',
  '/admin/imports',
  '/admin/subwikis'
]);

const nonHtmlOrNonPageRoutePatterns = new Map([
  ['/robots.txt', 'crawler text'],
  ['/favicon.ico', 'asset redirect'],
  ['/sitemap.xml', 'XML sitemap'],
  ['/api/recent', 'JSON API'],
  ['/search/click', 'analytics redirect'],
  ['/server/:slug/export', 'download endpoint'],
  ['/admin/export/backup', 'download endpoint'],
  ['/api/pages/:id', 'JSON API'],
  ['/api/pages/by-title', 'JSON API'],
  ['/api/pages/:id/revisions', 'JSON API'],
  ['/api/pages/:id/revisions/:revisionId', 'JSON API'],
  ['/api/revisions/:revisionId', 'JSON API'],
  ['/api/revisions/:revisionId/render', 'JSON API'],
  ['/api/pages/:id/diff', 'JSON API'],
  ['/api/pages/:id/links', 'JSON API'],
  ['/api/pages/:id/categories', 'JSON API'],
  ['/api/pages/:id/sections/:anchor', 'JSON API'],
  ['/api/pages/:id/section-locks', 'JSON API'],
  ['/api/search', 'JSON API'],
  ['/api/search/suggest', 'JSON API'],
  ['/api/search/resolve', 'JSON API'],
  ['/api/components', 'JSON API'],
  ['/api/components/:key/schema', 'JSON API'],
  ['/api/servers/:pageId/status', 'JSON API'],
  ['/api/admin/reports', 'JSON API'],
  ['/api/admin/search/failed', 'JSON API'],
  ['/api/admin/quality/:kind', 'JSON API'],
  ['/api/pages/:id/discussions', 'JSON API'],
  ['/api/discussions/:id', 'JSON API'],
  ['/api/watchlist', 'JSON API'],
  ['/api/watchlist/recent', 'JSON API'],
  ['/api/beta/invites', 'JSON API'],
  ['/api/tasks', 'JSON API'],
  ['/api/project-boards', 'JSON API'],
  ['/api/project-boards/:id', 'JSON API'],
  ['/api/admin/edit-filters', 'JSON API'],
  ['/api/admin/reviews', 'JSON API'],
  ['/api/admin/work', 'JSON API'],
  ['/api/admin/export/manifest', 'JSON API'],
  ['/api/admin/export/backup', 'download endpoint'],
  ['/api/admin/jobs', 'JSON API'],
  ['/api/beta/issues', 'JSON API'],
  ['/api/admin/release-gates', 'JSON API'],
  ['/api/admin/release-rehearsals', 'JSON API'],
  ['/api/open-beta/status', 'JSON API'],
  ['/api/admin/content-audits', 'JSON API'],
  ['/api/admin/search-audits', 'JSON API'],
  ['/api/admin/security-tests', 'JSON API'],
  ['/api/open-beta/settings', 'JSON API'],
  ['/api/admin/user-trust', 'JSON API'],
  ['/api/announcements', 'JSON API'],
  ['/api/admin/announcements', 'JSON API'],
  ['/api/release-notes', 'JSON API'],
  ['/api/incidents', 'JSON API'],
  ['/api/admin/report-sla-rules', 'JSON API'],
  ['/api/campaigns', 'JSON API'],
  ['/api/campaigns/:id/pages', 'JSON API'],
  ['/api/open-beta/weekly-stats', 'JSON API'],
  ['/api/admin/release-blockers', 'JSON API'],
  ['/api/admin/policy-versions', 'JSON API'],
  ['/api/admin/daily-summary', 'JSON API'],
  ['/api/spaces', 'JSON API'],
  ['/api/spaces/:code/pages', 'JSON API'],
  ['/api/spaces/:code/sidebar', 'JSON API'],
  ['/api/admin/subwiki-requests', 'JSON API'],
  ['/api/server-subwikis/:slug/export', 'download endpoint'],
  ['/api/server-subwikis/:slug/tree', 'JSON API'],
  ['/api/admin/gitbook-imports', 'JSON API'],
  ['/api/admin/mod-verification-tasks', 'JSON API'],
  ['/api/admin/file-license-issues', 'JSON API'],
  ['/api/admin/files/unused', 'JSON API'],
  ['/api/admin/server-owners', 'JSON API'],
  ['/api/admin/acl-groups', 'JSON API'],
  ['/*', 'custom-domain fallback; concrete wiki routes are audited on localhost']
]);

const routePattern = /app\.get\(\s*(['`])([^'`]+)\1/g;
const serverRoutes = new Set<string>();
let match: RegExpExecArray | null;
while ((match = routePattern.exec(serverSource))) {
  const route = match[2];
  if (route.includes('${')) continue;
  serverRoutes.add(route);
}

const missing = [...serverRoutes]
  .filter((route) => !auditedHtmlRoutePatterns.has(route))
  .filter((route) => !nonHtmlOrNonPageRoutePatterns.has(route));
const staleAudited = [...auditedHtmlRoutePatterns].filter((route) => !serverRoutes.has(route));
const staleExcluded = [...nonHtmlOrNonPageRoutePatterns.keys()].filter((route) => !serverRoutes.has(route));

if (missing.length || staleAudited.length || staleExcluded.length) {
  if (missing.length) {
    console.error('HTML GET routes missing from audit classification:');
    for (const route of missing) console.error(`- ${route}`);
  }
  if (staleAudited.length) {
    console.error('Audited HTML route patterns not found in server.ts:');
    for (const route of staleAudited) console.error(`- ${route}`);
  }
  if (staleExcluded.length) {
    console.error('Excluded route patterns not found in server.ts:');
    for (const route of staleExcluded) console.error(`- ${route}`);
  }
  process.exitCode = 1;
} else {
  console.log(`Route coverage audit passed: ${auditedHtmlRoutePatterns.size} HTML patterns classified, ${nonHtmlOrNonPageRoutePatterns.size} non-page patterns excluded.`);
}
