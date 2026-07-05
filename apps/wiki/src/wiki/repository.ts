import crypto from 'node:crypto';
import dns from 'node:dns/promises';
import net from 'node:net';
import type mysql from 'mysql2/promise';
import { config } from '../config.js';
import { exec, one, query, tx } from '../db.js';
import type { NamespaceCode } from '../types.js';
import { namespaceSpecs, parseLinkTarget, wikiLinkKey, wikiUrl } from './namespaces.js';
import { chosung, hashContent, normalizeSearch, normalizeTitle, slugifyTitle } from './normalize.js';
import { parseMarkup, renderDocument } from './markup.js';

const maxSavedPageContentLength = 1_000_000;
const pageFields = `id, namespace_id, space_id, local_path, slug, title, display_title, current_revision_id, page_type, protection_level, status, created_by, created_at, updated_at`;
const pageSelectFields = pageFields.split(', ').map((field) => `p.${field}`).join(', ');
const openBetaSettingsFields = `id, signup_mode, new_user_edit_limit, new_user_external_link_limit, new_user_review_required, server_listing_mode, updated_by, updated_at`;
const userTrustFields = `user_id, trust_level, good_edits, reverted_edits, rejected_reviews, reports_received, filter_hits, last_evaluated_at, updated_at`;
const openBetaWeeklyStatsFields = `week_start, new_users, active_users, page_views, searches, zero_result_searches, edits, page_creates, rollbacks, reports, pending_reviews, approved_reviews, rejected_reviews, server_claims, mod_verifications, file_license_issues, created_at, updated_at`;
const dailyOperationSummaryFields = `summary_date, edits, page_creates, pending_reviews, open_reports, urgent_reports, rollbacks, zero_result_searches, server_claims_pending, server_disputes, outdated_mod_pages, file_license_issues, failed_jobs, created_at, updated_at`;
const editFilterFields = `id, name, description, filter_type, pattern, action, enabled, created_by, created_at, updated_at`;
const modWikiFields = `mw.id, mw.space_id, mw.mod_name, mw.category, mw.slug, mw.loaders, mw.supported_versions, mw.official_url, mw.source_url, mw.license, mw.creator_verified, mw.verified_by, mw.verified_at, mw.status, mw.last_checked, mw.created_at, mw.updated_at`;
const jobQueueFields = `id, job_type, payload_json, status, attempts, max_attempts, run_after, started_at, finished_at, error_message, created_at`;
const pageLinkFields = `id, from_page_id, target_namespace_id, target_title, target_page_id, link_type, created_at`;
const categoryFields = `id, title, slug, created_at`;
const pageProtectionEventFields = `ppe.id, ppe.page_id, ppe.old_level, ppe.new_level, ppe.reason, ppe.expires_at, ppe.changed_by, ppe.is_automatic, ppe.note, ppe.created_at`;

function normalizeActorIpText(value: unknown) {
  const ip = String(value ?? '').trim();
  return net.isIP(ip) ? ip : null;
}

export interface PageWrite {
  namespace: NamespaceCode;
  title: string;
  displayTitle?: string;
  content: string;
  summary?: string;
  userId?: number | null;
  actorIpText?: string | null;
  pageType?: string;
  baseRevisionId?: number | null;
  skipReview?: boolean;
  forceReviewReason?: string | null;
  isMinor?: boolean;
  editTags?: string[];
}

export interface SavedPageResult {
  pending?: false;
  pageId: number;
  revisionId: number;
  revisionNo: number;
  parsed: ReturnType<typeof parseMarkup>;
  html: string;
}

export interface PendingPageReviewResult {
  pending: true;
  pendingReviewId: number;
  parsed: ReturnType<typeof parseMarkup>;
  html: string;
}

export type SavePageResult = SavedPageResult | PendingPageReviewResult;

type StructuredDataOptions = {
  reviewModLinkChanges?: boolean;
  revisionId?: number;
  userId?: number | null;
};

export async function ensureCoreData() {
  for (const namespace of namespaceSpecs) {
    await exec(
      `INSERT INTO namespaces (code, display_name, path_prefix, is_content)
       VALUES (:code, :displayName, :pathPrefix, :isContent)
       ON DUPLICATE KEY UPDATE display_name=VALUES(display_name), path_prefix=VALUES(path_prefix), is_content=VALUES(is_content)`,
      namespace
    );
  }
  const defaultSpaces = [
    { code: 'main', name: '위키', spaceType: 'basic', namespaceCode: 'main', rootPath: '/wiki', description: '바닐라와 일반 가이드 중심 공간' },
    { code: 'mod', name: '모드', spaceType: 'mod_category', namespaceCode: 'mod', rootPath: '/mod', description: '모드 기본 문서와 검증 데이터 공간' },
    { code: 'modpack', name: '모드팩', spaceType: 'mod_category', namespaceCode: 'modpack', rootPath: '/modpack', description: '모드팩 문서 공간' },
    { code: 'server', name: '서버', spaceType: 'server_category', namespaceCode: 'server', rootPath: '/server', description: '서버 목록과 인증 서버 문서 공간' },
    { code: 'develop', name: '개발', spaceType: 'developer', namespaceCode: 'dev', rootPath: '/dev', description: '프로토콜, API, 데이터팩 개발 문서 공간' },
    { code: 'guide', name: '가이드', spaceType: 'basic', namespaceCode: 'guide', rootPath: '/wiki/가이드', description: '플레이와 운영 가이드 문서 공간' },
    { code: 'data', name: '데이터', spaceType: 'basic', namespaceCode: 'data', rootPath: '/wiki/데이터', description: '게임 데이터와 기준표 문서 공간' },
    { code: 'help', name: '도움말', spaceType: 'basic', namespaceCode: 'help', rootPath: '/help', description: '도움말과 편집 안내' },
    { code: 'project', name: '프로젝트', spaceType: 'basic', namespaceCode: 'project', rootPath: '/project', description: '정책과 운영 문서' },
    { code: 'template', name: '틀', spaceType: 'basic', namespaceCode: 'template', rootPath: '/wiki/틀', description: '문서 틀과 공용 구성요소 공간' },
    { code: 'file', name: '파일', spaceType: 'basic', namespaceCode: 'file', rootPath: '/file', description: '파일 설명과 라이선스 문서 공간' }
  ];
  for (const space of defaultSpaces) {
    await exec(
      `INSERT INTO wiki_spaces (code, name, space_type, root_namespace_code, root_path, description, created_at, updated_at)
       VALUES (:code, :name, :spaceType, :namespaceCode, :rootPath, :description, NOW(), NOW())
       ON DUPLICATE KEY UPDATE name=VALUES(name), space_type=VALUES(space_type), root_namespace_code=VALUES(root_namespace_code), root_path=VALUES(root_path), description=VALUES(description), updated_at=NOW()`,
      space
    );
    await exec(`UPDATE wiki_spaces SET space_key=COALESCE(space_key, code), title=:name, slug=COALESCE(slug, code) WHERE code=:code`, space);
    await exec(
      `INSERT INTO subwiki_settings (space_id, home_title, short_path, created_at, updated_at)
       SELECT id, '대문', :rootPath, NOW(), NOW() FROM wiki_spaces WHERE code=:code
       ON DUPLICATE KEY UPDATE short_path=VALUES(short_path), updated_at=NOW()`,
      space
    );
  }
  const groups = [
    'guest',
    'user',
    'autoconfirmed',
    'trusted',
    'mod_editor',
    'server_owner',
    'moderator',
    'admin',
    'developer'
  ];
  for (const code of groups) {
    await exec(
      `INSERT INTO groups (code, display_name) VALUES (:code, :name)
       ON DUPLICATE KEY UPDATE display_name=VALUES(display_name)`,
      { code, name: code }
    );
  }
  const adminGroup = await one<{ id: number }>(`SELECT id FROM groups WHERE code='admin'`);
  if (adminGroup) {
    const permissions = [
      'page.read',
      'page.create',
      'page.edit',
      'page.move',
      'page.delete',
      'page.restore',
      'page.protect',
      'revision.hide',
      'file.upload',
      'server.claim',
      'server.official_edit',
      'report.handle',
      'user.block',
      'system.edit_component'
    ];
    for (const permission of permissions) {
      await exec(
        `INSERT IGNORE INTO group_permissions (group_id, permission_code) VALUES (:groupId, :permission)`,
        { groupId: adminGroup.id, permission }
      );
    }
  }
  const modEditorGroup = await one<{ id: number }>(`SELECT id FROM groups WHERE code='mod_editor'`);
  if (modEditorGroup) {
    for (const permission of ['page.read', 'page.edit', 'mod.verify']) {
      await exec(
        `INSERT IGNORE INTO group_permissions (group_id, permission_code) VALUES (:groupId, :permission)`,
        { groupId: modEditorGroup.id, permission }
      );
    }
  }
  const existing = await one<{ id: number }>(`SELECT id FROM users WHERE username='admin'`);
  const passwordHash = '$2b$10$JvxxG5.N/zYvwg/uJL1At.V4w8stDcaiAzKQkGq54jsD4cVCpNZo.';
  if (!existing) {
    const result = await exec(
      `INSERT INTO users (username, display_name, email, password_hash, created_at, updated_at)
       VALUES ('admin', 'MineWiki', :supportEmail, :passwordHash, NOW(), NOW())`,
      { passwordHash, supportEmail: config.supportEmail }
    );
    if (adminGroup) {
      await exec(`INSERT IGNORE INTO user_groups (user_id, group_id) VALUES (:userId, :groupId)`, {
        userId: result.insertId,
        groupId: adminGroup.id
      });
    }
  } else {
    await exec(`UPDATE users SET display_name='MineWiki', password_hash=:passwordHash, email=:supportEmail, updated_at=NOW() WHERE id=:id`, {
      id: existing.id,
      passwordHash,
      supportEmail: config.supportEmail
    });
  }
  const adminUser = await one<{ id: number }>(`SELECT id FROM users WHERE username='admin'`);
  if (adminGroup && adminUser) {
    await exec(`INSERT IGNORE INTO user_groups (user_id, group_id) VALUES (:userId, :groupId)`, {
      userId: adminUser.id,
      groupId: adminGroup.id
    });
    await exec(
      `DELETE ug FROM user_groups ug
       JOIN users u ON u.id=ug.user_id
       WHERE ug.group_id=:groupId AND u.username!='admin'`,
      { groupId: adminGroup.id }
    );
  }
}

export async function syncPageSpaces() {
  await exec(
    `UPDATE pages p
     JOIN namespaces n ON n.id=p.namespace_id
   JOIN wiki_spaces ws ON ws.root_namespace_code=n.code AND ws.space_type NOT IN ('server_wiki','mod_wiki','user_wiki')
     SET p.space_id=ws.id, p.local_path=p.title`
  );
  await exec(
    `UPDATE pages p
     JOIN namespaces n ON n.id=p.namespace_id
     JOIN wiki_spaces ws ON ws.code=CONCAT(n.code, '-', SUBSTRING_INDEX(p.title, '/', 1)) AND ws.space_type IN ('server_wiki','mod_wiki')
     SET p.space_id=ws.id,
         p.local_path=CASE WHEN LOCATE('/', p.title) > 0 THEN SUBSTRING(p.title, LOCATE('/', p.title) + 1) ELSE '대문' END
     WHERE n.code IN ('server','mod')`
  );
}

export async function evaluateUserTrust(userId: number) {
  const stats = await one<any>(
    `SELECT
       (SELECT COUNT(*) FROM page_revisions WHERE created_by=:userId) AS good_edits,
       (SELECT COUNT(*)
        FROM page_revision_actions pra
        JOIN page_revisions pr ON pr.id=pra.revision_id
        WHERE pra.action='rollback' AND pr.created_by=:userId) AS reverted_edits,
       (SELECT COUNT(*) FROM pending_reviews WHERE submitted_by=:userId AND status='rejected') AS rejected_reviews,
       (SELECT COUNT(*) FROM reports WHERE target_type='user' AND target_id=:userId AND status IN ('open','reviewing','resolved')) AS reports_received,
       (SELECT COUNT(*) FROM edit_filter_hits WHERE user_id=:userId) AS filter_hits`,
    { userId }
  );
  const goodEdits = Number(stats?.good_edits ?? 0);
  const revertedEdits = Number(stats?.reverted_edits ?? 0);
  const rejectedReviews = Number(stats?.rejected_reviews ?? 0);
  const reportsReceived = Number(stats?.reports_received ?? 0);
  const filterHits = Number(stats?.filter_hits ?? 0);
  const trustLevel =
    reportsReceived >= 5 || filterHits >= 5 || rejectedReviews >= 3 || revertedEdits >= 5
      ? 'restricted'
      : goodEdits >= 100 && reportsReceived === 0 && rejectedReviews === 0 && revertedEdits === 0
        ? 'trusted'
        : goodEdits >= 10 && revertedEdits <= 1
          ? 'autoconfirmed'
          : goodEdits >= 3 && revertedEdits <= 2
            ? 'normal'
            : 'new';
  await exec(
    `INSERT INTO user_trust (user_id, trust_level, good_edits, reverted_edits, rejected_reviews, reports_received, filter_hits, last_evaluated_at, updated_at)
     VALUES (:userId, :trustLevel, :goodEdits, :revertedEdits, :rejectedReviews, :reportsReceived, :filterHits, NOW(), NOW())
     ON DUPLICATE KEY UPDATE trust_level=VALUES(trust_level), good_edits=VALUES(good_edits), reverted_edits=VALUES(reverted_edits),
       rejected_reviews=VALUES(rejected_reviews), reports_received=VALUES(reports_received), filter_hits=VALUES(filter_hits), last_evaluated_at=NOW(), updated_at=NOW()`,
    {
      userId,
      trustLevel,
      goodEdits,
      revertedEdits,
      rejectedReviews,
      reportsReceived,
      filterHits
    }
  );
  await syncTrustGroups(userId, trustLevel);
  return { userId, trustLevel, goodEdits, revertedEdits, rejectedReviews, reportsReceived, filterHits };
}

export async function enforceOpenBetaEditPolicy(userId: number, content: string) {
  const settings = await one<any>(`SELECT ${openBetaSettingsFields} FROM open_beta_settings WHERE id=1`);
  const privileged = await one<any>(
    `SELECT 1 AS ok
     FROM user_groups ug JOIN groups g ON g.id=ug.group_id
     WHERE ug.user_id=:userId AND g.code IN ('autoconfirmed','trusted','moderator','admin','developer')
     LIMIT 1`,
    { userId }
  );
  if (privileged) return;
  const trust = await one<any>(`SELECT ${userTrustFields} FROM user_trust WHERE user_id=:userId`, { userId });
  const trustLevel = trust?.trust_level ?? 'new';
  if (trustLevel === 'restricted') {
    throw new Error('제한 상태의 사용자는 공개 베타 편집을 저장할 수 없습니다.');
  }
  if (trustLevel !== 'new') return;
  const editCount = await one<{ count: number }>(`SELECT COUNT(*) AS count FROM page_revisions WHERE created_by=:userId`, { userId });
  if (Number(editCount?.count ?? 0) >= Number(settings?.new_user_edit_limit ?? 10)) {
    throw new Error('신규 사용자 편집 제한에 도달했습니다. 검토 후 자동 인증됩니다.');
  }
  const externalLinks = (content.match(/https?:\/\//g) ?? []).length;
  if (externalLinks > Number(settings?.new_user_external_link_limit ?? 2)) {
    throw new Error('신규 사용자는 외부 링크가 많은 편집을 저장할 수 없습니다.');
  }
}

async function syncTrustGroups(userId: number, trustLevel: string) {
  await exec(
    `DELETE ug FROM user_groups ug
     JOIN groups g ON g.id=ug.group_id
     WHERE ug.user_id=:userId AND g.code IN ('autoconfirmed','trusted')`,
    { userId }
  );
  const groupCode = trustLevel === 'trusted' ? 'trusted' : trustLevel === 'autoconfirmed' ? 'autoconfirmed' : null;
  if (!groupCode) return;
  await exec(
    `INSERT IGNORE INTO user_groups (user_id, group_id)
     SELECT :userId, id FROM groups WHERE code=:groupCode`,
    { userId, groupCode }
  );
}

export async function rebuildOpenBetaWeeklyStats() {
  await exec(
    `REPLACE INTO open_beta_weekly_stats
     (week_start, new_users, active_users, page_views, searches, zero_result_searches, edits, page_creates, rollbacks, reports,
      pending_reviews, approved_reviews, rejected_reviews, server_claims, mod_verifications, file_license_issues, created_at, updated_at)
     SELECT DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY),
       (SELECT COUNT(*) FROM users WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(DISTINCT created_by) FROM page_revisions WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM page_view_logs WHERE viewed_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM search_query_logs WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM search_query_logs WHERE result_count=0 AND created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM recent_changes WHERE change_type='edit' AND created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM recent_changes WHERE change_type='create' AND created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM page_revision_actions WHERE action='rollback' AND created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM reports WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM pending_reviews WHERE status='pending'),
       (SELECT COUNT(*) FROM pending_reviews WHERE status='approved' AND reviewed_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM pending_reviews WHERE status='rejected' AND reviewed_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM server_claims WHERE created_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM mod_verification_tasks WHERE status='done' AND updated_at >= DATE_SUB(CURDATE(), INTERVAL WEEKDAY(CURDATE()) DAY)),
       (SELECT COUNT(*) FROM files WHERE (license IS NULL OR license='') AND status='normal'),
       NOW(), NOW()`
  );
  return one<any>(`SELECT ${openBetaWeeklyStatsFields} FROM open_beta_weekly_stats ORDER BY week_start DESC LIMIT 1`);
}

export async function rebuildDailyOperationSummary() {
  await exec(
    `REPLACE INTO daily_operation_summary
     (summary_date, edits, page_creates, pending_reviews, open_reports, urgent_reports, rollbacks, zero_result_searches,
      server_claims_pending, server_disputes, outdated_mod_pages, file_license_issues, failed_jobs, created_at, updated_at)
     SELECT CURDATE(),
       (SELECT COUNT(*) FROM recent_changes WHERE change_type='edit' AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM recent_changes WHERE change_type='create' AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM pending_reviews WHERE status='pending'),
       (SELECT COUNT(*) FROM reports WHERE status IN ('open','reviewing')),
       (SELECT COUNT(*) FROM admin_work_items WHERE work_type='report' AND priority='urgent' AND status IN ('open','in_progress')),
       (SELECT COUNT(*) FROM page_revision_actions WHERE action='rollback' AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM search_query_logs WHERE result_count=0 AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM server_claims WHERE status='pending'),
       (SELECT COUNT(*) FROM reports WHERE target_type='server' AND status IN ('open','reviewing')),
       (SELECT COUNT(*) FROM page_quality_status pqs JOIN pages p ON p.id=pqs.page_id JOIN namespaces n ON n.id=p.namespace_id WHERE n.code='mod' AND pqs.status IN ('needs_check','outdated','partial_old')),
       (SELECT COUNT(*) FROM files WHERE (license IS NULL OR license='') AND status='normal'),
       (SELECT COUNT(*) FROM job_queue WHERE status='failed'),
       NOW(), NOW()`
  );
  return one<any>(`SELECT ${dailyOperationSummaryFields} FROM daily_operation_summary WHERE summary_date=CURDATE()`);
}

export async function namespaceId(code: NamespaceCode, conn?: mysql.PoolConnection) {
  if (conn) {
    const [rows] = await conn.query(`SELECT id FROM namespaces WHERE code=?`, [code]);
    const ns = (rows as any[])[0];
    if (!ns) throw new Error(`Unknown namespace: ${code}`);
    return Number(ns.id);
  }
  const ns = await one<{ id: number }>(`SELECT id FROM namespaces WHERE code=:code`, { code });
  if (!ns) throw new Error(`Unknown namespace: ${code}`);
  return Number(ns.id);
}

async function pageSpaceForTitle(namespace: NamespaceCode, title: string, conn: mysql.PoolConnection) {
  const root = String(title).split('/')[0];
  const userRoot = namespace === 'main' ? userWikiRootFromTitle(title) : null;
  if (userRoot) {
    const [userWikiRows] = await conn.query(
      `SELECT id FROM wiki_spaces WHERE code=? AND space_type='user_wiki' LIMIT 1`,
      [`user-${userRoot}`]
    );
    const userWiki = (userWikiRows as any[])[0];
    if (userWiki) {
      const slashAt = title.indexOf('/');
      return {
        spaceId: Number(userWiki.id),
        localPath: slashAt >= 0 ? title.slice(slashAt + 1) || '대문' : '대문'
      };
    }
  }
  if (root && ['server', 'mod'].includes(namespace)) {
    const [subwikiRows] = await conn.query(
      `SELECT id FROM wiki_spaces WHERE code=? AND space_type IN ('server_wiki','mod_wiki') LIMIT 1`,
      [`${namespace}-${root}`]
    );
    const subwiki = (subwikiRows as any[])[0];
    if (subwiki) {
      const slashAt = title.indexOf('/');
      return {
        spaceId: Number(subwiki.id),
        localPath: slashAt >= 0 ? title.slice(slashAt + 1) || '대문' : '대문'
      };
    }
  }
  const [spaceRows] = await conn.query(
    `SELECT id FROM wiki_spaces
     WHERE root_namespace_code=? AND space_type NOT IN ('server_wiki','mod_wiki','user_wiki')
     ORDER BY parent_space_id IS NULL DESC, id
     LIMIT 1`,
    [namespace]
  );
  const space = (spaceRows as any[])[0];
  return {
    spaceId: space ? Number(space.id) : null,
    localPath: title
  };
}

function defaultProtectionLevel(namespace: NamespaceCode, title: string) {
  const normalized = normalizeTitle(title);
  if (namespace === 'main' && normalized === '대문') return 'review_required';
  if (namespace === 'main' && userWikiRootFromTitle(normalized)) return 'owner_only';
  if ((namespace === 'server' || namespace === 'mod') && normalized.includes('/')) return 'official_only';
  return 'open';
}

function userWikiRootFromTitle(title: string) {
  const normalized = normalizeTitle(title);
  if (!normalized.startsWith('사용자:')) return '';
  return normalized.slice('사용자:'.length).split('/')[0] ?? '';
}

function normalizeProtectionLevel(value: unknown) {
  const level = String(value ?? '').trim();
  return ['open', 'login_required', 'review_required', 'autoconfirmed_only', 'trusted_only', 'official_only', 'owner_only', 'admin_only', 'locked'].includes(level) ? level : null;
}

export async function savePage(input: PageWrite): Promise<SavePageResult> {
  if (input.content.length > maxSavedPageContentLength) {
    throw new Error('content_too_large');
  }
  const parsed = parseMarkup(input.content);
  if (parsed.blockingErrors.length > 0) {
    throw new Error(parsed.blockingErrors.join('\n'));
  }
  const editFilterHits = input.skipReview ? [] : await evaluateEditFilters(input.content, input.namespace, parsed.components);
  if (editFilterHits.some((hit) => hit.actionTaken === 'blocked')) {
    throw new Error(`편집 필터에 의해 저장이 차단되었습니다: ${editFilterHits.map((hit) => hit.name).join(', ')}`);
  }
  const slug = slugifyTitle(input.title);
  const displayTitle = input.displayTitle ?? input.title;
  const contentHash = hashContent(input.content);

  return tx(async (conn) => {
    const nsId = await namespaceId(input.namespace, conn);
    const pageSpace = await pageSpaceForTitle(input.namespace, input.title, conn);
    const [pageRows] = await conn.query(`SELECT ${pageFields} FROM pages WHERE namespace_id=? AND slug=?`, [nsId, slug]);
    let page = (pageRows as any[])[0] as any | undefined;
    const reviewHits = editFilterHits.filter((hit) => hit.actionTaken === 'review_required');
    const forcedReviewReason = String(input.forceReviewReason ?? '').trim();
    if ((reviewHits.length > 0 || forcedReviewReason) && !input.skipReview) {
      const reason = [
        reviewHits.length > 0 ? `편집 필터: ${reviewHits.map((hit) => hit.name).join(', ')}` : '',
        forcedReviewReason
      ]
        .filter(Boolean)
        .join(' / ')
        .slice(0, 255);
      const [review] = await conn.execute(
        `INSERT INTO pending_reviews (review_type, target_id, page_id, submitted_by, reason, created_at)
         VALUES ('revision', ?, ?, ?, ?, NOW())`,
        [page?.id ?? 0, page?.id ?? null, input.userId ?? null, reason]
      );
      const reviewId = Number((review as mysql.ResultSetHeader).insertId);
      const editTags = [...new Set([...(input.editTags ?? []), ...editFilterHits.map((hit) => `filter:${hit.actionTaken}`)])].slice(0, 20);
      await conn.execute(
        `INSERT INTO pending_review_drafts (review_id, namespace_code, title, content_raw, edit_summary, page_type, base_revision_id, is_minor, edit_tags, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
        [
          reviewId,
          input.namespace,
          input.title,
          input.content,
          input.summary ?? null,
          input.pageType ?? null,
          input.baseRevisionId ?? null,
          input.isMinor ? 1 : 0,
          JSON.stringify(editTags)
        ]
      );
      for (const hit of editFilterHits) {
        await conn.execute(
          `INSERT INTO edit_filter_hits (filter_id, page_id, revision_id, user_id, action_taken, snippet, created_at)
           VALUES (?, ?, NULL, ?, ?, ?, NOW())`,
          [hit.id, page?.id ?? null, input.userId ?? null, hit.actionTaken, hit.snippet]
        );
      }
      await conn.execute(
        `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
         VALUES ('pending_review', 'pending_review', ?, 'normal', NOW(), NOW())`,
        [reviewId]
      );
      return { pending: true, pendingReviewId: reviewId, parsed, html: renderDocument(parsed.ast) };
    }
    if (!page) {
      const [insertPage] = await conn.execute(
        `INSERT INTO pages (namespace_id, space_id, local_path, slug, title, display_title, page_type, protection_level, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          nsId,
          pageSpace.spaceId,
          pageSpace.localPath,
          slug,
          input.title,
          displayTitle,
          input.pageType ?? inferPageType(input.namespace, parsed.components),
          defaultProtectionLevel(input.namespace, input.title),
          input.userId ?? null
        ]
      );
      const pageId = Number((insertPage as mysql.ResultSetHeader).insertId);
      const [newRows] = await conn.query(`SELECT ${pageFields} FROM pages WHERE id=?`, [pageId]);
      page = (newRows as any[])[0];
    }

    const missingLinks = await missingLinkKeys(conn, parsed.links);
    const fileNames = extractFileNames(parsed.ast);
    const files = await fileRenderMap(conn, fileNames);
    const officialAreas = await officialAreaMap(conn, parsed.components);
    const html = renderDocument(parsed.ast, { missingLinks, files, officialAreas });
    const [revisionRows] = await conn.query(`SELECT COALESCE(MAX(revision_no),0) + 1 AS nextNo FROM page_revisions WHERE page_id=?`, [
      page.id
    ]);
    const revisionNo = Number((revisionRows as any[])[0].nextNo);
    const parentRevisionId = page.current_revision_id ? Number(page.current_revision_id) : null;
    const editTags = [...new Set([...(input.editTags ?? []), ...editFilterHits.map((hit) => `filter:${hit.actionTaken}`)])].slice(0, 20);
    const actorIpText = input.userId ? null : normalizeActorIpText(input.actorIpText);
    const actorType = actorIpText ? 'ip' : 'user';
    const [insertRevision] = await conn.execute(
      `INSERT INTO page_revisions
       (page_id, revision_no, parent_revision_id, content_raw, content_ast, content_hash, content_size, syntax_version, edit_summary, is_minor, edit_tags, created_by,
        actor_type, actor_user_id, actor_ip, actor_ip_text, actor_ip_hash, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'bwm-0.3', ?, ?, ?, ?, ?, ?, INET6_ATON(?), ?, ?, NOW())`,
      [
        page.id,
        revisionNo,
        parentRevisionId,
        input.content,
        JSON.stringify(parsed.ast),
        contentHash,
        Buffer.byteLength(input.content, 'utf8'),
        input.summary ?? null,
        input.isMinor ? 1 : 0,
        JSON.stringify(editTags),
        input.userId ?? null,
        actorType,
        input.userId ?? null,
        actorIpText,
        actorIpText,
        actorIpText ? hashContent(actorIpText) : null
      ]
    );
    const revisionId = Number((insertRevision as mysql.ResultSetHeader).insertId);
    await conn.execute(`UPDATE pages SET current_revision_id=?, space_id=?, local_path=?, title=?, display_title=?, status='normal', updated_at=NOW() WHERE id=?`, [
      revisionId,
      pageSpace.spaceId,
      pageSpace.localPath,
      input.title,
      displayTitle,
      page.id
    ]);
    await conn.execute(
      `INSERT INTO page_render_cache
       (page_id, revision_id, renderer_version, html, toc_json, headings_json, warnings_json, footnotes_json, links_json, categories_json, components_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE html=VALUES(html), toc_json=VALUES(toc_json), headings_json=VALUES(headings_json), warnings_json=VALUES(warnings_json), footnotes_json=VALUES(footnotes_json), links_json=VALUES(links_json), categories_json=VALUES(categories_json), components_json=VALUES(components_json)`,
      [
        page.id,
        revisionId,
        config.rendererVersion,
        html,
        JSON.stringify(parsed.headings),
        JSON.stringify(parsed.headings),
        JSON.stringify(parsed.errors),
        JSON.stringify(parsed.footnotes),
        JSON.stringify(parsed.links),
        JSON.stringify(parsed.categories),
        JSON.stringify(parsed.components)
      ]
    );

    await replaceLinks(conn, Number(page.id), parsed.links);
    await replaceFileUsages(conn, Number(page.id), fileNames);
    await replaceCategories(conn, Number(page.id), parsed.categories);
    await replaceAliases(conn, Number(page.id), nsId, input.title, parsed.redirectTarget, parsed.components);
    await replaceStructuredData(conn, Number(page.id), parsed.components, {
      reviewModLinkChanges: !input.skipReview,
      revisionId,
      userId: input.userId ?? null
    });
    await replaceVerification(conn, Number(page.id), parsed.components);
    await replaceQualityStatus(conn, Number(page.id), parsed, input.namespace);
    await replaceSearchIndex(conn, Number(page.id), nsId, input.title, parsed.plainText, parsed.categories, parsed.components);
    await markPageRequestsCreated(conn, nsId, input.title, Number(page.id));
    await conn.execute(
      `INSERT INTO recent_changes (page_id, revision_id, actor_id, change_type, title, namespace_code, summary, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, NOW())`,
      [page.id, revisionId, input.userId ?? null, revisionNo === 1 ? 'create' : 'edit', input.title, input.namespace, input.summary ?? null]
    );
    for (const hit of editFilterHits) {
      await conn.execute(
        `INSERT INTO edit_filter_hits (filter_id, page_id, revision_id, user_id, action_taken, snippet, created_at)
         VALUES (?, ?, ?, ?, ?, ?, NOW())`,
        [hit.id, page.id, revisionId, input.userId ?? null, hit.actionTaken, hit.snippet]
      );
      if (hit.actionTaken === 'review_required') {
        const [review] = await conn.execute(
          `INSERT INTO pending_reviews (review_type, target_id, page_id, submitted_by, reason, created_at)
           VALUES ('revision', ?, ?, ?, ?, NOW())`,
          [revisionId, page.id, input.userId ?? null, `편집 필터: ${hit.name}`]
        );
        await conn.execute(
          `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
           VALUES ('pending_review', 'pending_review', ?, 'normal', NOW(), NOW())`,
          [Number((review as mysql.ResultSetHeader).insertId)]
        );
      }
    }

    return { pageId: Number(page.id), revisionId, revisionNo, parsed, html };
  });
}

function appliedPage(result: SavePageResult) {
  if (result.pending) throw new Error('page_requires_review');
  return result;
}

async function evaluateEditFilters(content: string, namespace: NamespaceCode, components: Array<{ name: string; props: Record<string, string> }>) {
  const filters = await query<any>(`SELECT ${editFilterFields} FROM edit_filters WHERE enabled=1`);
  const hits: Array<{ id: number; name: string; actionTaken: 'warned' | 'tagged' | 'blocked' | 'review_required'; snippet: string }> = [];
  for (const filter of filters) {
    let matched = false;
    if (filter.filter_type === 'keyword' && filter.pattern) matched = content.includes(filter.pattern);
    if (filter.filter_type === 'regex' && filter.pattern) {
      try {
        matched = new RegExp(filter.pattern, 'i').test(content);
      } catch {
        matched = false;
      }
    }
    if (filter.filter_type === 'link_count') {
      const maxLinks = Number(filter.pattern ?? 20);
      matched = (content.match(/https?:\/\//g) ?? []).length > maxLinks;
    }
    if (filter.filter_type === 'namespace_rule') {
      matched = namespaceRuleMatches(String(filter.pattern ?? ''), namespace);
    }
    if (filter.filter_type === 'component_rule') {
      matched = componentRuleMatches(String(filter.pattern ?? ''), components);
    }
    if (!matched) continue;
    const actionTaken =
      filter.action === 'block_save' ? 'blocked' : filter.action === 'require_review' ? 'review_required' : filter.action === 'tag' ? 'tagged' : 'warned';
    hits.push({ id: Number(filter.id), name: filter.name, actionTaken, snippet: content.slice(0, 500) });
  }
  return hits;
}

function namespaceRuleMatches(pattern: string, namespace: NamespaceCode) {
  const tokens = pattern
    .split(/[,\s|]+/)
    .map((token) => token.trim().replace(/^namespace=/i, '').replace(/:\*$/, ''))
    .filter(Boolean);
  if (tokens.length === 0) return false;
  return tokens.some((token) => token === '*' || token === namespace);
}

function componentRuleMatches(pattern: string, components: Array<{ name: string; props: Record<string, string> }>) {
  const tokens = pattern
    .split(/[,\s|]+/)
    .map((token) => token.trim().replace(/^component=/i, ''))
    .filter(Boolean);
  if (tokens.length === 0) return false;
  const names = new Set(components.map((component) => component.name));
  return tokens.some((token) => names.has(token));
}

export async function getSection(pageId: number, anchor: string) {
  const page = await getPageById(pageId);
  if (!page?.content_raw) return null;
  const parsed = parseMarkup(page.content_raw);
  const heading = parsed.headings.find((item) => item.anchor === anchor);
  if (!heading) return null;
  const lines = String(page.content_raw).replace(/\r\n/g, '\n').split('\n');
  return {
    pageId,
    revisionId: Number(page.current_revision_id),
    anchor,
    title: heading.title,
    startLine: heading.startLine,
    endLine: heading.endLine,
    content: lines.slice(heading.startLine - 1, heading.endLine).join('\n')
  };
}

export async function saveSection(pageId: number, anchor: string, content: string, baseRevisionId: number, userId: number | null) {
  const page = await getPageById(pageId);
  if (!page?.content_raw) throw new Error('page_not_found');
  if (Number(page.current_revision_id) !== baseRevisionId) throw new Error('edit_conflict');
  const section = await getSection(pageId, anchor);
  if (!section) throw new Error('section_not_found');
  const lines = String(page.content_raw).replace(/\r\n/g, '\n').split('\n');
  const next = [...lines.slice(0, section.startLine - 1), ...content.replace(/\r\n/g, '\n').split('\n'), ...lines.slice(section.endLine)];
  return savePage({
    namespace: page.namespace_code,
    title: page.title,
    content: next.join('\n'),
    summary: `문단 편집: ${section.title}`,
    userId
  });
}

async function replaceLinks(conn: mysql.PoolConnection, pageId: number, links: string[]) {
  await conn.execute(`DELETE FROM page_links WHERE from_page_id=?`, [pageId]);
  for (const target of links) {
    const parsed = parseLinkTarget(target);
    const nsId = await namespaceId(parsed.namespace, conn);
    const slug = slugifyTitle(parsed.title);
    const [targetRows] = await conn.query(`SELECT id FROM pages WHERE namespace_id=? AND slug=? AND status!='deleted'`, [nsId, slug]);
    const toPageId = (targetRows as any[])[0]?.id ?? null;
    await conn.execute(
      `INSERT INTO page_links (from_page_id, to_page_id, target_namespace_id, target_title, link_type, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [pageId, toPageId, nsId, parsed.title, toPageId ? 'internal' : 'missing']
    );
  }
}

async function missingLinkKeys(conn: mysql.PoolConnection, links: string[]) {
  const missing = new Set<string>();
  for (const target of links) {
    const parsed = parseLinkTarget(target);
    const nsId = await namespaceId(parsed.namespace, conn);
    const slug = slugifyTitle(parsed.title);
    const [targetRows] = await conn.query(`SELECT id FROM pages WHERE namespace_id=? AND slug=? AND status!='deleted'`, [nsId, slug]);
    if (!(targetRows as any[])[0]?.id) missing.add(wikiLinkKey(target));
  }
  return missing;
}

function extractFileNames(ast: ReturnType<typeof parseMarkup>['ast']) {
  return [...new Set(ast.filter((node) => node.type === 'file').map((node) => node.fileName))];
}

async function fileRenderMap(conn: mysql.PoolConnection, fileNames: string[]) {
  if (fileNames.length === 0) return {};
  const [rows] = await conn.query(
    `SELECT file_name, original_name, storage_key, mime_type, license, source_text
     FROM files
     WHERE file_name IN (?) AND status='normal'`,
    [fileNames]
  );
  return Object.fromEntries(
    (rows as any[]).map((file) => [
      file.file_name,
      {
        url: `${config.cdnPublicUrl}/${file.storage_key}`,
        mimeType: file.mime_type,
        originalName: file.original_name,
        license: file.license,
        sourceText: file.source_text
      }
    ])
  );
}

async function officialAreaMap(conn: mysql.PoolConnection, components: Array<{ name: string; props: Record<string, string> }>) {
  const targets = [
    ...new Set(
      components
        .filter((component) => component.name === 'official_area')
        .map((component) => component.props['문서'])
        .filter(Boolean)
    )
  ];
  const entries: Array<[string, { status: string; lastModifiedAt?: string | null; renewalRequiredAt?: string | null }]> = [];
  for (const target of targets) {
    const parsed = parseLinkTarget(target);
    if (parsed.namespace !== 'server') continue;
    const serverRootTitle = parsed.title.split('/')[0];
    const serverNsId = await namespaceId('server', conn);
    const targetSlug = slugifyTitle(parsed.title);
    const rootSlug = slugifyTitle(serverRootTitle);
    const [targetRows] = await conn.query(`SELECT id, updated_at FROM pages WHERE namespace_id=? AND slug=? AND status!='deleted' LIMIT 1`, [
      serverNsId,
      targetSlug
    ]);
    const [rootRows] = await conn.query(`SELECT id FROM pages WHERE namespace_id=? AND slug=? AND status!='deleted' LIMIT 1`, [serverNsId, rootSlug]);
    const rootPageId = (rootRows as any[])[0]?.id ?? null;
    const [claimRows] = rootPageId
      ? await conn.query(
          `SELECT
             CASE
               WHEN status='verified' AND renewal_required_at IS NOT NULL AND renewal_required_at <= NOW() THEN 'renewal_required'
               WHEN status='verified' THEN 'verified'
               ELSE status
             END AS verification_status,
             renewal_required_at
           FROM server_claims
           WHERE page_id=? AND status IN ('verified','expired','revoked')
           ORDER BY FIELD(status, 'verified', 'expired', 'revoked'), COALESCE(last_verified_at, verified_at, updated_at) DESC
           LIMIT 1`,
          [rootPageId]
        )
      : [[]];
    entries.push([
      target,
      {
        status: (claimRows as any[])[0]?.verification_status ?? 'unverified',
        lastModifiedAt: (targetRows as any[])[0]?.updated_at ?? null,
        renewalRequiredAt: (claimRows as any[])[0]?.renewal_required_at ?? null
      }
    ]);
  }
  return Object.fromEntries(entries);
}

async function replaceFileUsages(conn: mysql.PoolConnection, pageId: number, fileNames: string[]) {
  await conn.execute(`DELETE FROM file_usages WHERE page_id=?`, [pageId]);
  if (fileNames.length === 0) return;
  const fileNamespaceId = await namespaceId('file', conn);
  for (const fileName of fileNames) {
    await conn.execute(
      `INSERT INTO page_links (from_page_id, to_page_id, target_namespace_id, target_title, link_type, created_at)
       VALUES (?, NULL, ?, ?, 'file', NOW())`,
      [pageId, fileNamespaceId, fileName]
    );
  }
  const [rows] = await conn.query(`SELECT id, file_name FROM files WHERE file_name IN (?) AND status='normal'`, [fileNames]);
  for (const file of rows as any[]) {
    await conn.execute(
      `INSERT INTO file_usages (file_id, page_id, usage_context, created_at)
       VALUES (?, ?, 'document', NOW())
       ON DUPLICATE KEY UPDATE usage_context=VALUES(usage_context)`,
      [file.id, pageId]
    );
  }
}

async function replaceCategories(conn: mysql.PoolConnection, pageId: number, categories: string[]) {
  await conn.execute(`DELETE FROM page_categories WHERE page_id=?`, [pageId]);
  for (const title of categories) {
    const slug = slugifyTitle(title);
    await conn.execute(
      `INSERT INTO categories (slug, title, created_at)
       VALUES (?, ?, NOW())
       ON DUPLICATE KEY UPDATE title=VALUES(title)`,
      [slug, title]
    );
    const [rows] = await conn.query(`SELECT id FROM categories WHERE slug=?`, [slug]);
    const categoryId = (rows as any[])[0].id;
    await conn.execute(`INSERT IGNORE INTO page_categories (page_id, category_id, source, created_at) VALUES (?, ?, 'manual', NOW())`, [
      pageId,
      categoryId
    ]);
  }
}

async function replaceAliases(
  conn: mysql.PoolConnection,
  pageId: number,
  namespaceIdValue: number,
  pageTitle: string,
  redirectTarget: string | null,
  components: Array<{ name: string; props: Record<string, string> }>
) {
  await conn.execute(`DELETE FROM page_aliases WHERE target_page_id=? AND alias_type!='redirect'`, [pageId]);
  await conn.execute(`DELETE FROM page_aliases WHERE namespace_id=? AND alias_slug=? AND alias_type='redirect'`, [namespaceIdValue, slugifyTitle(pageTitle)]);
  if (redirectTarget) {
    const target = parseLinkTarget(redirectTarget);
    const targetNamespaceId = await namespaceId(target.namespace, conn);
    const [targetRows] = await conn.query(`SELECT id FROM pages WHERE namespace_id=? AND slug=? AND status!='deleted' LIMIT 1`, [
      targetNamespaceId,
      slugifyTitle(target.title)
    ]);
    const targetPage = (targetRows as any[])[0];
    if (targetPage) {
      await conn.execute(
        `INSERT IGNORE INTO page_aliases (namespace_id, alias_slug, alias_title, target_page_id, alias_type, created_at)
         VALUES (?, ?, ?, ?, 'redirect', NOW())`,
        [namespaceIdValue, slugifyTitle(pageTitle), pageTitle, targetPage.id]
      );
    }
  }
  for (const component of components) {
    const english = component.props['영문'];
    if (english) {
      await conn.execute(
        `INSERT IGNORE INTO page_aliases (namespace_id, alias_slug, alias_title, target_page_id, alias_type, created_at)
         VALUES (?, ?, ?, ?, 'english', NOW())`,
        [namespaceIdValue, slugifyTitle(english), english, pageId]
      );
    }
  }
}

async function replaceStructuredData(
  conn: mysql.PoolConnection,
  pageId: number,
  components: Array<{ name: string; props: Record<string, string> }>,
  options: StructuredDataOptions = {}
) {
  const byName = new Map(components.map((component) => [component.name, component.props]));
  await replaceDataTables(conn, pageId, components.filter((component) => component.name === 'data_table'));
  if (byName.has('mob_info')) {
    const p = byName.get('mob_info')!;
    await conn.execute(
      `REPLACE INTO entity_mobs
       (page_id, name, english_name, mob_type, health, attack, spawn, drops, experience, editions, added_version, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [pageId, p['이름'] ?? '', p['영문'] ?? null, p['분류'] ?? null, p['체력'] ?? null, p['공격력'] ?? null, p['스폰'] ?? null, p['드롭'] ?? null, p['경험치'] ?? null, p['에디션'] ?? null, p['추가 버전'] ?? null]
    );
  }
  if (byName.has('item_info')) {
    const p = byName.get('item_info')!;
    await conn.execute(
      `REPLACE INTO entity_items
       (page_id, name, english_name, item_type, stack_size, durability, rarity, obtain, usage_text, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [pageId, p['이름'] ?? '', p['영문'] ?? null, p['종류'] ?? null, p['중첩'] ?? null, p['내구도'] ?? null, p['희귀도'] ?? null, p['획득'] ?? null, p['사용처'] ?? null]
    );
  }
  if (byName.has('block_info')) {
    const p = byName.get('block_info')!;
    await conn.execute(
      `REPLACE INTO entity_blocks
       (page_id, name, english_name, block_type, transparent, light, hardness, resistance, tool, stack_size, obtain, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [pageId, p['이름'] ?? '', p['영문'] ?? null, p['종류'] ?? null, p['투명'] ?? null, p['밝기'] ?? null, p['경도'] ?? null, p['폭발 저항'] ?? null, p['도구'] ?? null, p['중첩'] ?? null, p['획득'] ?? null]
    );
  }
  if (byName.has('mod_info')) {
    const p = byName.get('mod_info')!;
    const nextOfficialLinks = p['공식 링크'] ?? null;
    const [[previousMod]] = await conn.query<any[]>(`SELECT official_links FROM entity_mods WHERE page_id=?`, [pageId]);
    const previousOfficialLinks = previousMod?.official_links ?? null;
    const officialLinksChanged = Boolean(previousMod) && shouldReviewModOfficialLinks(previousOfficialLinks, nextOfficialLinks);
    const officialLinksForStorage = officialLinksChanged && options.reviewModLinkChanges ? previousOfficialLinks : nextOfficialLinks;
    await conn.execute(
      `REPLACE INTO entity_mods
       (page_id, name, english_name, category, loaders, supported_versions, client_required, server_required, dependencies, official_links, source_code, license, korean_support, last_checked, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        pageId,
        p['이름'] ?? '',
        p['영문'] ?? null,
        p['분류'] ?? null,
        p['로더'] ?? null,
        p['지원 버전'] ?? null,
        yesNo(p['클라이언트 필요']),
        yesNo(p['서버 필요']),
        p['의존성'] ?? null,
        officialLinksForStorage,
        p['소스 코드'] ?? null,
        p['라이선스'] ?? null,
        p['한국어'] ?? null,
        toDateOrNull(p['마지막 확인'])
      ]
    );
    if (officialLinksChanged && options.reviewModLinkChanges && options.revisionId) {
      await enqueueModLinkReview(conn, {
        pageId,
        revisionId: options.revisionId,
        userId: options.userId ?? null,
        oldOfficialLinks: previousOfficialLinks,
        newOfficialLinks: nextOfficialLinks
      });
    }
    await replaceModLinksFromComponents(conn, pageId, p, officialLinksForStorage);
  }
  const modVersionComponents = components.filter((component) => component.name === 'mod_version_table');
  if (modVersionComponents.length > 0) {
    await replaceModVersionsFromComponents(conn, pageId, modVersionComponents);
  }
  const dependencyComponents = components.filter((component) => component.name === 'dependency_info');
  if (byName.has('mod_info')) {
    await replaceModDependenciesFromComponents(conn, pageId, dependencyComponents, byName.get('mod_info')?.['의존성'] ?? null);
  }
  if (byName.has('server_info')) {
    const p = byName.get('server_info')!;
    await conn.execute(
      `REPLACE INTO entity_servers
       (page_id, name, host, edition, supported_versions, genres, verified_status, operational_status, whitelist, discord_url, website_url, status_enabled, last_checked, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        pageId,
        p['이름'] ?? '',
        p['주소'] ?? null,
        serverEdition(p['에디션']),
        p['지원 버전'] ?? null,
        p['장르'] ?? null,
        p['인증']?.includes('운영자') ? 'verified' : 'none',
        serverOperationalStatus(p['운영 상태'] ?? p['상태'] ?? (p['인증']?.includes('운영자') ? '운영 중' : '')),
        p['화이트리스트'] ?? null,
        p['디스코드'] ?? null,
        p['공식 사이트'] ?? null,
        p['상태 확인'] === '사용' ? 1 : 0,
        toDateOrNull(p['마지막 확인'])
      ]
    );
    if (p['주소'] && p['상태 확인'] === '사용') {
      await conn.execute(
        `INSERT INTO server_endpoints (page_id, host, port, edition, enabled, created_at, updated_at)
         VALUES (?, ?, 25565, ?, 1, NOW(), NOW())
         ON DUPLICATE KEY UPDATE host=VALUES(host), edition=VALUES(edition), enabled=1, updated_at=NOW()`,
        [pageId, p['주소'], serverEdition(p['에디션']) === 'bedrock' ? 'bedrock' : 'java']
      );
    } else {
      await conn.execute(`UPDATE server_endpoints SET enabled=0, updated_at=NOW() WHERE page_id=?`, [pageId]);
    }
  }
}

function shouldReviewModOfficialLinks(oldValue: unknown, newValue: unknown) {
  return normalizeStructuredLinkValue(oldValue) !== normalizeStructuredLinkValue(newValue);
}

function normalizeStructuredLinkValue(value: unknown) {
  return String(value ?? '').trim().replace(/\s+/g, ' ');
}

async function replaceDataTables(conn: mysql.PoolConnection, pageId: number, components: Array<{ props: Record<string, string> }>) {
  await conn.execute(`DELETE dtr FROM data_table_rows dtr JOIN data_tables dt ON dt.id=dtr.table_id WHERE dt.page_id=?`, [pageId]);
  await conn.execute(`DELETE FROM data_tables WHERE page_id=?`, [pageId]);
  for (const [index, component] of components.entries()) {
    const table = dataTableFromProps(component.props, index);
    if (table.rows.length === 0) continue;
    const [result] = await conn.execute(
      `INSERT INTO data_tables (page_id, table_key, caption, headers_json, source_component_index, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [pageId, table.key, table.caption, JSON.stringify(table.headers), index]
    );
    const tableId = Number((result as mysql.ResultSetHeader).insertId);
    for (const [rowIndex, row] of table.rows.entries()) {
      await conn.execute(
        `INSERT INTO data_table_rows (table_id, row_no, cells_json, created_at)
         VALUES (?, ?, ?, NOW())`,
        [tableId, rowIndex + 1, JSON.stringify(row)]
      );
    }
  }
}

function dataTableFromProps(props: Record<string, string>, index: number) {
  const caption = String(props['제목'] ?? props['이름'] ?? '데이터 표').trim() || '데이터 표';
  const key = normalizeDataTableKey(props['키'] ?? props['이름'] ?? props['제목'] ?? `table-${index + 1}`);
  return {
    key,
    caption,
    headers: componentHeaders(props, []),
    rows: componentRows(props).filter((row) => row.some((cell) => cell))
  };
}

function normalizeDataTableKey(value: unknown) {
  return normalizeTitle(String(value ?? 'default'))
    .replace(/[^\p{Letter}\p{Number}_-]/gu, '_')
    .slice(0, 128) || 'default';
}

async function replaceModVersionsFromComponents(conn: mysql.PoolConnection, pageId: number, components: Array<{ props: Record<string, string> }>) {
  const rows = components.flatMap((component) => parseModVersionComponentRows(component.props));
  if (rows.length === 0) return;
  await conn.execute(`DELETE FROM mod_versions WHERE page_id=?`, [pageId]);
  for (const row of rows) {
    await conn.execute(
      `INSERT INTO mod_versions (page_id, minecraft_version, loader, support_status, note, checked_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [pageId, row.minecraftVersion, row.loader, row.supportStatus, row.note]
    );
  }
}

function parseModVersionComponentRows(props: Record<string, string>) {
  const rows = componentRows(props);
  if (rows.length > 0) {
    const headers = componentHeaders(props, ['Minecraft', '로더', '상태', '비고']);
    return rows.map((cells) => {
      const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
      return normalizeModVersionRow(row);
    }).filter((row) => row.minecraftVersion);
  }
  const row = normalizeModVersionRow(props);
  return row.minecraftVersion ? [row] : [];
}

function normalizeModVersionRow(row: Record<string, string>) {
  return {
    minecraftVersion: String(row['Minecraft'] ?? row['마인크래프트'] ?? row['버전'] ?? '').trim(),
    loader: normalizeModLoader(row['로더']),
    supportStatus: normalizeSupportStatus(row['상태'] ?? row['지원'] ?? row['지원 상태']),
    note: stringValue(row['비고'] ?? row['변경점'] ?? row['모드 버전'])
  };
}

async function replaceModLinksFromComponents(conn: mysql.PoolConnection, pageId: number, props: Record<string, string>, officialLinks: unknown) {
  const rows = [
    ...parseModLinkText(officialLinks),
    ...parseModLinkText(props['소스 코드']).map((row) => ({ ...row, linkType: row.linkType === 'official' ? 'github' : row.linkType }))
  ];
  await conn.execute(`DELETE FROM mod_links WHERE page_id=?`, [pageId]);
  for (const row of rows) {
    await conn.execute(
      `INSERT INTO mod_links (page_id, link_type, url, status, checked_at, created_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())`,
      [pageId, row.linkType, row.url, row.status]
    );
  }
}

function parseModLinkText(value: unknown) {
  return String(value ?? '')
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [typeMaybe, urlMaybe, statusMaybe] = line.split('|').map((part) => part.trim());
      const url = urlMaybe && /^https?:\/\//i.test(urlMaybe) ? urlMaybe : typeMaybe;
      const type = urlMaybe && !/^https?:\/\//i.test(typeMaybe) ? typeMaybe : inferModLinkType(url);
      return {
        linkType: normalizeModLinkType(type),
        url,
        status: normalizeModLinkStatus(statusMaybe)
      };
    })
    .filter((row) => /^https?:\/\//i.test(row.url));
}

async function replaceModDependenciesFromComponents(conn: mysql.PoolConnection, pageId: number, components: Array<{ props: Record<string, string> }>, fallback: unknown) {
  const rows = [
    ...components.flatMap((component) => parseDependencyComponentRows(component.props)),
    ...parseDependencyText(fallback)
  ];
  if (rows.length === 0 && components.length === 0 && !String(fallback ?? '').trim()) return;
  await conn.execute(`DELETE FROM mod_dependencies WHERE page_id=?`, [pageId]);
  for (const row of uniqueDependencies(rows)) {
    await conn.execute(
      `INSERT INTO mod_dependencies (page_id, dependency_name, required_type, note)
       VALUES (?, ?, ?, ?)`,
      [pageId, row.dependencyName, row.requiredType, row.note]
    );
  }
}

function parseDependencyComponentRows(props: Record<string, string>) {
  const rows = componentRows(props);
  if (rows.length === 0) return parseDependencyText(props['이름']);
  const headers = componentHeaders(props, ['이름', '범위', '버전', '비고']);
  return rows.map((cells) => {
    const row = Object.fromEntries(headers.map((header, index) => [header, cells[index] ?? '']));
    const version = String(row['버전'] ?? '').trim();
    const note = [version, row['비고']].filter(Boolean).join(' · ');
    return {
      dependencyName: String(row['이름'] ?? '').trim(),
      requiredType: normalizeDependencyType(row['범위'] ?? row['유형']),
      note: stringValue(note)
    };
  }).filter((row) => row.dependencyName);
}

function parseDependencyText(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text || ['없음', '해당 없음', '문서 참조', '알 수 없음'].includes(text)) return [];
  return text
    .split(/\r?\n|,/)
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts) => parts[0])
    .map(([dependencyName, requiredType, note]) => ({
      dependencyName,
      requiredType: normalizeDependencyType(requiredType),
      note: stringValue(note)
    }));
}

function componentHeaders(props: Record<string, string>, fallback: string[]) {
  return String(props['열'] ?? fallback.join(','))
    .split(',')
    .map((item) => item.trim())
    .filter(Boolean);
}

function componentRows(props: Record<string, string>) {
  return Object.entries(props)
    .filter(([key]) => /^행\d+$/.test(key))
    .sort(([a], [b]) => Number(a.replace(/\D/g, '')) - Number(b.replace(/\D/g, '')))
    .map(([, value]) => value.split(',').map((cell) => cell.trim()));
}

function uniqueDependencies(rows: Array<{ dependencyName: string; requiredType: string; note: string | null }>) {
  const seen = new Set<string>();
  return rows.filter((row) => {
    const key = normalizeSearch(row.dependencyName);
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function normalizeModLoader(value: unknown) {
  const loader = String(value ?? '').trim().toLowerCase();
  return ['forge', 'fabric', 'quilt', 'neoforge'].includes(loader) ? loader : 'unknown';
}

function normalizeSupportStatus(value: unknown) {
  const status = String(value ?? '').trim().toLowerCase();
  if (['supported', '지원', '지원됨', '사용 가능'].includes(status)) return 'supported';
  if (['partial', '부분', '부분 지원', '일부'].includes(status)) return 'partial';
  if (['unsupported', '미지원', '지원 중단', '불가'].includes(status)) return 'unsupported';
  return 'unknown';
}

function normalizeModLinkType(value: unknown) {
  const type = String(value ?? '').trim().toLowerCase();
  return ['official', 'modrinth', 'curseforge', 'github', 'wiki', 'discord', 'other'].includes(type) ? type : 'other';
}

function normalizeModLinkStatus(value: unknown) {
  const status = String(value ?? '').trim().toLowerCase();
  if (['active', '정상', '사용'].includes(status)) return 'active';
  if (['broken', '깨짐', '오류'].includes(status)) return 'broken';
  return 'unknown';
}

function normalizeDependencyType(value: unknown) {
  const type = String(value ?? '').trim().toLowerCase();
  if (['optional', '선택', '선택적'].includes(type)) return 'optional';
  if (['incompatible', '충돌', '비호환'].includes(type)) return 'incompatible';
  if (['recommended', '권장'].includes(type)) return 'recommended';
  return 'required';
}

function inferModLinkType(url: string) {
  if (/modrinth\.com/i.test(url)) return 'modrinth';
  if (/curseforge\.com/i.test(url)) return 'curseforge';
  if (/github\.com/i.test(url)) return 'github';
  if (/discord\./i.test(url)) return 'discord';
  return 'official';
}

function stringValue(value: unknown) {
  const text = String(value ?? '').trim();
  return text || null;
}

async function enqueueModLinkReview(
  conn: mysql.PoolConnection,
  input: {
    pageId: number;
    revisionId: number;
    userId: number | null;
    oldOfficialLinks: string | null;
    newOfficialLinks: string | null;
  }
) {
  const reason = '공식 모드 링크 변경 검토';
  const payload = JSON.stringify({
    oldOfficialLinks: input.oldOfficialLinks,
    newOfficialLinks: input.newOfficialLinks,
    revisionId: input.revisionId
  });
  const [review] = await conn.execute(
    `INSERT INTO pending_reviews (review_type, target_id, page_id, submitted_by, reason, payload_json, created_at)
     SELECT 'mod_link', ?, ?, ?, ?, ?, NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM pending_reviews
       WHERE review_type='mod_link' AND page_id=? AND status='pending'
     )`,
    [input.revisionId, input.pageId, input.userId, reason, payload, input.pageId]
  );
  const reviewId = Number((review as mysql.ResultSetHeader).insertId);
  if (Number((review as mysql.ResultSetHeader).affectedRows ?? 0) > 0 && reviewId) {
    await conn.execute(
      `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
       VALUES ('mod_link_review', 'pending_review', ?, 'normal', NOW(), NOW())`,
      [reviewId]
    );
  }
}

async function replaceVerification(conn: mysql.PoolConnection, pageId: number, components: Array<{ name: string; props: Record<string, string> }>) {
  const status = components.find((component) => component.name === 'document_status')?.props;
  if (!status) return;
  await conn.execute(`DELETE FROM page_verifications WHERE page_id=?`, [pageId]);
  await conn.execute(
    `INSERT INTO page_verifications (page_id, edition, minecraft_version, status, reason, created_at)
     VALUES (?, ?, ?, ?, ?, NOW())`,
    [pageId, editionFromText(status['기준']), status['기준'] ?? null, verificationStatus(status['상태']), status['사유'] ?? null]
  );
}

type QualityIssue = {
  type: string;
  severity: 'low' | 'medium' | 'high';
  detail: string;
};

async function replaceQualityStatus(conn: mysql.PoolConnection, pageId: number, parsed: ReturnType<typeof parseMarkup>, namespace: NamespaceCode) {
  const statusProps = parsed.components.find((component) => component.name === 'document_status')?.props;
  const infoComponent = parsed.components.find((component) => ['mob_info', 'item_info', 'block_info', 'mod_info', 'server_info'].includes(component.name));
  const modInfo = parsed.components.find((component) => component.name === 'mod_info')?.props;
  const serverInfo = parsed.components.find((component) => component.name === 'server_info')?.props;
  let status = 'normal';
  const reasons: string[] = [];
  const issues: QualityIssue[] = [];
  if (!statusProps) {
    status = 'needs_check';
    reasons.push('문서 상태 없음');
    issues.push({ type: 'missing_status', severity: 'medium', detail: '문서 상태 컴포넌트가 없습니다.' });
  } else if (statusProps['상태'] === '토막글') {
    status = 'stub';
    issues.push({ type: 'stub', severity: 'low', detail: '문서 상태가 토막글입니다.' });
  } else if (statusProps['상태'] === '검증 필요') status = 'needs_check';
  else if (statusProps['상태'] === '일부 오래됨') {
    status = 'partial_old';
    issues.push({ type: 'outdated', severity: 'medium', detail: '일부 내용이 오래된 상태입니다.' });
  } else if (statusProps['상태'] === '분쟁 중') {
    status = 'disputed';
    issues.push({ type: 'disputed', severity: 'high', detail: '분쟁 중 문서입니다.' });
  }
  if (parsed.plainText.length < 120) {
    status = status === 'normal' ? 'stub' : status;
    reasons.push('문서 길이 짧음');
    issues.push({ type: 'stub', severity: 'low', detail: '본문 길이가 120자 미만입니다.' });
  }
  if (parsed.categories.length === 0) {
    reasons.push('분류 없음');
    issues.push({ type: 'missing_category', severity: 'medium', detail: '분류가 없습니다.' });
  }
  if (parsed.links.length === 0) {
    reasons.push('내부 링크 없음');
    issues.push({ type: 'no_internal_links', severity: 'low', detail: '내부 링크가 없습니다.' });
  }
  if (!infoComponent && !parsed.redirectTarget) {
    reasons.push('정보 컴포넌트 없음');
    issues.push({ type: 'missing_infobox', severity: 'medium', detail: '문서 유형 정보 컴포넌트가 없습니다.' });
  }
  const [missingRows] = await conn.query(`SELECT COUNT(*) AS count FROM page_links WHERE from_page_id=? AND link_type='missing'`, [pageId]);
  const missingLinkCount = Number((missingRows as any[])[0]?.count ?? 0);
  if (missingLinkCount > 0) {
    reasons.push(`깨진 링크 ${missingLinkCount}개`);
    issues.push({ type: 'broken_link', severity: missingLinkCount >= 5 ? 'high' : 'medium', detail: `존재하지 않는 내부 링크 ${missingLinkCount}개가 있습니다.` });
  }
  if ((namespace === 'mod' || modInfo) && !modInfo?.['마지막 확인']) {
    reasons.push('모드 마지막 확인일 없음');
    issues.push({ type: 'mod_missing_check_date', severity: 'medium', detail: '모드 정보에 마지막 확인일이 없습니다.' });
  }
  if ((namespace === 'server' || serverInfo) && !serverInfo?.['주소']) {
    reasons.push('서버 주소 없음');
    issues.push({ type: 'server_missing_address', severity: 'high', detail: '서버 정보에 주소가 없습니다.' });
  }
  await conn.execute(
    `REPLACE INTO page_quality_status (page_id, status, reason, checked_version, checked_at, updated_at)
     VALUES (?, ?, ?, ?, NOW(), NOW())`,
    [pageId, status, reasons.join(', ') || null, statusProps?.['기준'] ?? null]
  );
  const generatedIssueTypes = [
    'missing_status',
    'missing_category',
    'broken_link',
    'stub',
    'outdated',
    'disputed',
    'missing_infobox',
    'no_internal_links',
    'mod_missing_check_date',
    'server_missing_address'
  ];
  await conn.query(`DELETE FROM page_quality_issues WHERE page_id=? AND status='open' AND issue_type IN (?)`, [pageId, generatedIssueTypes]);
  const dedupedIssues = dedupeQualityIssues(issues);
  for (const issue of dedupedIssues) {
    await conn.execute(
      `INSERT INTO page_quality_issues (page_id, issue_type, severity, status, detail, created_at)
       VALUES (?, ?, ?, 'open', ?, NOW())`,
      [pageId, issue.type, issue.severity, issue.detail]
    );
  }
  await createQualityContributorTasks(conn, pageId, dedupedIssues);
}

function dedupeQualityIssues(issues: QualityIssue[]) {
  const seen = new Set<string>();
  return issues.filter((issue) => {
    if (seen.has(issue.type)) return false;
    seen.add(issue.type);
    return true;
  });
}

async function createQualityContributorTasks(conn: mysql.PoolConnection, pageId: number, issues: QualityIssue[]) {
  if (issues.length === 0) return;
  const [pageRows] = await conn.query(`SELECT title FROM pages WHERE id=?`, [pageId]);
  const title = (pageRows as any[])[0]?.title ?? `#${pageId}`;
  for (const issue of issues) {
    const taskType = qualityIssueTaskType(issue.type);
    if (!taskType) continue;
    const taskTitle = `${title}: ${qualityIssueLabel(issue.type)}`;
    const [existing] = await conn.query(
      `SELECT id FROM contributor_tasks
       WHERE task_type=? AND target_type='page' AND target_id=? AND title=? AND status IN ('open','assigned')
       LIMIT 1`,
      [taskType, pageId, taskTitle]
    );
    if ((existing as any[])[0]) continue;
    await conn.execute(
      `INSERT INTO contributor_tasks (task_type, target_type, target_id, title, description, priority, created_at, updated_at)
       VALUES (?, 'page', ?, ?, ?, ?, NOW(), NOW())`,
      [taskType, pageId, taskTitle, issue.detail, issue.severity === 'high' ? 'high' : issue.severity === 'low' ? 'low' : 'normal']
    );
  }
}

function qualityIssueTaskType(issueType: string) {
  const map: Record<string, string> = {
    stub: 'improve_stub',
    missing_status: 'improve_stub',
    missing_infobox: 'improve_stub',
    no_internal_links: 'improve_stub',
    needs_source: 'improve_stub',
    outdated: 'improve_stub',
    disputed: 'policy_review',
    broken_link: 'fix_broken_link',
    missing_category: 'add_category',
    mod_missing_check_date: 'verify_mod',
    server_missing_address: 'verify_server'
  };
  return map[issueType] ?? null;
}

function qualityIssueLabel(issueType: string) {
  const map: Record<string, string> = {
    stub: '토막글 보강',
    missing_status: '문서 상태 추가',
    missing_infobox: '정보상자 추가',
    no_internal_links: '내부 링크 추가',
    needs_source: '출처 보강',
    outdated: '오래된 내용 정리',
    disputed: '분쟁 상태 검토',
    broken_link: '깨진 링크 수정',
    missing_category: '분류 추가',
    mod_missing_check_date: '모드 확인일 검증',
    server_missing_address: '서버 주소 확인'
  };
  return map[issueType] ?? issueType;
}

async function replaceSearchIndex(
  conn: mysql.PoolConnection,
  pageId: number,
  namespaceIdValue: number,
  title: string,
  bodyPlain: string,
  categories: string[],
  components: Array<{ name: string; props: Record<string, string> }>
) {
  const aliases = components.map((component) => component.props['영문']).filter(Boolean).join(' ');
  await conn.execute(
    `REPLACE INTO search_index
     (page_id, namespace_id, title, title_normalized, title_chosung, aliases, body_plain, categories, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [pageId, namespaceIdValue, title, normalizeSearch(title), chosung(title), aliases, bodyPlain, categories.join(' ')]
  );
}

async function markPageRequestsCreated(conn: mysql.PoolConnection, namespaceIdValue: number, title: string, pageId: number) {
  await conn.execute(
    `UPDATE page_requests
     SET status='created', target_page_id=?, updated_at=NOW()
     WHERE namespace_id=? AND requested_title=? AND status='open'`,
    [pageId, namespaceIdValue, title]
  );
}

export async function getPageByTitle(namespace: NamespaceCode, title: string) {
  const ns = await namespaceId(namespace);
  const slug = slugifyTitle(title);
  return one<any>(
    `SELECT ${pageSelectFields}, n.code AS namespace_code, n.display_name AS namespace_name, r.content_raw, c.html, c.toc_json, c.links_json, c.categories_json, c.components_json,
       ml.missing_links_json
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN page_revisions r ON r.id=p.current_revision_id
     LEFT JOIN page_render_cache c ON c.revision_id=p.current_revision_id AND c.renderer_version=:rendererVersion
     LEFT JOIN (
       SELECT pl.from_page_id, JSON_ARRAYAGG(JSON_OBJECT('namespace_code', tn.code, 'title', pl.target_title)) AS missing_links_json
       FROM page_links pl
       JOIN namespaces tn ON tn.id=pl.target_namespace_id
       WHERE pl.link_type='missing'
       GROUP BY pl.from_page_id
     ) ml ON ml.from_page_id=p.id
     WHERE p.namespace_id=:ns AND p.slug=:slug AND p.status NOT IN ('deleted','hidden')`,
    { ns, slug, rendererVersion: config.rendererVersion }
  );
}

export async function getPageByTitleIncludingDeleted(namespace: NamespaceCode, title: string) {
  const ns = await namespaceId(namespace);
  const slug = slugifyTitle(title);
  return one<any>(
    `SELECT ${pageSelectFields}, n.code AS namespace_code, n.display_name AS namespace_name, r.content_raw, c.html, c.toc_json, c.links_json, c.categories_json, c.components_json,
       ml.missing_links_json
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN page_revisions r ON r.id=p.current_revision_id
     LEFT JOIN page_render_cache c ON c.revision_id=p.current_revision_id AND c.renderer_version=:rendererVersion
     LEFT JOIN (
       SELECT pl.from_page_id, JSON_ARRAYAGG(JSON_OBJECT('namespace_code', tn.code, 'title', pl.target_title)) AS missing_links_json
       FROM page_links pl
       JOIN namespaces tn ON tn.id=pl.target_namespace_id
       WHERE pl.link_type='missing'
       GROUP BY pl.from_page_id
     ) ml ON ml.from_page_id=p.id
     WHERE p.namespace_id=:ns AND p.slug=:slug`,
    { ns, slug, rendererVersion: config.rendererVersion }
  );
}

export async function getPageByAlias(namespace: NamespaceCode, aliasTitle: string) {
  const ns = await namespaceId(namespace);
  return one<any>(
    `SELECT ${pageSelectFields}, n.code AS namespace_code, n.display_name AS namespace_name, r.content_raw, c.html, c.toc_json, c.links_json, c.categories_json, c.components_json,
       ml.missing_links_json
     FROM page_aliases pa
     JOIN pages p ON p.id=pa.target_page_id
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN page_revisions r ON r.id=p.current_revision_id
     LEFT JOIN page_render_cache c ON c.revision_id=p.current_revision_id AND c.renderer_version=:rendererVersion
     LEFT JOIN (
       SELECT pl.from_page_id, JSON_ARRAYAGG(JSON_OBJECT('namespace_code', tn.code, 'title', pl.target_title)) AS missing_links_json
       FROM page_links pl
       JOIN namespaces tn ON tn.id=pl.target_namespace_id
       WHERE pl.link_type='missing'
       GROUP BY pl.from_page_id
     ) ml ON ml.from_page_id=p.id
     WHERE pa.namespace_id=:ns AND pa.alias_slug=:slug AND p.status NOT IN ('deleted','hidden')
     LIMIT 1`,
    { ns, slug: slugifyTitle(aliasTitle), rendererVersion: config.rendererVersion }
  );
}

export async function getPageById(id: number) {
  return one<any>(
    `SELECT ${pageSelectFields}, n.code AS namespace_code, n.display_name AS namespace_name, r.content_raw, c.html, c.toc_json, c.links_json, c.categories_json, c.components_json, ml.missing_links_json
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN page_revisions r ON r.id=p.current_revision_id
     LEFT JOIN page_render_cache c ON c.revision_id=p.current_revision_id AND c.renderer_version=:rendererVersion
     LEFT JOIN (
       SELECT pl.from_page_id, JSON_ARRAYAGG(JSON_OBJECT('namespace_code', tn.code, 'title', pl.target_title)) AS missing_links_json
       FROM page_links pl
       JOIN namespaces tn ON tn.id=pl.target_namespace_id
       WHERE pl.link_type='missing'
       GROUP BY pl.from_page_id
     ) ml ON ml.from_page_id=p.id
     WHERE p.id=:id`,
    { id, rendererVersion: config.rendererVersion }
  );
}

export async function searchPages(q: string, limit = 20) {
  q = q.trim().slice(0, 255);
  if (!q) return [];
  limit = Math.max(1, Math.min(100, Number(limit) || 20));
  const normalized = normalizeSearch(q);
  const initial = chosung(q);
  const withIntentBoost = (row: any) => {
    const boost = searchIntentBoost(normalized, String(row.namespace_code ?? ''), String(row.title ?? ''));
    const userWikiPenalty = String(row.namespace_code ?? '') === 'main' && String(row.title ?? '').startsWith('사용자:') ? -120 : 0;
    const score = Number(row.score ?? 0) + boost + userWikiPenalty;
    return boost || userWikiPenalty ? { ...row, score, intent_boost: boost } : row;
  };
  const pins = q
    ? await query<any>(
        `SELECT p.id AS page_id, p.title, n.code AS namespace_code, p.slug, p.space_id, p.local_path,
           ws.code AS space_code, ws.space_type, COALESCE(ws.title, ws.name, n.display_name) AS space_title,
           em.loaders AS mod_loaders, em.supported_versions AS mod_versions,
           es.genres AS server_genres, es.edition AS server_edition, es.verified_status AS server_verified_status, es.operational_status AS server_operational_status,
           2000 AS score, LEFT(si.body_plain, 180) AS excerpt
         FROM search_pins sp
         JOIN pages p ON p.id=sp.page_id
         JOIN namespaces n ON n.id=p.namespace_id
         LEFT JOIN wiki_spaces ws ON ws.id=p.space_id
         LEFT JOIN entity_mods em ON em.page_id=p.id
         LEFT JOIN entity_servers es ON es.page_id=p.id
         LEFT JOIN search_index si ON si.page_id=p.id
         WHERE sp.enabled=1 AND sp.query=:q AND p.status NOT IN ('deleted','hidden')
         ORDER BY sp.id ASC`,
        { q }
      )
    : [];
  const dictionaryRows = q
    ? await query<any>(
        `SELECT p.id AS page_id, p.title, n.code AS namespace_code, p.slug, p.space_id, p.local_path,
           ws.code AS space_code, ws.space_type, COALESCE(ws.title, ws.name, n.display_name) AS space_title,
           em.loaders AS mod_loaders, em.supported_versions AS mod_versions,
           es.genres AS server_genres, es.edition AS server_edition, es.verified_status AS server_verified_status, es.operational_status AS server_operational_status,
           COALESCE(sd.weight, 100) + 1200 AS score,
           CONCAT(sd.term_type, ': ', sd.term) AS excerpt
         FROM search_dictionary sd
         JOIN pages p ON p.id=sd.target_page_id
         JOIN namespaces n ON n.id=p.namespace_id
         LEFT JOIN wiki_spaces ws ON ws.id=p.space_id
         LEFT JOIN entity_mods em ON em.page_id=p.id
         LEFT JOIN entity_servers es ON es.page_id=p.id
         WHERE sd.enabled=1
           AND sd.target_page_id IS NOT NULL
           AND (sd.term=:q OR sd.normalized_term=:normalized OR sd.replacement=:q)
           AND p.status NOT IN ('deleted','hidden')
         ORDER BY sd.weight DESC, sd.id ASC
         LIMIT :limit`,
        { q, normalized, limit }
      )
    : [];
  const disambiguationRows = q
    ? await query<any>(
        `SELECT p.id AS page_id, p.title, n.code AS namespace_code, p.slug, p.space_id, p.local_path,
           ws.code AS space_code, ws.space_type, COALESCE(ws.title, ws.name, n.display_name) AS space_title,
           em.loaders AS mod_loaders, em.supported_versions AS mod_versions,
           es.genres AS server_genres, es.edition AS server_edition, es.verified_status AS server_verified_status, es.operational_status AS server_operational_status,
           COALESCE(sdc.weight, 100) + 1050 AS score,
           CONCAT('동음이의 후보: ', COALESCE(sdc.label, p.title), CASE WHEN sdc.note IS NULL OR sdc.note='' THEN '' ELSE CONCAT(' - ', sdc.note) END) AS excerpt
         FROM search_disambiguation_candidates sdc
         JOIN pages p ON p.id=sdc.page_id
         JOIN namespaces n ON n.id=p.namespace_id
         LEFT JOIN wiki_spaces ws ON ws.id=p.space_id
         LEFT JOIN entity_mods em ON em.page_id=p.id
         LEFT JOIN entity_servers es ON es.page_id=p.id
         WHERE sdc.enabled=1
           AND (sdc.query=:q OR sdc.normalized_query=:normalized)
           AND p.status NOT IN ('deleted','hidden')
         ORDER BY sdc.weight DESC, sdc.id ASC
         LIMIT :limit`,
        { q, normalized, limit }
      )
    : [];
  const dictionaryIgnore = q
    ? await one<{ id: number }>(
        `SELECT id FROM search_dictionary
         WHERE enabled=1 AND target_page_id IS NULL AND action='ignore' AND (term=:q OR normalized_term=:normalized)
         LIMIT 1`,
        { q, normalized }
      )
    : null;
  if (dictionaryIgnore) return [];
  const rows = await query<any>(
    `SELECT si.page_id, si.title, n.code AS namespace_code, p.slug, p.space_id, p.local_path,
      ws.code AS space_code, ws.space_type, COALESCE(ws.title, ws.name, n.display_name) AS space_title,
      em.loaders AS mod_loaders, em.supported_versions AS mod_versions,
      es.genres AS server_genres, es.edition AS server_edition, es.verified_status AS server_verified_status, es.operational_status AS server_operational_status,
      CASE
        WHEN st.term = :q OR st.normalized = :normalized THEN COALESCE(st.weight, 1100)
        WHEN si.title = :q THEN 1000
        WHEN si.title_normalized = :normalized THEN 900
        WHEN si.aliases LIKE :like OR pa.alias_title LIKE :like OR st.term LIKE :like THEN 800
        WHEN si.title_normalized LIKE :prefix THEN 700
        WHEN si.title_chosung LIKE :initialPrefix THEN 600
        WHEN si.body_plain LIKE :like THEN 300
        ELSE 100
      END AS score,
      LEFT(si.body_plain, 180) AS excerpt
     FROM search_index si
     JOIN pages p ON p.id=si.page_id
     JOIN namespaces n ON n.id=si.namespace_id
     LEFT JOIN wiki_spaces ws ON ws.id=p.space_id
     LEFT JOIN entity_mods em ON em.page_id=p.id
     LEFT JOIN entity_servers es ON es.page_id=p.id
     LEFT JOIN page_aliases pa ON pa.target_page_id=p.id
     LEFT JOIN search_terms st ON st.target_page_id=p.id
     WHERE p.status NOT IN ('deleted','hidden')
       AND (si.title LIKE :like OR si.title_normalized LIKE :prefix OR si.title_chosung LIKE :initialPrefix
         OR si.aliases LIKE :like OR pa.alias_title LIKE :like OR pa.alias_slug LIKE :aliasSlug
         OR st.term LIKE :like OR st.normalized LIKE :prefix
         OR si.body_plain LIKE :like OR si.categories LIKE :like)
     GROUP BY si.page_id, si.title, n.code, p.slug, p.space_id, p.local_path, ws.code, ws.space_type, ws.title, ws.name, n.display_name,
       em.loaders, em.supported_versions, es.genres, es.edition, es.verified_status, es.operational_status,
       si.title_normalized, si.title_chosung, si.aliases, si.body_plain, p.updated_at, pa.alias_title, st.term, st.normalized, st.weight
     ORDER BY score DESC, p.updated_at DESC
     LIMIT :limit`,
    {
      q,
      normalized,
      like: `%${q}%`,
      aliasSlug: `%${q.replace(/\s+/g, '_')}%`,
      prefix: `${normalized}%`,
      initialPrefix: `${initial}%`,
      limit: limit * 4
    }
  );
  const seen = new Set<number>();
  return [...pins, ...disambiguationRows, ...dictionaryRows, ...rows]
    .map(withIntentBoost)
    .filter((row) => {
      if (isPrivateUserWorkspaceSearchResult(row)) return false;
      if (seen.has(Number(row.page_id))) return false;
      seen.add(Number(row.page_id));
      return true;
    })
    .sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
    .slice(0, limit);
}

function isPrivateUserWorkspaceSearchResult(row: any) {
  const title = String(row.title ?? '');
  return String(row.namespace_code ?? '') === 'main' && /^사용자:[^/]+\/(연습장|작업목록|초안|메모)(\/|$)/.test(title);
}

export async function resolveSearchQuery(q: string) {
  q = q.trim().slice(0, 255);
  const title = normalizeTitle(q);
  const normalized = normalizeSearch(q);
  const slug = slugifyTitle(title);
  if (!normalized || !slug) {
    return { action: 'search', target: `/search?q=${encodeURIComponent(q)}`, reason: 'no_exact_match', candidates: [] };
  }
  const rows = await query<any>(
    `SELECT p.id AS page_id, p.title, n.code AS namespace_code, 1100 AS priority, 'title_exact' AS reason
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN search_index si ON si.page_id=p.id
     WHERE p.status NOT IN ('deleted','hidden')
       AND (p.title=:title OR p.slug=:slug OR si.title_normalized=:normalized)
     UNION ALL
     SELECT p.id AS page_id, p.title, n.code AS namespace_code, 1000 AS priority,
       CASE pa.alias_type WHEN 'redirect' THEN 'redirect_exact' ELSE 'alias_exact' END AS reason
     FROM page_aliases pa
     JOIN pages p ON p.id=pa.target_page_id
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE p.status NOT IN ('deleted','hidden')
       AND (pa.alias_slug=:slug OR pa.alias_title=:title)
     UNION ALL
     SELECT p.id AS page_id, p.title, n.code AS namespace_code, COALESCE(st.weight, 900) AS priority, 'term_exact' AS reason
     FROM search_terms st
     JOIN pages p ON p.id=st.target_page_id
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE p.status NOT IN ('deleted','hidden')
       AND st.normalized=:normalized
     UNION ALL
     SELECT p.id AS page_id, p.title, n.code AS namespace_code, COALESCE(sd.weight, 800) AS priority, 'dictionary_exact' AS reason
     FROM search_dictionary sd
     JOIN pages p ON p.id=sd.target_page_id
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE sd.enabled=1
       AND sd.action='alias'
       AND p.status NOT IN ('deleted','hidden')
       AND (sd.term=:title OR sd.normalized_term=:normalized OR sd.replacement=:title)
     ORDER BY priority DESC, title ASC
     LIMIT 10`,
    { title, normalized, slug }
  );
  const seen = new Map<number, any>();
  for (const row of rows) {
    if (!seen.has(Number(row.page_id))) seen.set(Number(row.page_id), row);
  }
  const candidates = [...seen.values()];
  if (candidates.length === 1) {
    const candidate = candidates[0];
    return {
      action: 'redirect',
      target: wikiUrl(candidate.namespace_code, candidate.title),
      reason: candidate.reason,
      candidates
    };
  }
  return {
    action: 'search',
    target: `/search?q=${encodeURIComponent(q)}`,
    reason: candidates.length > 1 ? 'ambiguous' : 'no_exact_match',
    candidates
  };
}

function searchIntentBoost(normalizedQuery: string, namespace: string, title: string) {
  const titleText = normalizeSearch(title);
  const modIntent = ['모드', '설치', '로더', '패브릭', '포지', '네오포지', '퀼트', '셰이더', '소듐', '아이리스', '옵티파인', 'create', 'jei', 'fabric', 'forge', 'neoforge', 'quilt', 'mod', 'loader'].some((term) =>
    normalizedQuery.includes(normalizeSearch(term))
  );
  const serverIntent = ['서버', '접속', '규칙', '반야생', '경제서버', 'rpg서버', '미니게임', '화이트리스트', '인증서버', 'server', 'whitelist'].some((term) => normalizedQuery.includes(normalizeSearch(term)));
  const devIntent = ['api', 'protocol', 'packet', 'nbt', 'plugin', 'paperapi', 'fabricapi', 'forgeapi', 'bukkit', 'spigot', 'velocity', '패킷', '플러그인', '데이터팩개발', '리소스팩모델', '개발'].some((term) =>
    normalizedQuery.includes(normalizeSearch(term))
  );
  const guideIntent = ['하는법', '가는법', '방법', '가이드', '설치', '설치법', '여는법', '열기', '치료', '만드는법', '적용'].some((term) => normalizedQuery.includes(normalizeSearch(term)));
  let boost = 0;
  if (modIntent && namespace === 'mod') boost += 180;
  if (serverIntent && namespace === 'server') boost += 180;
  if (devIntent && namespace === 'dev') boost += 180;
  if (guideIntent && ['guide', 'main'].includes(namespace)) boost += 80;
  if (namespace === 'server' && titleText.includes('추천')) boost -= 120;
  return boost;
}

export async function searchSuggestions(q: string, limit = 8) {
  q = q.trim().slice(0, 255);
  limit = Math.max(1, Math.min(20, Number(limit) || 8));
  const normalized = normalizeSearch(q);
  if (!normalized) return [];
  const initial = chosung(q);
  const rows = await query<any>(
    `SELECT p.id AS page_id, p.title, n.code AS namespace_code, p.slug, p.space_id,
       ws.code AS space_code, ws.space_type, COALESCE(ws.title, ws.name, n.display_name) AS space_title,
       si.title AS match_text, 'title' AS match_type,
       CASE
         WHEN si.title_normalized=:normalized THEN 1000
         WHEN si.title_normalized LIKE :prefix THEN 800
         WHEN si.title_chosung LIKE :initialPrefix THEN 650
         WHEN si.title LIKE :like THEN 500
         ELSE 100
       END AS score
     FROM search_index si
     JOIN pages p ON p.id=si.page_id
     JOIN namespaces n ON n.id=si.namespace_id
     LEFT JOIN wiki_spaces ws ON ws.id=p.space_id
     WHERE p.status NOT IN ('deleted','hidden')
       AND (si.title_normalized LIKE :prefix OR si.title_chosung LIKE :initialPrefix OR si.title LIKE :like)
     UNION ALL
     SELECT p.id AS page_id, p.title, n.code AS namespace_code, p.slug, p.space_id,
       ws.code AS space_code, ws.space_type, COALESCE(ws.title, ws.name, n.display_name) AS space_title,
       pa.alias_title AS match_text, pa.alias_type AS match_type,
       CASE
         WHEN pa.alias_slug=:aliasSlug THEN 950
         WHEN pa.alias_slug LIKE :aliasPrefix THEN 760
         WHEN pa.alias_title LIKE :like THEN 620
         ELSE 300
       END AS score
     FROM page_aliases pa
     JOIN pages p ON p.id=pa.target_page_id
     JOIN namespaces n ON n.id=pa.namespace_id
     LEFT JOIN wiki_spaces ws ON ws.id=p.space_id
     WHERE p.status NOT IN ('deleted','hidden')
       AND (pa.alias_slug LIKE :aliasPrefix OR pa.alias_title LIKE :like)
     UNION ALL
     SELECT p.id AS page_id, p.title, n.code AS namespace_code, p.slug, p.space_id,
       ws.code AS space_code, ws.space_type, COALESCE(ws.title, ws.name, n.display_name) AS space_title,
       st.term AS match_text, st.term_type AS match_type,
       CASE
         WHEN st.normalized=:normalized THEN COALESCE(st.weight, 900)
         WHEN st.normalized LIKE :prefix THEN COALESCE(st.weight, 700)
         ELSE COALESCE(st.weight, 400)
       END AS score
     FROM search_terms st
     JOIN pages p ON p.id=st.target_page_id
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN wiki_spaces ws ON ws.id=p.space_id
     WHERE p.status NOT IN ('deleted','hidden')
       AND (st.normalized LIKE :prefix OR st.term LIKE :like)
     UNION ALL
     SELECT p.id AS page_id, p.title, n.code AS namespace_code, p.slug, p.space_id,
       ws.code AS space_code, ws.space_type, COALESCE(ws.title, ws.name, n.display_name) AS space_title,
       COALESCE(sdc.label, sdc.query) AS match_text, 'disambiguation' AS match_type,
       CASE
         WHEN sdc.normalized_query=:normalized THEN COALESCE(sdc.weight, 100) + 850
         WHEN sdc.normalized_query LIKE :prefix THEN COALESCE(sdc.weight, 100) + 650
         ELSE COALESCE(sdc.weight, 100) + 300
       END AS score
     FROM search_disambiguation_candidates sdc
     JOIN pages p ON p.id=sdc.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN wiki_spaces ws ON ws.id=p.space_id
     WHERE p.status NOT IN ('deleted','hidden')
       AND sdc.enabled=1
       AND (sdc.normalized_query LIKE :prefix OR sdc.query LIKE :like)
     ORDER BY score DESC, title ASC
     LIMIT :rowLimit`,
    {
      normalized,
      prefix: `${normalized}%`,
      initialPrefix: `${initial}%`,
      like: `%${q}%`,
      aliasSlug: q.replace(/\s+/g, '_'),
      aliasPrefix: `${q.replace(/\s+/g, '_')}%`,
      rowLimit: limit * 4
    }
  );
  const seen = new Set<number>();
  return rows
    .filter((row) => {
      if (seen.has(Number(row.page_id))) return false;
      seen.add(Number(row.page_id));
      return true;
    })
    .slice(0, limit);
}

export async function logSearchQuery(q: string, resultCount: number, userId: number | null = null) {
  const result = await exec(
    `INSERT INTO search_query_logs (query, normalized_query, result_count, user_id, created_at)
     VALUES (:q, :normalized, :resultCount, :userId, NOW())`,
    { q, normalized: normalizeSearch(q), resultCount, userId }
  );
  if (resultCount === 0) {
    const row = await one<{ count: number }>(
      `SELECT COUNT(*) AS count FROM search_query_logs WHERE normalized_query=:normalized AND result_count=0`,
      { normalized: normalizeSearch(q) }
    );
    if (Number(row?.count ?? 0) >= 5) {
      const existing = await one<{ id: number }>(
        `SELECT id FROM contributor_tasks WHERE task_type='fix_search_alias' AND target_type='search_term' AND title=:title AND status IN ('open','assigned')`,
        { title: `"${q}" 검색어 처리` }
      );
      if (!existing) {
        const task = await exec(
          `INSERT INTO contributor_tasks (task_type, target_type, title, description, priority, created_at, updated_at)
           VALUES ('fix_search_alias', 'search_term', :title, :description, 'high', NOW(), NOW())`,
          { title: `"${q}" 검색어 처리`, description: '검색 결과가 반복적으로 없습니다. 별칭 또는 문서 생성이 필요합니다.' }
        );
        await exec(
          `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
           VALUES ('search_alias', 'contributor_task', :taskId, 'normal', NOW(), NOW())`,
          { taskId: task.insertId }
        );
      }
    }
  }
  return result.insertId ? Number(result.insertId) : null;
}

export async function recordSearchClick(queryText: string, pageId: number, rankNo: number | null, userId: number | null = null, queryLogId: number | null = null) {
  const normalized = normalizeSearch(queryText);
  let resolvedLogId = queryLogId && queryLogId > 0 ? queryLogId : null;
  if (!resolvedLogId && normalized) {
    const recentLog = await one<{ id: number }>(
      `SELECT id FROM search_query_logs
       WHERE normalized_query=:normalized
         AND (:userId IS NULL OR user_id=:userId OR user_id IS NULL)
         AND created_at >= DATE_SUB(NOW(), INTERVAL 1 HOUR)
       ORDER BY created_at DESC, id DESC
       LIMIT 1`,
      { normalized, userId }
    );
    resolvedLogId = recentLog?.id ? Number(recentLog.id) : null;
  }
  await exec(
    `INSERT INTO search_result_clicks (query_log_id, query, page_id, rank_no, user_id, created_at)
     VALUES (:queryLogId, :query, :pageId, :rankNo, :userId, NOW())`,
    { queryLogId: resolvedLogId, query: queryText, pageId, rankNo, userId }
  );
  if (resolvedLogId) {
    await exec(
      `UPDATE search_query_logs
       SET clicked_page_id=COALESCE(clicked_page_id, :pageId)
       WHERE id=:queryLogId`,
      { queryLogId: resolvedLogId, pageId }
    );
  }
  return resolvedLogId;
}

export async function failedSearches(limit = 50) {
  return query<any>(
    `SELECT query, normalized_query, COUNT(*) AS attempts, MAX(created_at) AS last_seen
     FROM search_query_logs
     WHERE result_count=0
     GROUP BY query, normalized_query
     ORDER BY attempts DESC, last_seen DESC
     LIMIT :limit`,
    { limit }
  );
}

export async function noClickSearches(limit = 50) {
  return query<any>(
    `SELECT query, normalized_query, COUNT(*) AS attempts, MAX(created_at) AS last_seen, MAX(result_count) AS last_result_count
     FROM search_query_logs
     WHERE result_count > 0
       AND clicked_page_id IS NULL
       AND created_at <= DATE_SUB(NOW(), INTERVAL 10 MINUTE)
     GROUP BY query, normalized_query
     HAVING attempts >= 5
     ORDER BY attempts DESC, last_seen DESC
     LIMIT :limit`,
    { limit }
  );
}

export async function enqueueNoClickSearchTasks(limit = 50) {
  const rows = await noClickSearches(limit);
  let created = 0;
  for (const row of rows) {
    const title = `"${row.query}" 검색 결과 클릭 없음`;
    const existing = await one<{ id: number }>(
      `SELECT id FROM contributor_tasks
       WHERE task_type='fix_search_alias' AND target_type='search_term' AND title=:title AND status IN ('open','assigned')
       LIMIT 1`,
      { title }
    );
    if (existing) continue;
    const task = await exec(
      `INSERT INTO contributor_tasks (task_type, target_type, title, description, priority, created_at, updated_at)
       VALUES ('fix_search_alias', 'search_term', :title, :description, 'normal', NOW(), NOW())`,
      {
        title,
        description: `검색 결과는 있지만 사용자가 클릭하지 않았습니다. 결과 순서, 별칭, 동음이의 후보를 검토하세요. 시도 ${row.attempts}회.`
      }
    );
    await exec(
      `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
       VALUES ('search_alias', 'contributor_task', :taskId, 'normal', NOW(), NOW())`,
      { taskId: task.insertId }
    );
    created += 1;
  }
  return { scanned: rows.length, created };
}

export async function qualityList(kind: string, limit = 100) {
  if (kind === 'broken-links') {
    return query<any>(
      `SELECT target_title, COUNT(*) AS count FROM page_links WHERE link_type='missing'
       GROUP BY target_title ORDER BY count DESC LIMIT :limit`,
      { limit }
    );
  }
  if (kind === 'needed-pages') {
    return query<any>(
      `SELECT pl.target_title, tn.code AS namespace_code, COUNT(*) AS link_count
       FROM page_links pl
       JOIN namespaces tn ON tn.id=pl.target_namespace_id
       WHERE pl.link_type='missing'
       GROUP BY pl.target_namespace_id, pl.target_title
       ORDER BY link_count DESC, pl.target_title LIMIT :limit`,
      { limit }
    );
  }
  if (kind === 'uncategorized') {
    return query<any>(
      `SELECT p.id, p.title, n.code AS namespace_code FROM pages p
       JOIN namespaces n ON n.id=p.namespace_id
       LEFT JOIN page_categories pc ON pc.page_id=p.id
       WHERE pc.page_id IS NULL AND p.status!='deleted'
       ORDER BY p.updated_at DESC LIMIT :limit`,
      { limit }
    );
  }
  const issueKinds: Record<string, string> = {
    'missing-status': 'missing_status',
    'missing-infobox': 'missing_infobox',
    'no-internal-links': 'no_internal_links',
    'old-mods': 'mod_missing_check_date',
    'server-missing-address': 'server_missing_address'
  };
  if (issueKinds[kind]) {
    return query<any>(
      `SELECT p.id, p.title, n.code AS namespace_code, qi.issue_type, qi.severity, qi.detail, qi.created_at
       FROM page_quality_issues qi
       JOIN pages p ON p.id=qi.page_id
       JOIN namespaces n ON n.id=p.namespace_id
       WHERE qi.issue_type=:issueType AND qi.status='open' AND p.status!='deleted'
       ORDER BY FIELD(qi.severity, 'high', 'medium', 'low'), qi.created_at DESC LIMIT :limit`,
      { issueType: issueKinds[kind], limit }
    );
  }
  if (kind === 'page-requests') {
    return query<any>(
      `SELECT pr.id, n.code AS namespace_code, pr.requested_title, pr.reason, pr.status, pr.created_at, pr.updated_at, pr.target_page_id
       FROM page_requests pr
       JOIN namespaces n ON n.id=pr.namespace_id
       WHERE pr.status='open'
       ORDER BY pr.created_at DESC LIMIT :limit`,
      { limit }
    );
  }
  const status = kind === 'stub' ? 'stub' : kind === 'outdated' ? 'outdated' : 'needs_check';
  return query<any>(
    `SELECT p.id, p.title, n.code AS namespace_code, qs.status, qs.reason
     FROM page_quality_status qs
     JOIN pages p ON p.id=qs.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE qs.status=:status AND p.status!='deleted'
     ORDER BY qs.updated_at DESC LIMIT :limit`,
    { status, limit }
  );
}

export async function modDetails(pageId: number) {
  const [versions, links, dependencies, wiki] = await Promise.all([
    query<any>(`SELECT minecraft_version, loader, support_status, note, checked_at FROM mod_versions WHERE page_id=:pageId ORDER BY minecraft_version DESC, loader`, { pageId }),
    query<any>(`SELECT link_type, url, status, checked_at FROM mod_links WHERE page_id=:pageId ORDER BY link_type`, { pageId }),
    query<any>(`SELECT dependency_name, required_type, note FROM mod_dependencies WHERE page_id=:pageId ORDER BY dependency_name`, { pageId }),
    one<any>(
      `SELECT ${modWikiFields}, verifier.display_name AS verifier_name
       FROM pages p
       LEFT JOIN mod_wikis mw ON mw.slug=SUBSTRING_INDEX(p.title, '/', 1)
       LEFT JOIN users verifier ON verifier.id=mw.verified_by
       WHERE p.id=:pageId`,
      { pageId }
    )
  ]);
  return { versions, links, dependencies, wiki };
}

export async function serverList(filters: Record<string, string>, limit = 100) {
  const where: string[] = [`p.status!='deleted'`];
  const params: Record<string, unknown> = { limit };
  const settings = await one<any>(`SELECT server_listing_mode FROM open_beta_settings WHERE id=1`);
  const listingMode = filters.all === '1' ? 'all' : (settings?.server_listing_mode ?? 'verified_or_owner');
  const activeVerified = `(es.verified_status='verified' AND (sc.renewal_required_at IS NULL OR sc.renewal_required_at > NOW()))`;
  if (listingMode === 'verified_only') where.push(activeVerified);
  if (listingMode === 'verified_or_owner') {
    where.push(`(${activeVerified} OR EXISTS (SELECT 1 FROM server_owners so WHERE so.page_id=es.page_id AND so.status='active'))`);
  }
  if (filters.q) {
    where.push(`(p.title LIKE :q OR es.host LIKE :q OR es.genres LIKE :q OR es.supported_versions LIKE :q)`);
    params.q = `%${filters.q}%`;
  }
  if (filters.edition) {
    where.push(`es.edition=:edition`);
    params.edition = filters.edition;
  }
  if (filters.genre) {
    where.push(`es.genres LIKE :genre`);
    params.genre = `%${filters.genre}%`;
  }
  if (filters.version) {
    where.push(`es.supported_versions LIKE :version`);
    params.version = `%${filters.version}%`;
  }
  if (filters.verified === '1') where.push(activeVerified);
  return query<any>(
    `SELECT p.id, p.title, p.updated_at, es.host, es.edition, es.supported_versions, es.genres, es.verified_status, es.operational_status, es.whitelist, es.status_enabled,
       sc.last_verified_at, sc.renewal_required_at,
       COALESCE(owners.owner_count, 0) AS owner_count,
       CASE
         WHEN es.verified_status='verified' AND sc.renewal_required_at IS NOT NULL AND sc.renewal_required_at <= NOW() THEN 'renewal_required'
         ELSE es.verified_status
       END AS verification_status
     FROM entity_servers es
     JOIN pages p ON p.id=es.page_id
     LEFT JOIN (
       SELECT page_id, MAX(last_verified_at) AS last_verified_at, MAX(renewal_required_at) AS renewal_required_at
       FROM server_claims
       WHERE status='verified'
       GROUP BY page_id
     ) sc ON sc.page_id=es.page_id
     LEFT JOIN (
       SELECT page_id, COUNT(*) AS owner_count
       FROM server_owners
       WHERE status='active'
       GROUP BY page_id
     ) owners ON owners.page_id=es.page_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.title
     LIMIT :limit`,
    params
  );
}

export async function runConsistencyChecks(autoFix = false) {
  await exec(`DELETE FROM consistency_checks WHERE created_at < DATE_SUB(NOW(), INTERVAL 7 DAY)`);
  const missingSearch = await query<any>(
    `SELECT p.id, p.title FROM pages p LEFT JOIN search_index si ON si.page_id=p.id WHERE si.page_id IS NULL AND p.status!='deleted' LIMIT 200`
  );
  const missingCache = await query<any>(
    `SELECT p.id, p.title FROM pages p LEFT JOIN page_render_cache rc ON rc.revision_id=p.current_revision_id WHERE rc.id IS NULL AND p.status!='deleted' LIMIT 200`
  );
  const badServerProtection = await query<any>(
    `SELECT p.id, p.title FROM pages p JOIN namespaces n ON n.id=p.namespace_id
     WHERE n.code='server' AND p.title LIKE '%/%' AND p.protection_level!='owner_only' AND p.status!='deleted' LIMIT 200`
  );
  const deletedSearchRows = await query<any>(
    `SELECT p.id, p.title
     FROM pages p
     JOIN search_index si ON si.page_id=p.id
     WHERE p.status='deleted'
     LIMIT 200`
  );
  const missingCurrentRevision = await query<any>(
    `SELECT p.id, p.title
     FROM pages p
     LEFT JOIN page_revisions r ON r.id=p.current_revision_id
     WHERE p.status!='deleted' AND (p.current_revision_id IS NULL OR r.id IS NULL)
     LIMIT 200`
  );
  const staleCurrentRevision = await query<any>(
    `SELECT p.id, p.title, p.current_revision_id, latest.id AS latest_revision_id
     FROM pages p
     JOIN (
       SELECT page_id, MAX(revision_no) AS latest_no
       FROM page_revisions
       WHERE visibility='public'
       GROUP BY page_id
     ) latest_no ON latest_no.page_id=p.id
     JOIN page_revisions latest ON latest.page_id=p.id AND latest.revision_no=latest_no.latest_no
     WHERE p.status!='deleted' AND p.current_revision_id IS NOT NULL AND p.current_revision_id!=latest.id
     LIMIT 200`
  );
  const hiddenCurrentRevision = await query<any>(
    `SELECT p.id, p.title, r.visibility
     FROM pages p
     JOIN page_revisions r ON r.id=p.current_revision_id
     WHERE p.status!='deleted' AND r.visibility!='public'
     LIMIT 200`
  );
  for (const row of missingSearch) {
    await exec(
      `INSERT INTO consistency_checks (check_type, status, target_type, target_id, message, created_at)
       VALUES ('missing_search_index', 'error', 'page', :id, :message, NOW())`,
      { id: row.id, message: `검색 색인 누락: ${row.title}` }
    );
    if (autoFix) await enqueueJob('reindex_page', { pageId: row.id });
  }
  for (const row of missingCache) {
    await exec(
      `INSERT INTO consistency_checks (check_type, status, target_type, target_id, message, created_at)
       VALUES ('missing_render_cache', 'error', 'page', :id, :message, NOW())`,
      { id: row.id, message: `렌더 캐시 누락: ${row.title}` }
    );
    if (autoFix) await enqueueJob('render_page', { pageId: row.id });
  }
  for (const row of badServerProtection) {
    await exec(
      `INSERT INTO consistency_checks (check_type, status, target_type, target_id, message, fixed_at, created_at)
       VALUES ('server_official_protection', 'warning', 'page', :id, :message, :fixedAt, NOW())`,
      { id: row.id, message: `서버 공식 하위문서 보호 수준 오류: ${row.title}`, fixedAt: autoFix ? new Date() : null }
    );
    if (autoFix) await exec(`UPDATE pages SET protection_level='owner_only' WHERE id=:id`, { id: row.id });
  }
  for (const row of deletedSearchRows) {
    await exec(
      `INSERT INTO consistency_checks (check_type, status, target_type, target_id, message, fixed_at, created_at)
       VALUES ('deleted_page_in_search', 'error', 'page', :id, :message, :fixedAt, NOW())`,
      { id: row.id, message: `삭제 문서 검색 색인 잔존: ${row.title}`, fixedAt: autoFix ? new Date() : null }
    );
    if (autoFix) await exec(`DELETE FROM search_index WHERE page_id=:id`, { id: row.id });
  }
  for (const row of missingCurrentRevision) {
    await exec(
      `INSERT INTO consistency_checks (check_type, status, target_type, target_id, message, created_at)
       VALUES ('current_revision_missing', 'error', 'page', :id, :message, NOW())`,
      { id: row.id, message: `현재 리비전 누락: ${row.title}` }
    );
  }
  for (const row of staleCurrentRevision) {
    await exec(
      `INSERT INTO consistency_checks (check_type, status, target_type, target_id, message, fixed_at, created_at)
       VALUES ('current_revision_mismatch', 'warning', 'page', :id, :message, :fixedAt, NOW())`,
      { id: row.id, message: `현재 리비전이 최신 리비전과 다름: ${row.title}`, fixedAt: autoFix ? new Date() : null }
    );
    if (autoFix) await exec(`UPDATE pages SET current_revision_id=:revisionId WHERE id=:id`, { id: row.id, revisionId: row.latest_revision_id });
  }
  for (const row of hiddenCurrentRevision) {
    await exec(
      `INSERT INTO consistency_checks (check_type, status, target_type, target_id, message, created_at)
       VALUES ('hidden_current_revision', 'error', 'page', :id, :message, NOW())`,
      { id: row.id, message: `현재판이 숨김 리비전임(${row.visibility}): ${row.title}` }
    );
  }
  return {
    missingSearch: missingSearch.length,
    missingCache: missingCache.length,
    badServerProtection: badServerProtection.length,
    deletedSearchRows: deletedSearchRows.length,
    missingCurrentRevision: missingCurrentRevision.length,
    staleCurrentRevision: staleCurrentRevision.length,
    hiddenCurrentRevision: hiddenCurrentRevision.length
  };
}

export async function enqueueJob(jobType: string, payload: unknown, runAfter: string | null = null) {
  const result = await exec(
    `INSERT INTO job_queue (job_type, payload_json, run_after, created_at)
     VALUES (:jobType, :payload, :runAfter, NOW())`,
    { jobType, payload: JSON.stringify(payload), runAfter }
  );
  return result.insertId;
}

export async function runNextJob() {
  const job = await one<any>(
    `SELECT ${jobQueueFields} FROM job_queue WHERE status='pending' AND (run_after IS NULL OR run_after <= NOW()) ORDER BY id ASC LIMIT 1`
  );
  if (!job) return null;
  await exec(`UPDATE job_queue SET status='running', attempts=attempts+1, started_at=NOW() WHERE id=:id`, { id: job.id });
  try {
    const payload = typeof job.payload_json === 'string' ? JSON.parse(job.payload_json) : job.payload_json;
    if (['render_page', 'reindex_page', 'rebuild_links', 'rebuild_categories'].includes(job.job_type)) {
      const page = await getPageById(Number(payload.pageId));
      if (!page) throw new Error('page_not_found');
      await rebuildPageArtifacts(page);
    } else if (job.job_type === 'check_file_usage') {
      if (payload.pageId) {
        const page = await getPageById(Number(payload.pageId));
        if (!page) throw new Error('page_not_found');
        await rebuildPageArtifacts(page);
      } else {
        await runConsistencyChecks(false);
      }
    } else if (job.job_type === 'check_mod_links') {
      await exec(`UPDATE mod_links SET checked_at=NOW() WHERE status IN ('pending','unknown')`);
    } else if (job.job_type === 'check_server_status') {
      await checkServerStatusJob(payload);
    } else if (job.job_type === 'run_consistency_check') {
      await runConsistencyChecks(Boolean(payload.autoFix));
    } else {
      throw new Error(`unsupported_job_type:${job.job_type}`);
    }
    await exec(`UPDATE job_queue SET status='done', finished_at=NOW() WHERE id=:id`, { id: job.id });
    return { id: job.id, status: 'done' };
  } catch (error: any) {
    await exec(`UPDATE job_queue SET status='failed', finished_at=NOW(), error_message=:message WHERE id=:id`, {
      id: job.id,
      message: error.message
    });
    return { id: job.id, status: 'failed', error: error.message };
  }
}

async function checkServerStatusJob(payload: any) {
  const pageId = Number(payload?.pageId ?? 0);
  const endpoints = await query<any>(
    `SELECT id, page_id, host, port, edition
     FROM server_endpoints
     WHERE enabled=1 ${pageId ? 'AND page_id=:pageId' : ''}
     ORDER BY id DESC
     LIMIT :limit`,
    { pageId, limit: Number(payload?.limit ?? 100) }
  );
  for (const endpoint of endpoints) {
    const started = Date.now();
    const online = await tcpCheck(String(endpoint.host), Number(endpoint.port ?? 25565));
    const latency = Date.now() - started;
    await exec(
      `INSERT INTO server_ping_logs (endpoint_id, checked_at, online, players_online, players_max, version_name, motd_hash, latency_ms)
       VALUES (:endpointId, NOW(), :online, NULL, NULL, NULL, NULL, :latency)`,
      { endpointId: endpoint.id, online: online ? 1 : 0, latency }
    );
    await exec(
      `UPDATE entity_servers
       SET operational_status=CASE
         WHEN :online=1 THEN 'active'
         WHEN operational_status IN ('closed','disputed') THEN operational_status
         ELSE 'checking_failed'
       END,
       last_checked=NOW(),
       updated_at=NOW()
       WHERE page_id=:pageId`,
      { pageId: endpoint.page_id, online: online ? 1 : 0 }
    );
  }
  return { checked: endpoints.length };
}

async function tcpCheck(host: string, port: number) {
  const address = await publicNetworkAddress(host);
  if (!address) return false;
  return new Promise<boolean>((resolve) => {
    const socket = net.createConnection({ host: address.address, port, family: address.family, timeout: 2500 });
    socket.once('connect', () => {
      socket.destroy();
      resolve(true);
    });
    socket.once('timeout', () => {
      socket.destroy();
      resolve(false);
    });
    socket.once('error', () => resolve(false));
  });
}

async function publicNetworkAddress(host: string) {
  const normalized = normalizeServerHost(host);
  if (!normalized) return null;
  if (net.isIP(normalized)) {
    return isPublicIpAddress(normalized) ? { address: normalized, family: net.isIP(normalized) } : null;
  }
  const records = await dns.lookup(normalized, { all: true, verbatim: false }).catch(() => []);
  return records.find((record) => isPublicIpAddress(record.address)) ?? null;
}

function normalizeServerHost(value: unknown) {
  const raw = String(value ?? '').trim().toLowerCase();
  if (!raw) return null;
  const withoutProtocol = raw.replace(/^[a-z]+:\/\//, '').split('/')[0].split('?')[0];
  const host = withoutProtocol.replace(/^\[/, '').replace(/\]$/, '').split(':')[0].replace(/\.$/, '');
  if (!host || host.length > 255) return null;
  if (net.isIP(host)) return host;
  if (!/^(?!-)(?:[a-z0-9-]{1,63}\.)+[a-z0-9-]{2,63}$/.test(host)) return null;
  return host;
}

function isPublicIpAddress(address: string) {
  const family = net.isIP(address);
  if (family === 4) return isPublicIpv4(address);
  if (family === 6) return isPublicIpv6(address);
  return false;
}

function isPublicIpv4(address: string) {
  const parts = address.split('.').map((part) => Number(part));
  if (parts.length !== 4 || parts.some((part) => !Number.isInteger(part) || part < 0 || part > 255)) return false;
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127 || a >= 224) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 168) return false;
  if (a === 192 && b === 0) return false;
  if (a === 198 && [18, 19, 51].includes(b)) return false;
  if (a === 203 && b === 0) return false;
  return true;
}

function isPublicIpv6(address: string) {
  const value = address.toLowerCase();
  if (value === '::1' || value === '::' || value.startsWith('fe80:')) return false;
  if (value.startsWith('fc') || value.startsWith('fd')) return false;
  if (value.startsWith('ff')) return false;
  if (value.startsWith('2001:db8:')) return false;
  return true;
}

async function rebuildPageArtifacts(page: any) {
  const parsed = parseMarkup(String(page.content_raw ?? ''));
  const revisionId = Number(page.current_revision_id);
  if (!revisionId) throw new Error('current_revision_missing');
  await tx(async (conn) => {
    const nsId = await namespaceId(page.namespace_code, conn);
    const missingLinks = await missingLinkKeys(conn, parsed.links);
    const fileNames = extractFileNames(parsed.ast);
    const files = await fileRenderMap(conn, fileNames);
    const officialAreas = await officialAreaMap(conn, parsed.components);
    const html = renderDocument(parsed.ast, { missingLinks, files, officialAreas });
    await conn.execute(
      `INSERT INTO page_render_cache
       (page_id, revision_id, renderer_version, html, toc_json, headings_json, warnings_json, footnotes_json, links_json, categories_json, components_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE html=VALUES(html), toc_json=VALUES(toc_json), headings_json=VALUES(headings_json),
         warnings_json=VALUES(warnings_json), footnotes_json=VALUES(footnotes_json), links_json=VALUES(links_json),
         categories_json=VALUES(categories_json), components_json=VALUES(components_json)`,
      [
        Number(page.id),
        revisionId,
        config.rendererVersion,
        html,
        JSON.stringify(parsed.headings),
        JSON.stringify(parsed.headings),
        JSON.stringify(parsed.errors),
        JSON.stringify(parsed.footnotes),
        JSON.stringify(parsed.links),
        JSON.stringify(parsed.categories),
        JSON.stringify(parsed.components)
      ]
    );
    await replaceLinks(conn, Number(page.id), parsed.links);
    await replaceFileUsages(conn, Number(page.id), fileNames);
    await replaceCategories(conn, Number(page.id), parsed.categories);
    await replaceAliases(conn, Number(page.id), nsId, page.title, parsed.redirectTarget, parsed.components);
    await replaceStructuredData(conn, Number(page.id), parsed.components);
    await replaceVerification(conn, Number(page.id), parsed.components);
    await replaceQualityStatus(conn, Number(page.id), parsed, page.namespace_code);
    await replaceSearchIndex(conn, Number(page.id), nsId, page.title, parsed.plainText, parsed.categories, parsed.components);
  });
}

export async function addPageAlias(namespace: NamespaceCode, aliasTitle: string, targetPageId: number, aliasType = 'alias') {
  const ns = await namespaceId(namespace);
  await exec(
    `INSERT INTO page_aliases (namespace_id, alias_slug, alias_title, target_page_id, alias_type, created_at)
     VALUES (:ns, :slug, :aliasTitle, :targetPageId, :aliasType, NOW())
     ON DUPLICATE KEY UPDATE target_page_id=VALUES(target_page_id), alias_type=VALUES(alias_type)`,
    { ns, slug: slugifyTitle(aliasTitle), aliasTitle, targetPageId, aliasType }
  );
  await exec(
    `INSERT INTO search_terms (term, normalized, target_page_id, weight, term_type)
     VALUES (:term, :normalized, :targetPageId, 900, :termType)
     ON DUPLICATE KEY UPDATE target_page_id=VALUES(target_page_id), normalized=VALUES(normalized), weight=VALUES(weight)`,
    { term: aliasTitle, normalized: normalizeSearch(aliasTitle), targetPageId, termType: aliasType === 'typo' ? 'typo' : 'alias' }
  );
}

export async function recentChanges(
  limitOrOptions: number | {
    limit?: number;
    namespace?: string;
    type?: string;
    actorId?: number;
    prefix?: string;
    contentOnly?: boolean;
    publicOnly?: boolean;
    includeManagement?: boolean;
    includeDeleted?: boolean;
    includeSystem?: boolean;
  } = 20
) {
  const options = typeof limitOrOptions === 'number' ? { limit: limitOrOptions } : limitOrOptions;
  const limit = Math.min(Math.max(Number(options.limit ?? 20), 1), 200);
  const where = [`(r.visibility IS NULL OR r.visibility='public')`];
  const params: Record<string, unknown> = { limit };
  if (options.namespace) {
    where.push(`rc.namespace_code=:namespace`);
    params.namespace = options.namespace;
  }
  if (options.type) {
    where.push(`rc.change_type=:type`);
    params.type = options.type;
  }
  if (options.actorId) {
    where.push(`rc.actor_id=:actorId`);
    params.actorId = options.actorId;
  }
  if (options.prefix) {
    where.push(`(rc.title=:prefix OR rc.title LIKE :prefixLike)`);
    params.prefix = options.prefix;
    params.prefixLike = `${options.prefix}/%`;
  }
  if (options.contentOnly) {
    where.push(`rc.namespace_code IN ('main','mod','server','dev')`);
  }
  if (options.publicOnly) {
    where.push(`rc.change_type IN ('create','edit','move','discussion')`);
  }
  if (!options.includeDeleted) {
    where.push(`rc.change_type!='delete'`);
    where.push(`COALESCE(p.status,'normal') NOT IN ('deleted','hidden')`);
  }
  if (!options.includeManagement) {
    where.push(`rc.change_type NOT IN ('protect','restore','rollback','file_upload')`);
    where.push(`COALESCE(rc.summary,'') NOT REGEXP '정비|검증|숨김|삭제 처리|일괄|초기 기준 문서 작성|기본 문서 생성|대문 생성'`);
  }
  if (!options.includeSystem) {
    where.push(`rc.title NOT REGEXP '(^|/)(verify-pending|moddash-check|test|테스트|검증|예시 문서|자리 채우기)'`);
    where.push(`COALESCE(p.page_type,'') NOT IN ('project','policy')`);
  }
  const rows = await query<any>(
    `SELECT rc.id AS change_id, rc.page_id AS id, rc.title, p.display_title, p.slug, rc.namespace_code, r.id AS revision_id, r.revision_no, r.visibility, rc.summary AS edit_summary, rc.change_type, rc.actor_id, rc.created_at,
       CASE WHEN r.actor_type='ip' AND r.actor_ip_text IS NOT NULL THEN r.actor_ip_text ELSE COALESCE(u.display_name, u.username, '익명') END AS actor_name,
       r.actor_type, r.actor_ip_text,
       r.content_size,
       pr.content_size AS parent_content_size,
       CASE
         WHEN r.id IS NULL THEN NULL
         ELSE CAST(r.content_size AS SIGNED) - CAST(COALESCE(pr.content_size, 0) AS SIGNED)
       END AS size_delta
     FROM recent_changes rc
     LEFT JOIN pages p ON p.id=rc.page_id
     LEFT JOIN page_revisions r ON r.id=rc.revision_id
     LEFT JOIN page_revisions pr ON pr.id=r.parent_revision_id
     LEFT JOIN users u ON u.id=rc.actor_id
     WHERE ${where.join(' AND ')}
     ORDER BY rc.created_at DESC
     LIMIT :limit`,
    params
  );
  if (rows.length > 0) return rows;
  if (
    Object.keys(params).length > 1 ||
    options.namespace ||
    options.type ||
    options.actorId ||
    options.prefix ||
    options.contentOnly ||
    options.publicOnly ||
    options.includeManagement ||
    options.includeDeleted ||
    options.includeSystem
  ) return rows;
  return query<any>(
    `SELECT p.id, p.title, p.display_title, p.slug, n.code AS namespace_code, r.id AS revision_id, r.revision_no, r.visibility, r.edit_summary, r.created_at,
       r.created_by AS actor_id,
       CASE WHEN r.actor_type='ip' AND r.actor_ip_text IS NOT NULL THEN r.actor_ip_text ELSE COALESCE(u.display_name, u.username, '익명') END AS actor_name,
       r.actor_type, r.actor_ip_text,
       r.content_size, pr.content_size AS parent_content_size,
       CAST(r.content_size AS SIGNED) - CAST(COALESCE(pr.content_size, 0) AS SIGNED) AS size_delta
     FROM page_revisions r
     JOIN pages p ON p.id=r.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN page_revisions pr ON pr.id=r.parent_revision_id
     LEFT JOIN users u ON u.id=r.created_by
     WHERE p.status NOT IN ('deleted','hidden')
     ORDER BY r.created_at DESC
     LIMIT :limit`,
    { limit }
  );
}

export async function pageRevisions(pageId: number, includeRestricted = false, includeSuppressed = false) {
  const visibilityClause = includeRestricted ? (includeSuppressed ? '' : ` AND r.visibility!='suppressed'`) : ` AND (r.visibility IS NULL OR r.visibility='public')`;
  return query<any>(
    `SELECT r.id, r.page_id, r.revision_no, r.parent_revision_id, r.content_hash, r.content_size, pr.content_size AS parent_content_size,
       CAST(r.content_size AS SIGNED) - CAST(COALESCE(pr.content_size, 0) AS SIGNED) AS size_delta,
       r.is_minor, r.edit_tags,
       r.edit_summary, r.created_by, r.created_at, r.visibility, r.actor_type, r.actor_user_id, r.actor_ip_text, r.actor_ip_hash,
       CASE WHEN r.actor_type='ip' AND r.actor_ip_text IS NOT NULL THEN r.actor_ip_text ELSE COALESCE(u.display_name, u.username, '익명') END AS actor_name
     FROM page_revisions r
     LEFT JOIN page_revisions pr ON pr.id=r.parent_revision_id
     LEFT JOIN users u ON u.id=r.created_by
     WHERE r.page_id=:pageId${visibilityClause}
     ORDER BY r.revision_no DESC`,
    { pageId }
  );
}

export async function pageRevision(pageId: number, revisionId: number, includeRestricted = false, includeSuppressed = false) {
  const visibilityClause = includeRestricted ? (includeSuppressed ? '' : ` AND visibility!='suppressed'`) : ` AND (visibility IS NULL OR visibility='public')`;
  return one<any>(
    `SELECT id, page_id, revision_no, parent_revision_id, content_raw, content_ast, content_hash, content_size, is_minor, edit_tags,
       edit_summary, created_by, created_at, visibility
     FROM page_revisions WHERE page_id=:pageId AND id=:revisionId${visibilityClause}`,
    { pageId, revisionId }
  );
}

export async function pageRevisionById(revisionId: number, includeRestricted = false, includeSuppressed = false, includeDeleted = false) {
  const visibilityClause = includeRestricted ? (includeSuppressed ? '' : ` AND r.visibility!='suppressed'`) : ` AND (r.visibility IS NULL OR r.visibility='public')`;
  return one<any>(
    `SELECT r.id, r.page_id, r.revision_no, r.parent_revision_id, r.content_raw, r.content_ast, r.content_hash, r.content_size, r.is_minor, r.edit_tags,
       r.edit_summary, r.created_by, r.created_at, r.visibility,
       p.title, p.display_title, p.status AS page_status, n.code AS namespace_code, n.display_name AS namespace_name
     FROM page_revisions r
     JOIN pages p ON p.id=r.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE r.id=:revisionId AND (p.status!='deleted' OR :includeDeleted=1)${visibilityClause}`,
    { revisionId, includeDeleted: includeDeleted ? 1 : 0 }
  );
}

export async function getPageAtRevision(pageId: number, revisionId: number, includeRestricted = false, includeSuppressed = false, includeDeleted = false) {
  const visibilityClause = includeRestricted ? (includeSuppressed ? '' : ` AND r.visibility!='suppressed'`) : ` AND (r.visibility IS NULL OR r.visibility='public')`;
  const page = await one<any>(
    `SELECT ${pageSelectFields}, n.code AS namespace_code, n.display_name AS namespace_name, r.content_raw,
       r.id AS view_revision_id, r.revision_no AS view_revision_no, r.visibility AS view_revision_visibility,
       r.content_size AS view_revision_content_size, r.is_minor AS view_revision_is_minor, r.edit_tags AS view_revision_edit_tags,
       (SELECT pr_prev.id FROM page_revisions pr_prev WHERE pr_prev.page_id=p.id AND pr_prev.revision_no < r.revision_no ORDER BY pr_prev.revision_no DESC LIMIT 1) AS previous_revision_id,
       (SELECT pr_next.id FROM page_revisions pr_next WHERE pr_next.page_id=p.id AND pr_next.revision_no > r.revision_no ORDER BY pr_next.revision_no ASC LIMIT 1) AS next_revision_id,
       r.created_at AS view_revision_created_at, c.html, c.toc_json, c.links_json, c.categories_json, c.components_json,
       ml.missing_links_json
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     JOIN page_revisions r ON r.page_id=p.id
     LEFT JOIN page_render_cache c ON c.revision_id=r.id AND c.renderer_version=:rendererVersion
     LEFT JOIN (
       SELECT pl.from_page_id, JSON_ARRAYAGG(JSON_OBJECT('namespace_code', tn.code, 'title', pl.target_title)) AS missing_links_json
       FROM page_links pl
       JOIN namespaces tn ON tn.id=pl.target_namespace_id
       WHERE pl.link_type='missing'
       GROUP BY pl.from_page_id
     ) ml ON ml.from_page_id=p.id
     WHERE p.id=:pageId AND (p.status!='deleted' OR :includeDeleted=1) AND r.id=:revisionId${visibilityClause}`,
    { pageId, revisionId, rendererVersion: config.rendererVersion, includeDeleted: includeDeleted ? 1 : 0 }
  );
  if (!page || page.html) return page;
  const parsed = parseMarkup(String(page.content_raw ?? ''));
  page.html = renderDocument(parsed.ast);
  page.toc_json = JSON.stringify(parsed.headings);
  page.links_json = JSON.stringify(parsed.links);
  page.categories_json = JSON.stringify(parsed.categories);
  page.components_json = JSON.stringify(parsed.components);
  await exec(
    `INSERT INTO page_render_cache
     (page_id, revision_id, renderer_version, html, toc_json, headings_json, warnings_json, footnotes_json, links_json, categories_json, components_json, created_at)
     VALUES (:pageId, :revisionId, :rendererVersion, :html, :tocJson, :headingsJson, :warningsJson, :footnotesJson, :linksJson, :categoriesJson, :componentsJson, NOW())
     ON DUPLICATE KEY UPDATE html=VALUES(html), toc_json=VALUES(toc_json), headings_json=VALUES(headings_json),
       warnings_json=VALUES(warnings_json), footnotes_json=VALUES(footnotes_json), links_json=VALUES(links_json),
       categories_json=VALUES(categories_json), components_json=VALUES(components_json)`,
    {
      pageId: page.id,
      revisionId,
      rendererVersion: config.rendererVersion,
      html: page.html,
      tocJson: page.toc_json,
      headingsJson: page.toc_json,
      warningsJson: JSON.stringify(parsed.errors),
      footnotesJson: JSON.stringify(parsed.footnotes),
      linksJson: page.links_json,
      categoriesJson: page.categories_json,
      componentsJson: page.components_json
    }
  );
  return page;
}

export async function diffRevisions(pageId: number, fromRevisionId: number, toRevisionId: number, includeRestricted = false, includeSuppressed = false) {
  const [from, to] = await Promise.all([pageRevision(pageId, fromRevisionId, includeRestricted, includeSuppressed), pageRevision(pageId, toRevisionId, includeRestricted, includeSuppressed)]);
  if (!from || !to) return null;
  const fromLines = String(from.content_raw).split('\n');
  const toLines = String(to.content_raw).split('\n');
  const max = Math.max(fromLines.length, toLines.length);
  const changes = [];
  for (let index = 0; index < max; index += 1) {
    if ((fromLines[index] ?? '') !== (toLines[index] ?? '')) changes.push({ line: index + 1, before: fromLines[index] ?? '', after: toLines[index] ?? '' });
  }
  return { fromRevisionId, toRevisionId, changes };
}

export async function rollbackToRevision(pageId: number, revisionId: number, actorId: number | null) {
  const page = await getPageById(pageId);
  const revision = await pageRevision(pageId, revisionId);
  if (!page || !revision) throw new Error('revision_not_found');
  const result = appliedPage(await savePage({
    namespace: page.namespace_code,
    title: page.title,
    content: revision.content_raw,
    summary: `리비전 ${revision.revision_no}로 되돌림`,
    userId: actorId,
    skipReview: true
  }));
  await exec(
    `INSERT INTO page_revision_actions (page_id, revision_id, actor_id, action, reason, created_at)
     VALUES (:pageId, :revisionId, :actorId, 'rollback', :reason, NOW())`,
    { pageId, revisionId, actorId, reason: `created revision ${result.revisionId}` }
  );
  await maybeEscalatePageProtection(pageId, 'edit_war', actorId);
  return result;
}

export async function pageLinks(pageId: number) {
  return query<any>(`SELECT ${pageLinkFields} FROM page_links WHERE from_page_id=:pageId ORDER BY target_title`, { pageId });
}

export async function pageCategories(pageId: number) {
  return query<any>(
    `SELECT c.id, c.title, c.slug, c.created_at FROM page_categories pc JOIN categories c ON c.id=pc.category_id WHERE pc.page_id=:pageId ORDER BY c.title`,
    { pageId }
  );
}

export async function pagesInCategory(title: string) {
  return query<any>(
    `SELECT p.id, p.space_id, p.protection_level, p.status, p.title, p.display_title, p.updated_at, n.code AS namespace_code, n.display_name AS namespace_name,
       LEFT(COALESCE(si.body_plain, ''), 220) AS excerpt
     FROM categories c
     JOIN page_categories pc ON pc.category_id=c.id
     JOIN pages p ON p.id=pc.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN search_index si ON si.page_id=p.id
     WHERE c.slug=:slug AND p.status NOT IN ('deleted','hidden')
     ORDER BY n.code, p.title`,
    { slug: slugifyTitle(title) }
  );
}

export async function protectPage(pageId: number, level: string, actorId: number | null) {
  const page = await getPageById(pageId);
  const oldLevel = normalizeProtectionLevel(page?.protection_level) ?? 'open';
  const newLevel = normalizeProtectionLevel(level) ?? 'trusted_only';
  await exec(
    `UPDATE pages
     SET protection_level=:level,
         status=CASE WHEN :level='open' THEN 'normal' ELSE 'protected' END,
         updated_at=NOW()
     WHERE id=:pageId`,
    { pageId, level: newLevel }
  );
  await recordPageProtectionEvent(pageId, oldLevel, newLevel, 'manual', actorId, false, null, null);
  await logAdmin(actorId, 'page.protect', 'page', pageId, { level: newLevel, oldLevel });
}

export async function recordPageProtectionEvent(
  pageId: number,
  oldLevel: string,
  newLevel: string,
  reason: 'manual' | 'vandalism' | 'edit_war' | 'spam' | 'privacy' | 'server_dispute' | 'policy' | 'high_risk',
  actorId: number | null,
  automatic = false,
  note: string | null = null,
  expiresAt: string | null = null
) {
  await exec(
    `INSERT INTO page_protection_events (page_id, old_level, new_level, reason, expires_at, changed_by, is_automatic, note, created_at)
     VALUES (:pageId, :oldLevel, :newLevel, :reason, :expiresAt, :actorId, :automatic, :note, NOW())`,
    {
      pageId,
      oldLevel: normalizeProtectionLevel(oldLevel) ?? 'open',
      newLevel: normalizeProtectionLevel(newLevel) ?? 'open',
      reason,
      expiresAt,
      actorId,
      automatic: automatic ? 1 : 0,
      note
    }
  );
}

export async function pageProtectionEvents(pageId: number, limit = 20) {
  return query<any>(
    `SELECT ${pageProtectionEventFields}, COALESCE(u.display_name,u.username,'자동') AS actor_name
     FROM page_protection_events ppe
     LEFT JOIN users u ON u.id=ppe.changed_by
     WHERE ppe.page_id=:pageId
     ORDER BY ppe.created_at DESC, ppe.id DESC
     LIMIT :limit`,
    { pageId, limit }
  );
}

export async function maybeEscalatePageProtection(
  pageId: number,
  reason: 'vandalism' | 'edit_war' | 'spam' | 'privacy' | 'server_dispute' | 'policy' = 'vandalism',
  actorId: number | null = null
) {
  const page = await getPageById(pageId);
  if (!page || page.status === 'deleted') return null;
  const current = normalizeProtectionLevel(page.protection_level) ?? 'open';
  if (!['open', 'review_required'].includes(current)) return null;
  const [reportStats, rollbackStats] = await Promise.all([
    one<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM reports
       WHERE page_id=:pageId AND status IN ('open','reviewing') AND created_at >= DATE_SUB(NOW(), INTERVAL 7 DAY)`,
      { pageId }
    ),
    one<{ count: number }>(
      `SELECT COUNT(*) AS count
       FROM page_revision_actions
       WHERE page_id=:pageId AND action='rollback' AND created_at >= DATE_SUB(NOW(), INTERVAL 24 HOUR)`,
      { pageId }
    )
  ]);
  const reports = Number(reportStats?.count ?? 0);
  const rollbacks = Number(rollbackStats?.count ?? 0);
  if (reports < 3 && rollbacks < 3) return null;
  const next = current === 'open' ? 'review_required' : 'autoconfirmed_only';
  const expiresAt = current === 'open' ? 'DATE_ADD(NOW(), INTERVAL 3 DAY)' : 'DATE_ADD(NOW(), INTERVAL 7 DAY)';
  await exec(
    `UPDATE pages
     SET protection_level=:next, status='protected', updated_at=NOW()
     WHERE id=:pageId AND protection_level=:current`,
    { pageId, next, current }
  );
  await exec(
    `INSERT INTO page_protection_events (page_id, old_level, new_level, reason, expires_at, changed_by, is_automatic, note, created_at)
     VALUES (:pageId, :current, :next, :reason, ${expiresAt}, :actorId, 1, :note, NOW())`,
    { pageId, current, next, reason, actorId, note: `최근 신고 ${reports}건, 되돌리기 ${rollbacks}건` }
  );
  await exec(
    `INSERT INTO recent_changes (page_id, actor_id, change_type, title, namespace_code, summary, created_at)
     VALUES (:pageId, :actorId, 'protect', :title, :namespaceCode, '반달 대응 강화', NOW())`,
    { pageId, actorId, title: page.title, namespaceCode: page.namespace_code }
  );
  return { pageId, oldLevel: current, newLevel: next, reports, rollbacks };
}

export async function deletePage(pageId: number, actorId: number | null) {
  const page = await getPageById(pageId);
  await exec(`UPDATE pages SET status='deleted', updated_at=NOW() WHERE id=:pageId`, { pageId });
  await logAdmin(actorId, 'page.delete', 'page', pageId, {});
  await exec(
    `INSERT INTO recent_changes (page_id, actor_id, change_type, title, namespace_code, summary, created_at)
     VALUES (:pageId, :actorId, 'delete', :title, :namespaceCode, '문서 삭제', NOW())`,
    { pageId, actorId, title: page?.title ?? '', namespaceCode: page?.namespace_code ?? 'main' }
  );
}

export async function restorePage(pageId: number, actorId: number | null) {
  const page = await getPageById(pageId);
  await exec(`UPDATE pages SET status='normal', updated_at=NOW() WHERE id=:pageId`, { pageId });
  await logAdmin(actorId, 'page.restore', 'page', pageId, {});
  await exec(
    `INSERT INTO recent_changes (page_id, actor_id, change_type, title, namespace_code, summary, created_at)
     VALUES (:pageId, :actorId, 'restore', :title, :namespaceCode, '문서 복구', NOW())`,
    { pageId, actorId, title: page?.title ?? '', namespaceCode: page?.namespace_code ?? 'main' }
  );
}

export async function movePage(pageId: number, namespace: NamespaceCode, title: string, actorId: number | null, reason: string | null) {
  const page = await getPageById(pageId);
  if (!page) throw new Error('page_not_found');
  const newSlug = slugifyTitle(title);
  await tx(async (conn) => {
    const newNamespaceId = await namespaceId(namespace, conn);
    const pageSpace = await pageSpaceForTitle(namespace, title, conn);
    await conn.execute(
      `INSERT INTO page_moves (page_id, old_namespace_id, old_title, old_slug, new_namespace_id, new_title, new_slug, moved_by, reason, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [pageId, page.namespace_id, page.title, page.slug, newNamespaceId, title, newSlug, actorId, reason]
    );
    await conn.execute(
      `UPDATE pages
       SET namespace_id=?, space_id=?, local_path=?, title=?, display_title=?, slug=?, updated_at=NOW()
       WHERE id=?`,
      [newNamespaceId, pageSpace.spaceId, pageSpace.localPath, title, title, newSlug, pageId]
    );
  });
  const movedPage = await getPageById(pageId);
  if (movedPage) await rebuildPageArtifacts(movedPage);
  await exec(
    `INSERT IGNORE INTO page_aliases (namespace_id, alias_slug, alias_title, target_page_id, alias_type, created_at)
     VALUES (:namespaceId, :aliasSlug, :aliasTitle, :pageId, 'redirect', NOW())`,
    { namespaceId: page.namespace_id, aliasSlug: page.slug, aliasTitle: page.title, pageId }
  );
  await exec(
    `INSERT INTO recent_changes (page_id, actor_id, change_type, title, namespace_code, summary, created_at)
     VALUES (:pageId, :actorId, 'move', :title, :namespaceCode, :reason, NOW())`,
    { pageId, actorId, title, namespaceCode: namespace, reason }
  );
  await logAdmin(actorId, 'page.move', 'page', pageId, { from: `${page.namespace_code}:${page.title}`, to: `${namespace}:${title}`, reason });
}

export async function hideRevision(revisionId: number, actorId: number | null, reason = '관리자 리비전 숨김', visibility: 'hidden' | 'admin_only' | 'suppressed' = 'admin_only') {
  const revision = await one<any>(`SELECT visibility FROM page_revisions WHERE id=:revisionId`, { revisionId });
  await exec(`UPDATE page_revisions SET visibility=:visibility WHERE id=:revisionId`, { revisionId, visibility });
  await exec(
    `INSERT INTO revision_visibility_logs (revision_id, old_visibility, new_visibility, reason, changed_by, created_at)
     VALUES (:revisionId, :oldVisibility, :visibility, :reason, :actorId, NOW())`,
    { revisionId, oldVisibility: revision?.visibility ?? null, visibility, reason, actorId }
  );
  await logAdmin(actorId, 'revision.hide', 'revision', revisionId, { reason, visibility });
}

export async function unhideRevision(revisionId: number, actorId: number | null, reason = '관리자 리비전 숨김 해제') {
  const revision = await one<any>(`SELECT visibility FROM page_revisions WHERE id=:revisionId`, { revisionId });
  await exec(`UPDATE page_revisions SET visibility='public' WHERE id=:revisionId`, { revisionId });
  await exec(
    `INSERT INTO revision_visibility_logs (revision_id, old_visibility, new_visibility, reason, changed_by, created_at)
     VALUES (:revisionId, :oldVisibility, 'public', :reason, :actorId, NOW())`,
    { revisionId, oldVisibility: revision?.visibility ?? null, reason, actorId }
  );
  await logAdmin(actorId, 'revision.unhide', 'revision', revisionId, { reason });
}

export async function logAdmin(actorId: number | null, action: string, targetType: string, targetId: number | null, details: unknown) {
  await exec(
    `INSERT INTO admin_logs (actor_id, action, target_type, target_id, details, created_at)
     VALUES (:actorId, :action, :targetType, :targetId, :details, NOW())`,
    { actorId, action, targetType, targetId, details: JSON.stringify(details) }
  );
}

export function makeClaimToken() {
  const token = `minewiki-${crypto.randomBytes(18).toString('hex')}`;
  return { token, tokenHash: hashContent(token) };
}

function inferPageType(namespace: NamespaceCode, components: Array<{ name: string }>) {
  if (namespace === 'server') return 'server';
  if (namespace === 'mod') return 'mod';
  if (components.some((component) => component.name === 'mob_info')) return 'mob';
  if (components.some((component) => component.name === 'item_info')) return 'item';
  if (components.some((component) => component.name === 'block_info')) return 'block';
  return 'article';
}

function yesNo(value?: string) {
  if (!value) return 'unknown';
  if (value.includes('예')) return 'yes';
  if (value.includes('아니오')) return 'no';
  if (value.includes('선택')) return 'optional';
  return 'unknown';
}

function serverEdition(value?: string) {
  if (!value) return 'unknown';
  if (/bedrock/i.test(value)) return 'bedrock';
  if (/java/i.test(value)) return 'java';
  if (/cross/i.test(value)) return 'crossplay';
  return 'unknown';
}

function serverOperationalStatus(value?: string) {
  if (!value) return 'unverified';
  if (value.includes('분쟁')) return 'disputed';
  if (value.includes('종료') || value.includes('폐쇄')) return 'closed';
  if (value.includes('중단') || value.includes('비활성')) return 'inactive';
  if (value.includes('실패')) return 'checking_failed';
  if (value.includes('운영') || value.includes('정상')) return 'active';
  return 'unverified';
}

function verificationStatus(value?: string) {
  if (value === '최신') return 'latest';
  if (value === '일부 오래됨') return 'partial_old';
  if (value === '스냅샷 기준') return 'snapshot';
  if (value === '분쟁 중') return 'disputed';
  return 'needs_check';
}

function editionFromText(value?: string) {
  if (!value) return 'unknown';
  if (/Java/i.test(value) && /Bedrock/i.test(value)) return 'both';
  if (/Java/i.test(value)) return 'java';
  if (/Bedrock/i.test(value)) return 'bedrock';
  return 'unknown';
}

function toDateOrNull(value?: string) {
  if (!value) return null;
  const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (iso) return `${iso[1]}-${iso[2]}-${iso[3]}`;
  const dotted = value.match(/^(\d{4})\.(\d{2})\.(\d{2})\./);
  if (dotted) return `${dotted[1]}-${dotted[2]}-${dotted[3]}`;
  return null;
}
