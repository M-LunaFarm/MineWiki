import { one, query } from '../src/db.js';
import { wikiUrl } from '../src/wiki/namespaces.js';
import { specialQualityPages } from '../src/wiki/special.js';
import { addRouteIfNew, escapeRegExp, type AuditUsers, type RouteCheck } from './audit-route-helpers.js';

export const staticRoutes: RouteCheck[] = [
  { path: '/', finalPath: /^\/wiki\/%EB%8C%80%EB%AC%B8$/, mustInclude: ['skin-article'] },
  { path: '/recent', mustInclude: ['recent-page'] },
  { path: '/search', mustInclude: ['search-shell'] },
  { path: '/file', mustInclude: ['wiki-hub-page', 'space-file'] },
  { path: '/file/upload', mustInclude: ['file-upload-page'] },
  { path: '/servers', mustInclude: ['directory space-server'] },
  { path: '/servers/new', mustInclude: ['new-doc-shell space-server'] },
  { path: '/mods', mustInclude: ['mod-directory'] },
  { path: '/mods/new', mustInclude: ['new-doc-shell'] },
  { path: '/dev', mustInclude: ['directory dev-layout'] },
  { path: '/new', mustInclude: ['new-doc-shell'] },
  { path: '/new/wiki', mustInclude: ['guided-create-form'] },
  { path: '/new/mod-page', mustInclude: ['guided-create-form'] },
  { path: '/new/server-page', mustInclude: ['guided-create-form'] },
  { path: '/new/dev', mustInclude: ['guided-create-form'] },
  { path: '/templates/new', statuses: [403], mustInclude: ['message-page'] },
  { path: '/help', mustInclude: ['wiki-hub-page', 'space-help'] },
  { path: '/project', mustInclude: ['wiki-hub-page', 'space-project'] },
  { path: '/special', mustInclude: ['wiki-hub-page', 'space-special'] },
  { path: '/template', mustInclude: ['wiki-hub-page', 'space-template'] },
  { path: '/announcements', mustInclude: ['public-info-page'] },
  { path: '/release-notes', mustInclude: ['public-info-page'] },
  { path: '/status', mustInclude: ['public-info-page'] },
  { path: '/beta', mustInclude: ['public-info-page', 'join-info-page'] },
  { path: '/special/revision-search', mustInclude: ['revision-search-page'] },
  { path: '/special/recent-revisions', mustInclude: ['data-list-layout'] },
  ...specialQualityPages.map((page) => ({ path: `/special/${page.kind}`, mustInclude: ['quality-page'] })),
  { path: '/login', mustInclude: ['auth-shell', 'auth-card'] },
  { path: '/join', statuses: [200, 403], mustInclude: ['minewiki'] },
  { path: '/verify-email', statuses: [400], mustInclude: ['auth-shell', 'auth-card'] },
  { path: '/forgot-password', mustInclude: ['auth-shell', 'auth-card'] },
  { path: '/reset-password', statuses: [400], mustInclude: ['auth-shell', 'auth-card'] },
  { path: '/servers/import', finalPath: /^\/servers\/new\?import=1$/, mustInclude: ['new-doc-shell space-server'] },
  { path: '/mod', finalPath: /^\/mods$/, mustInclude: ['mod-directory'] },
  { path: '/modpack', finalPath: /^\/mods$/, mustInclude: ['mod-directory'] },
  { path: '/server', finalPath: /^\/servers$/, mustInclude: ['directory space-server'] },
  { path: '/my/servers', finalPath: /^\/login\?next=%2Fmy%2Fservers$/, mustInclude: ['auth-shell'] },
  { path: '/watchlist', finalPath: /^\/login\?next=%2Fwatchlist$/, mustInclude: ['auth-shell'] },
  { path: '/tasks', finalPath: /^\/login\?next=%2Ftasks$/, mustInclude: ['auth-shell'] },
  { path: '/admin', statuses: [403], mustInclude: ['message-page'], mustNotInclude: ['"error":"'] },

  { path: '/watchlist', actor: 'member', mustInclude: ['watchlist-page', 'user-chip'], mustNotInclude: ['auth-shell'] },
  { path: '/tasks', actor: 'member', mustInclude: ['task-summary', 'user-chip'], mustNotInclude: ['auth-shell'] },
  { path: '/me', actor: 'member', mustInclude: ['user-dashboard', 'user-chip'], mustNotInclude: ['auth-shell'] },
  { path: '/my/servers', actor: 'member', mustInclude: ['operator-shell space-server', 'my-server-summary', 'user-chip'], mustNotInclude: ['auth-shell'] },
  { path: '/file/upload', actor: 'member', mustInclude: ['file-upload-page', 'user-chip'], mustNotInclude: ['auth-shell'] },
  { path: '/new/wiki', actor: 'member', mustInclude: ['guided-create-form', 'user-chip'], mustNotInclude: ['auth-shell'] },
  { path: '/logout', actor: 'member', mustInclude: ['message-page', '로그아웃'] },

  { path: '/admin', actor: 'admin', mustInclude: ['admin-hero', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/operator', actor: 'admin', mustInclude: ['operator-home', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/recent', actor: 'admin', mustInclude: ['recent-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/special/hidden-revisions', actor: 'admin', mustInclude: ['data-list-layout', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/reports', actor: 'admin', mustInclude: ['admin-reports-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/publication', actor: 'admin', mustInclude: ['admin-publication-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/identity', actor: 'admin', mustInclude: ['admin-identity-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/audits', actor: 'admin', mustInclude: ['admin-audit-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/search', actor: 'admin', mustInclude: ['admin-search-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/filters', actor: 'admin', mustInclude: ['admin-filters-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/project-boards', actor: 'admin', mustInclude: ['admin-project-board-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/work', actor: 'admin', mustInclude: ['admin-work-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/release', actor: 'admin', mustInclude: ['admin-release-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/mod-verification', actor: 'admin', mustInclude: ['admin-mod-verification-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/files', actor: 'admin', mustInclude: ['admin-file-summary', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/export/manifest', actor: 'admin', mustInclude: ['admin-backup-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/jobs', actor: 'admin', mustInclude: ['admin-jobs-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/imports', actor: 'admin', mustInclude: ['admin-imports-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] },
  { path: '/admin/subwikis', actor: 'admin', mustInclude: ['admin-subwikis-page', 'admin-mode-chip'], mustNotInclude: ['auth-shell', '"error":"'] }
];

export type DynamicSamples = {
  pages: Array<{ namespace_code: string; title: string }>;
  categories: Array<{ title: string; slug: string | null }>;
  files: Array<{ file_name: string }>;
  revisions: Array<{ id: number }>;
  users: Array<{ id: number; username: string }>;
  spaces: Array<{ root_path: string; space_type: string }>;
  reviews: Array<{ id: number }>;
  subwikiRequests: Array<{ id: number }>;
};

export async function auditUsers(): Promise<AuditUsers> {
  const admin = await one<{ id: number }>(
    `SELECT u.id
     FROM users u
     LEFT JOIN user_groups ug ON ug.user_id=u.id
     LEFT JOIN groups g ON g.id=ug.group_id
     LEFT JOIN group_permissions gp ON gp.group_id=g.id
     WHERE u.status='active'
     GROUP BY u.id
     HAVING SUM(g.code='developer') > 0 OR SUM(gp.permission_code='report.handle') > 0
     ORDER BY SUM(g.code='developer') DESC, u.id ASC
     LIMIT 1`
  );
  const member = await one<{ id: number }>(
    `SELECT u.id
     FROM users u
     LEFT JOIN user_groups ug ON ug.user_id=u.id
     LEFT JOIN groups g ON g.id=ug.group_id
     LEFT JOIN group_permissions gp ON gp.group_id=g.id
     WHERE u.status='active'
     GROUP BY u.id
     HAVING SUM(g.code='developer') = 0
        AND SUM(COALESCE(gp.permission_code='report.handle', 0)) = 0
     ORDER BY u.id DESC
     LIMIT 1`
  );
  return {
    adminId: admin ? Number(admin.id) : null,
    memberId: member ? Number(member.id) : null
  };
}

export async function dynamicSamples(): Promise<DynamicSamples> {
  const [pages, categories, files, revisions, users, spaces, reviews, subwikiRequests] = await Promise.all([
    query<{ namespace_code: string; title: string }>(
      `SELECT n.code AS namespace_code, p.title
       FROM pages p
       JOIN namespaces n ON n.id=p.namespace_id
       WHERE p.status!='deleted' AND p.current_revision_id IS NOT NULL
       ORDER BY FIELD(n.code,'main','dev','help','project','server','mod','modpack','template','file'), p.id
       LIMIT 80`
    ),
    query<{ title: string; slug: string | null }>(
      `SELECT c.title, c.slug
       FROM page_categories pc
       JOIN categories c ON c.id=pc.category_id
       GROUP BY c.id, c.title, c.slug
       ORDER BY COUNT(*) DESC
       LIMIT 5`
    ),
    query<{ file_name: string }>(
      `SELECT file_name
       FROM files
       WHERE status!='deleted'
       ORDER BY id DESC
       LIMIT 3`
    ),
    query<{ id: number }>(
      `SELECT r.id
       FROM page_revisions r
       JOIN pages p ON p.id=r.page_id
       WHERE p.status!='deleted' AND (r.visibility IS NULL OR r.visibility='public')
       ORDER BY r.id DESC
       LIMIT 3`
    ),
    query<{ id: number; username: string }>(
      `SELECT id, username
       FROM users
       WHERE status='active'
       ORDER BY id ASC
       LIMIT 3`
    ),
    query<{ root_path: string; space_type: string }>(
      `SELECT root_path, space_type
       FROM wiki_spaces
       WHERE status='active' AND root_path IS NOT NULL
       ORDER BY FIELD(space_type,'server_wiki','mod_wiki','developer','basic'), id
       LIMIT 20`
    ),
    query<{ id: number }>(
      `SELECT id
       FROM pending_reviews
       ORDER BY FIELD(status,'pending','needs_changes','approved','rejected'), id DESC
       LIMIT 2`
    ),
    query<{ id: number }>(
      `SELECT id
       FROM subwiki_requests
       ORDER BY FIELD(status,'pending','created','rejected'), id DESC
       LIMIT 2`
    )
  ]);
  return { pages, categories, files, revisions, users, spaces, reviews, subwikiRequests };
}

export function dynamicRoutes(samples: DynamicSamples, users: AuditUsers): RouteCheck[] {
  const routeList: RouteCheck[] = [];
  const seen = new Set<string>();
  const add = (route: RouteCheck) => addRouteIfNew(routeList, seen, route);

  const byNamespace = new Map<string, string>();
  for (const page of samples.pages) {
    if (!byNamespace.has(page.namespace_code)) byNamespace.set(page.namespace_code, page.title);
  }

  for (const namespace of ['main', 'dev', 'help', 'project', 'template']) {
    const title = byNamespace.get(namespace);
    if (title) add({ path: wikiUrl(namespace as any, title), mustInclude: ['skin-article'] });
  }

  const mainTitle = byNamespace.get('main');
  if (mainTitle) {
    const href = wikiUrl('main' as any, mainTitle);
    add({ path: `${href}/history`, mustInclude: ['history-page'] });
    add({ path: `${href}/raw`, mustInclude: ['raw-page'] });
    add({ path: `${href}/discussion`, mustInclude: ['discussion-page'] });
    add({ path: `${href}/permissions`, mustInclude: ['permission-info-page'] });
    add({ path: `${href}/acl`, mustInclude: ['permission-info-page'] });
  }

  for (const category of samples.categories.slice(0, 3)) {
    add({ path: `/category/${encodeURIComponent(category.slug || category.title)}`, mustInclude: ['category-page'] });
  }

  for (const file of samples.files.slice(0, 2)) {
    add({ path: `/file/${encodeURIComponent(file.file_name)}`, mustInclude: ['file-detail-page'] });
  }

  for (const revision of samples.revisions.slice(0, 2)) {
    add({ path: `/revision/${Number(revision.id)}`, mustInclude: ['skin-article'] });
  }

  for (const user of samples.users.slice(0, 2)) {
    add({ path: `/users/${Number(user.id)}`, finalPath: new RegExp(`^/user/${escapeRegExp(encodeURIComponent(user.username))}`), mustInclude: ['space-user'] });
    add({ path: `/user/${encodeURIComponent(user.username)}`, mustInclude: ['space-user'] });
  }

  for (const space of samples.spaces) {
    if (!space.root_path || ['/wiki', '/file'].includes(space.root_path)) continue;
    if (space.space_type === 'server_wiki' || space.space_type === 'mod_wiki') {
      add({ path: space.root_path, mustInclude: ['skin-space'] });
      add({ path: `${space.root_path}/new`, actor: 'member', statuses: [200, 403], mustInclude: ['minewiki'] });
      add({ path: `${space.root_path}/templates/new`, actor: 'member', statuses: [200, 403], mustInclude: ['minewiki'] });
      add({ path: `${space.root_path}/manage`, actor: 'admin', statuses: [200, 403], mustInclude: ['minewiki'] });
      if (space.space_type === 'server_wiki') {
        add({ path: `${space.root_path}/claim`, actor: 'admin', statuses: [200, 403], mustInclude: ['minewiki'] });
      }
    }
  }

  if (users.memberId) {
    add({ path: '/me/sandbox', actor: 'member', statuses: [200, 404], mustInclude: ['minewiki'] });
  }

  for (const review of samples.reviews) {
    add({ path: `/admin/reviews/${Number(review.id)}`, actor: 'admin', mustInclude: ['admin-review-page'] });
  }
  for (const subwikiRequest of samples.subwikiRequests) {
    add({ path: `/admin/subwiki-requests/${Number(subwikiRequest.id)}`, actor: 'admin', mustInclude: ['admin-hero'] });
  }

  add({ path: '/files/new', finalPath: /^\/file\/upload$/, mustInclude: ['file-upload-page'] });
  add({ path: '/special/my-servers', finalPath: /^\/login\?next=%2Fmy%2Fservers$/, mustInclude: ['auth-shell'] });
  add({ path: '/dev/new', mustInclude: ['new-doc-shell'] });
  add({ path: '/templates/new', actor: 'member', mustInclude: ['new-doc-shell'] });
  add({ path: '/special/operator-home', actor: 'admin', finalPath: /^\/admin\/operator$/, mustInclude: ['operator-home'] });
  add({ path: '/special/운영자_홈', actor: 'admin', finalPath: /^\/admin\/operator$/, mustInclude: ['operator-home'] });

  return routeList;
}

export async function auditRouteSet(users: AuditUsers): Promise<RouteCheck[]> {
  return [...staticRoutes, ...dynamicRoutes(await dynamicSamples(), users)];
}
