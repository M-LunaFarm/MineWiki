import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import net from 'node:net';
import dns from 'node:dns/promises';
import { domainToASCII } from 'node:url';
import bcrypt from 'bcryptjs';
import AdmZip from 'adm-zip';
import Fastify from 'fastify';
import cookie from '@fastify/cookie';
import formbody from '@fastify/formbody';
import multipart from '@fastify/multipart';
import fastifyStatic from '@fastify/static';
import { config } from './config.js';
import { blockUser, can, currentUser, login, unblockUser } from './auth.js';
import { sendPasswordResetEmail, sendVerificationEmail } from './email.js';
import { exec, one, query } from './db.js';
import {
  addPageAlias,
  deletePage,
  diffRevisions,
  enforceOpenBetaEditPolicy,
  enqueueNoClickSearchTasks,
  enqueueJob,
  ensureCoreData,
  evaluateUserTrust,
  failedSearches,
  getSection,
  getPageAtRevision,
  getPageByAlias,
  getPageById,
  getPageByTitle,
  getPageByTitleIncludingDeleted,
  hideRevision,
  logAdmin,
  logSearchQuery,
  makeClaimToken,
  modDetails,
  movePage,
  noClickSearches,
  pageCategories,
  pageLinks,
  pageRevision,
  pageRevisionById,
  pageRevisions,
  pageProtectionEvents,
  pagesInCategory,
  protectPage,
  qualityList,
  recentChanges,
  recordSearchClick,
  resolveSearchQuery,
  maybeEscalatePageProtection,
  restorePage,
  rollbackToRevision,
  runConsistencyChecks,
  runNextJob,
  savePage,
  saveSection,
  searchPages,
  searchSuggestions,
  serverList,
  syncPageSpaces,
  unhideRevision,
  rebuildDailyOperationSummary,
  rebuildOpenBetaWeeklyStats
} from './wiki/repository.js';
import { escapeHtml, parseMarkup, renderDocument } from './wiki/markup.js';
import { parseLinkTarget, resolveWikiPath, wikiLinkKey, wikiUrl } from './wiki/namespaces.js';
import { hashContent, normalizeSearch, normalizeTitle } from './wiki/normalize.js';
import { isSpecialQualityKind, specialQualityLabel } from './wiki/special.js';
import {
  aclHistoryPage,
  adminAuditHubPage,
  adminBackupManifestPage,
  adminEditFiltersPage,
  adminFilesPage,
  adminIdentityPage,
  adminImportsPage,
  adminJobsPage,
  adminPage,
  adminPublicationPage,
  adminReleasePage,
  adminReportsPage,
  adminSearchPage,
  adminSubwikiRequestPage,
  adminSubwikisPage,
  announcementsPage,
  articlePage,
  authErrorPage,
  authPage,
  categoryPage,
  editConflictPage,
  emailVerificationSentPage,
  developHubPage,
  dataListPage,
  discussionPage,
  editPage,
  fileDetailPage,
  fileUploadPage,
  invalidEmailVerificationPage,
  invalidPasswordResetPage,
  layout,
  logoutConfirmPage,
  messagePage,
  modIndexPage,
  modOperatorDashboardPage,
  modVerificationPage,
  myServersPage,
  newDocumentPage,
  newDocumentFormPage,
  newModWikiPage,
  newSubwikiDocumentPage,
  openBetaPage,
  releaseNotesPage,
  passwordResetSentPage,
  documentTemplateFormPage,
  operatorHomePage,
  adminWorkPage,
  permissionInfoPage,
  contributorTasksPage,
  projectBoardsPage,
  formatDateTime,
  qualityPage,
  rawPage,
  reviewDetailPage,
  revisionDiffPage,
  revisionHistoryPage,
  revisionSearchPage,
  recentChangesPage,
  searchPage,
  serviceStatusPage,
  serverHubPage,
  serverClaimPage,
  serverWikiRequestPage,
  serverWikiRequestSubmittedPage,
  serverOperatorDashboardPage,
  spaceHomePage,
  turnstileErrorPage,
  turnstileWidget,
  userDashboardPage,
  watchlistPage
} from './ui.js';
import type { NamespaceCode } from './types.js';
import type { SavePageResult } from './wiki/repository.js';

const app = Fastify({ logger: true });

await (app as any).register(cookie, { secret: config.cookieSecret });
await (app as any).register(formbody);
await (app as any).register(multipart, { limits: { fileSize: 15 * 1024 * 1024 } });
await (app as any).register(fastifyStatic, {
  root: path.join(process.cwd(), 'public'),
  prefix: '/assets/',
  maxAge: '7d',
  immutable: config.nodeEnv === 'production'
});
await (app as any).register(fastifyStatic, {
  root: config.cdnRoot,
  prefix: '/cdn/',
  decorateReply: false,
  maxAge: '7d',
  immutable: config.nodeEnv === 'production'
});

const isProduction = config.nodeEnv === 'production';
const maxPageContentLength = 1_000_000;
const maxPreviewContentLength = 250_000;
const maxComponentPreviewTotalLength = 40_000;
const maxComponentPreviewFieldLength = 8_000;
const rateLimitBuckets = new Map<string, { count: number; resetAt: number }>();
const cookieIsSecure = isProduction || config.baseUrl.startsWith('https://');
const contributorTaskFields = `id, task_type, target_type, target_id, title, description, priority, status, assigned_to, created_by, due_at, completed_at, created_at, updated_at`;
const contributorTaskSelectFields = `ct.id, ct.task_type, ct.target_type, ct.target_id, ct.title, ct.description, ct.priority, ct.status, ct.assigned_to, ct.created_by, ct.due_at, ct.completed_at, ct.created_at, ct.updated_at,
  target_page.title AS target_title, target_page.display_title AS target_display_title, target_namespace.code AS target_namespace_code`;
const projectBoardFields = `id, page_id, name, description, status, created_by, created_at, updated_at`;
const projectBoardItemFields = `id, board_id, task_id, page_id, title, status, sort_order, assigned_to, created_at, updated_at`;
const serverSeasonFields = `id, space_id, season_key, title, status, starts_at, ends_at, summary, page_id, created_by, created_at, updated_at`;
const wikiSpaceFields = `id, code, space_key, name, title, slug, space_type, parent_space_id, root_page_id, root_namespace_code, root_path, description, status, created_by, owner_user_id, owner_page_id, created_at, updated_at`;
const entityServerFields = `page_id, name, host, edition, supported_versions, genres, verified_status, operational_status, whitelist, discord_url, website_url, status_enabled, last_checked, updated_at`;
const entityServerSelectFields = entityServerFields.split(', ').map((field) => `es.${field}`).join(', ');
const serverEndpointFields = `id, page_id, host, port, edition, enabled, created_at, updated_at`;
const modWikiFields = `id, space_id, mod_name, category, slug, loaders, supported_versions, official_url, source_url, license, creator_verified, verified_by, verified_at, status, last_checked, created_at, updated_at`;
const customDomainFields = `id, server_wiki_id, domain, status, dns_record_name, dns_record_value, ssl_status, created_by, verified_at, activated_at, created_at, updated_at`;
const announcementFields = `id, title, body, type, visibility, starts_at, ends_at, created_by, created_at, updated_at`;
const permissionAuditFields = `id, audit_key, actor_role, target_type, action, expected_result, actual_result, status, tested_by, tested_at, note, created_at`;
const securityReleaseCheckFields = `id, check_key, category, severity, status, note, checked_by, checked_at, created_at`;
const performanceCheckFields = `id, check_key, target_area, status, note, checked_by, checked_at, created_at`;
const openBetaWeeklyStatsFields = `week_start, new_users, active_users, page_views, searches, zero_result_searches, edits, page_creates, rollbacks, reports, pending_reviews, approved_reviews, rejected_reviews, server_claims, mod_verifications, file_license_issues, created_at, updated_at`;
const wikiDailyStatsFields = `stat_date, page_creates, edits, rollbacks, reports, pending_reviews, search_queries, zero_result_searches, new_users, active_users, mod_verifications, server_claims, created_at, updated_at`;
const openBetaSettingsFields = `id, signup_mode, new_user_edit_limit, new_user_external_link_limit, new_user_review_required, server_listing_mode, updated_by, updated_at`;
const serverClaimPublicFields = `id, page_id, user_id, method, target_host, record_name, COALESCE(expected_value, token_plain) AS expected_value, status, verified_at, last_verified_at, renewal_required_at, expires_at, last_checked_at, failure_reason, created_at, updated_at`;
const serverClaimVerifyFields = `id, page_id, user_id, method, target_host, record_name, COALESCE(expected_value, token_plain) AS expected_value, token_plain, status, verified_at, last_verified_at, renewal_required_at, expires_at, last_checked_at, failure_reason, created_at, updated_at`;
const serverDnsCheckFields = `id, claim_id, record_name, expected_value, found_values_json, status, error_message, checked_at`;
const aclRuleFields = `id, target_type, target_id, action, effect, subject_type, subject_value, sort_order, reason, expires_at, created_by, created_at, updated_at`;
const aclChangeLogFields = `acl.id, acl.target_type, acl.target_id, acl.action_type, acl.old_rule_json, acl.new_rule_json, acl.reason, acl.changed_by, acl.created_at`;
const pageSectionLockFields = `id, page_id, anchor, heading, lock_type, owner_group, reason, created_by, created_at, updated_at`;
const discussionThreadFields = `id, page_id, title, status, created_by, created_at, updated_at`;
const documentTemplateFields = `id, space_id, template_key, title, description, template_scope, target_area, default_category, content_raw, created_by, status, created_at, updated_at`;
const pendingReviewDraftFields = `review_id, namespace_code, title, content_raw, edit_summary, page_type, base_revision_id, is_minor, edit_tags, created_at`;
const subwikiRequestFields = `id, request_type, title, target_page_id, requested_by, status, note, created_at, updated_at`;
const betaInviteFields = `id, invite_code, invited_by, used_by, role_hint, status, expires_at, created_at, used_at`;
const adminWorkItemSelectFields = `awi.id, awi.work_type, awi.target_type, awi.target_id, awi.priority, awi.status, awi.assigned_to, awi.created_at, awi.updated_at`;
const userWikiFields = `id, user_id, space_id, username_slug, status, created_at, updated_at`;
const wikiSpaceBackupFields = `id, code, space_key, name, title, slug, space_type, parent_space_id, root_page_id, root_namespace_code, root_path, description, status, created_by, owner_user_id, owner_page_id, created_at, updated_at`;
const subwikiSettingsBackupFields = `space_id, logo_file_id, theme_key, sidebar_page_id, main_page_id, sidebar_enabled, home_title, allow_public_edit, public_edit_enabled, require_review, review_required, custom_domain, short_path, created_at, updated_at`;
const subwikiSidebarBackupFields = `id, space_id, parent_id, page_id, label, target_title, target_url, sort_order, created_at, updated_at`;
const subwikiRoleBackupFields = `id, space_id, user_id, role, status, granted_by, granted_at, revoked_at, revoked_by`;
const pageAliasBackupFields = `id, namespace_id, alias_slug, alias_title, target_page_id, alias_type, created_at`;
const serverOwnerFields = `id, page_id, user_id, role, status, granted_by, granted_at, revoked_at, revoked_by`;
const modVerificationTaskFields = `id, page_id, task_type, status, assigned_to, note, due_at, completed_at, created_at, updated_at`;
const sessionCookieOptions = {
  path: '/',
  httpOnly: true,
  sameSite: 'lax' as const,
  secure: cookieIsSecure,
  signed: true,
  maxAge: 60 * 60 * 24 * 30
};

if (isProduction && config.cookieSecret === 'dev-secret-change-me') {
  throw new Error('COOKIE_SECRET must be set in production');
}

app.addHook('onRequest', async (request) => {
  (request as any).user = await currentUser(request);
  if (isUnsafeMethod(request.method) && !passesCsrfOriginCheck(request)) {
    throw Object.assign(new Error('csrf_origin_mismatch'), { statusCode: 403 });
  }
});

app.addHook('onSend', async (_request, reply, payload) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'strict-origin-when-cross-origin');
  reply.header('X-Frame-Options', 'DENY');
  reply.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=()');
  reply.header(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      "frame-ancestors 'none'",
      "img-src 'self' data: https:",
      "style-src 'self' 'unsafe-inline'",
      "script-src 'self' https://challenges.cloudflare.com https://pagead2.googlesyndication.com https://ep2.adtrafficquality.google",
      "connect-src 'self' https://challenges.cloudflare.com https://pagead2.googlesyndication.com https://googleads.g.doubleclick.net https://ep1.adtrafficquality.google https://ep2.adtrafficquality.google https://csi.gstatic.com",
      "frame-src https://challenges.cloudflare.com https://googleads.g.doubleclick.net https://ep2.adtrafficquality.google https://www.google.com",
      "form-action 'self'",
      'upgrade-insecure-requests'
    ].join('; ')
  );
  return payload;
});

function isUnsafeMethod(method: string) {
  return !['GET', 'HEAD', 'OPTIONS'].includes(method.toUpperCase());
}

function passesCsrfOriginCheck(request: any) {
  const secFetchSite = String(request.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (['cross-site', 'same-site'].includes(secFetchSite)) return false;
  if (['same-origin', 'none'].includes(secFetchSite)) return true;
  const host = requestHost(request);
  const origin = String(request.headers.origin ?? '');
  if (origin && urlHostMatches(origin, host)) return true;
  const referer = String(request.headers.referer ?? '');
  if (referer && urlHostMatches(referer, host)) return true;
  return !request.cookies?.uid;
}

function requestHost(request: any) {
  return normalizeHttpHost(request.headers.host);
}

function urlHostMatches(value: string, host: string) {
  if (!host) return false;
  try {
    return normalizeHttpHost(new URL(value).host) === host;
  } catch {
    return false;
  }
}

function normalizeHttpHost(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw || /[\u0000-\u001f\u007f\s]/.test(raw)) return '';
  try {
    const hostname = new URL(`http://${raw}`).hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '');
    if (!hostname) return '';
    if (net.isIP(hostname)) return hostname.toLowerCase();
    const ascii = domainToASCII(hostname);
    if (ascii === 'localhost') return ascii;
    return ascii && isValidDomainName(ascii) ? ascii.toLowerCase() : '';
  } catch {
    return '';
  }
}

async function recordPageView(page: any, request: any) {
  const pageId = Number(page?.id ?? 0);
  if (!pageId || request.method !== 'GET') return;
  const pathValue = String(request.raw?.url ?? request.url ?? '').slice(0, 500) || '/';
  await exec(
    `INSERT INTO page_view_logs (page_id, user_id, path, viewed_at)
     VALUES (:pageId, :userId, :path, NOW())`,
    { pageId, userId: request.user?.id ?? null, path: pathValue }
  ).catch((error) => {
    request.log?.warn?.({ err: error, pageId }, 'page view logging failed');
  });
}

function turnstileIsConfigured() {
  return Boolean(config.turnstile.siteKey && config.turnstile.secretKey);
}

function turnstileToken(body: any) {
  return String(body?.['cf-turnstile-response'] ?? '').trim();
}

function requestRemoteIp(request: any) {
  const remoteAddress = request.ip || request.socket?.remoteAddress || '';
  const trustedProxy = isTrustedProxyAddress(remoteAddress);
  const cfIp = normalizeHeaderIp(request.headers['cf-connecting-ip']);
  if (trustedProxy && cfIp) return cfIp;
  const forwarded = normalizeHeaderIp(String(request.headers['x-forwarded-for'] ?? '').split(',')[0]);
  if (trustedProxy && forwarded) return forwarded;
  return remoteAddress;
}

function isTrustedProxyAddress(address: string) {
  const normalized = String(address ?? '').replace(/^::ffff:/, '');
  if (!normalized) return false;
  return normalized === '::1' || normalized === '127.0.0.1';
}

function normalizeHeaderIp(value: unknown) {
  const text = String(value ?? '').trim().replace(/^::ffff:/, '');
  return net.isIP(text) ? text : '';
}

function consumeRateLimit(request: any, scope: string, maxAttempts: number, windowMs: number, identity = '') {
  return consumeRateBucket(`${scope}:${requestRemoteIp(request) || 'unknown'}:${identity}`, maxAttempts, windowMs);
}

function consumeActorRateLimit(request: any, scope: string, maxIpAttempts: number, maxUserAttempts: number, windowMs: number) {
  if (!consumeRateLimit(request, `${scope}:ip`, maxIpAttempts, windowMs)) return false;
  const userId = request.user?.id;
  return !userId || consumeRateBucket(`${scope}:user:${userId}`, maxUserAttempts, windowMs);
}

function consumeRateBucket(key: string, maxAttempts: number, windowMs: number) {
  const now = Date.now();
  if (rateLimitBuckets.size > 10_000) {
    for (const [key, bucket] of rateLimitBuckets) {
      if (bucket.resetAt <= now) rateLimitBuckets.delete(key);
    }
  }
  const bucket = rateLimitBuckets.get(key);
  if (!bucket || bucket.resetAt <= now) {
    rateLimitBuckets.set(key, { count: 1, resetAt: now + windowMs });
    return true;
  }
  if (bucket.count >= maxAttempts) return false;
  bucket.count += 1;
  return true;
}

function rateLimitExceededPage() {
  return authErrorPage('요청 제한', '요청이 너무 많습니다. 잠시 후 다시 시도해 주세요.', '/', '대문으로 이동');
}

async function verifyTurnstileRequest(request: any, action: string) {
  if (!turnstileIsConfigured()) return;
  const token = turnstileToken(request.body);
  if (!token) {
    throw Object.assign(new Error('turnstile_required'), { statusCode: 400 });
  }
  const body = new URLSearchParams({
    secret: config.turnstile.secretKey,
    response: token,
    remoteip: requestRemoteIp(request),
    idempotency_key: crypto.randomUUID()
  });
  const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body
  });
  const result = await response.json().catch(() => ({})) as any;
  if (!response.ok || !result.success) {
    request.log?.warn?.({ action, errors: result['error-codes'] ?? [], hostname: result.hostname }, 'turnstile verification failed');
    throw Object.assign(new Error('turnstile_failed'), { statusCode: 400 });
  }
}

async function requireTurnstile(request: any, reply: any, action: string) {
  try {
    await verifyTurnstileRequest(request, action);
    return true;
  } catch {
    reply.code(400).type('text/html').send(turnstileErrorPage(request.user));
    return false;
  }
}

async function requireAnonymousTurnstile(request: any, reply: any, action: string) {
  if (request.user) return true;
  return requireTurnstile(request, reply, action);
}

function htmlError(reply: any, user: any, status: number, title: string, message: string, actionHref = '/wiki', actionLabel = '돌아가기') {
  return reply.code(status).type('text/html').send(
    messagePage(title, message, user, {
      tone: 'error',
      actionHref,
      actionLabel
    })
  );
}

function adminError(reply: any, user: any, status: number, title: string, message: string, actionHref = '/admin', actionLabel = '관리 화면') {
  return reply.code(status).type('text/html').send(
    messagePage(title, message, user, {
      tone: 'error',
      actionHref,
      actionLabel,
      currentSpace: 'admin'
    })
  );
}

function safeNextPath(value: unknown) {
  const raw = String(value ?? '').trim();
  if (!raw || !raw.startsWith('/') || raw.startsWith('//') || /[\u0000-\u001f\u007f]/.test(raw)) return '';
  try {
    new URL(raw, 'http://minewiki.local');
    return raw;
  } catch {
    return '';
  }
}

function requestNextPath(request: any) {
  return safeNextPath(request.raw?.url ?? request.url) || '/';
}

function loginHrefForRequest(request: any) {
  const next = requestNextPath(request);
  return next === '/login' ? '/login' : `/login?next=${encodeURIComponent(next)}`;
}

function accessActionOptions(request: any, user: any, fallbackHref = '/wiki', fallbackLabel = '위키로 이동') {
  if (!user) {
    return {
      actionHref: loginHrefForRequest(request),
      actionLabel: '로그인'
    };
  }
  return {
    actionHref: fallbackHref,
    actionLabel: fallbackLabel,
    secondaryHref: '/logout',
    secondaryLabel: '다른 계정으로 로그인'
  };
}

function adminAccessDenied(reply: any, request: any, message = '관리 권한이 필요합니다.') {
  const user = request.user;
  return reply.code(403).type('text/html').send(
    messagePage('권한 없음', message, user, {
      tone: 'error',
      currentSpace: 'admin',
      ...accessActionOptions(request, user)
    })
  );
}

function actionError(statusCode: number, errorCode: string, message = errorCode) {
  const error = new Error(message) as Error & { statusCode: number; errorCode: string };
  error.statusCode = statusCode;
  error.errorCode = errorCode;
  return error;
}

function jsonActionError(reply: any, error: any) {
  return reply.code(error?.statusCode ?? 400).send({ error: error?.errorCode ?? 'action_failed', message: String(error?.message ?? 'action failed') });
}

function subwikiManageError(reply: any, user: any, status: number, message: string, href: string) {
  const title = status === 402 ? '플랜 필요' : status === 403 ? '권한 없음' : status === 404 ? '위키 없음' : '입력 오류';
  return htmlError(reply, user, status, title, message, href, '관리 화면으로');
}

function aclActorForRequest(request: any) {
  const actorIpText = requestRemoteIp(request);
  return request.user ? { ...request.user, actorIpText } : { anonymous: true, groups: [], permissions: [], actorIpText };
}

function normalizeEmail(value: unknown) {
  const email = String(value ?? '').trim().toLowerCase();
  if (!email || email.length > 255) return '';
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return '';
  return email;
}

function hashVerificationToken(token: string) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

function verificationExpiresAt() {
  const hours = Number.isFinite(config.emailVerification.expiresHours) ? Math.max(1, config.emailVerification.expiresHours) : 24;
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

function passwordResetExpiresAt() {
  return new Date(Date.now() + 60 * 60 * 1000);
}

async function createEmailVerification(userId: number, email: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  await exec(
    `INSERT INTO email_verification_tokens (user_id, email, token_hash, purpose, expires_at, created_at)
     VALUES (:userId, :email, :tokenHash, 'signup', :expiresAt, NOW())`,
    { userId, email, tokenHash: hashVerificationToken(token), expiresAt: verificationExpiresAt() }
  );
  await exec(`UPDATE users SET email_verification_sent_at=NOW(), updated_at=NOW() WHERE id=:userId`, { userId });
  return token;
}

async function createPasswordReset(userId: number, email: string) {
  const token = crypto.randomBytes(32).toString('base64url');
  await exec(`UPDATE password_reset_tokens SET consumed_at=NOW() WHERE user_id=:userId AND consumed_at IS NULL`, { userId });
  await exec(
    `INSERT INTO password_reset_tokens (user_id, email, token_hash, expires_at, created_at)
     VALUES (:userId, :email, :tokenHash, :expiresAt, NOW())`,
    { userId, email, tokenHash: hashVerificationToken(token), expiresAt: passwordResetExpiresAt() }
  );
  return token;
}

function emailVerificationUrl(token: string) {
  const url = new URL('/verify-email', config.baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

function passwordResetUrl(token: string) {
  const url = new URL('/reset-password', config.baseUrl);
  url.searchParams.set('token', token);
  return url.toString();
}

async function passwordResetByToken(token: string) {
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) return null;
  return one<any>(
    `SELECT prt.id AS token_id, prt.email, u.id AS user_id, u.display_name
     FROM password_reset_tokens prt
     JOIN users u ON u.id=prt.user_id
     WHERE prt.token_hash=:tokenHash
       AND prt.consumed_at IS NULL
       AND prt.expires_at > NOW()
       AND u.status='active'
     LIMIT 1`,
    { tokenHash: hashVerificationToken(token) }
  );
}

async function generatedInternalUsername() {
  for (let attempt = 0; attempt < 12; attempt += 1) {
    const username = `u${crypto.randomBytes(8).toString('hex')}`;
    const existing = await one<any>(`SELECT id FROM users WHERE username=:username`, { username });
    if (!existing) return username;
  }
  throw new Error('username_generation_failed');
}

app.get('/', async (request, reply) => {
  if (await renderCustomDomainWikiPage(request, reply, '')) return;
  return reply.redirect('/wiki/%EB%8C%80%EB%AC%B8');
});

app.get('/new', async (request, reply) => {
  return reply.type('text/html').send(newDocumentPage((request as any).user, request.query as any));
});

app.post('/new', async (request, reply) => {
  const body = request.body as any;
  const type = normalizeDocumentType(String(body.type ?? 'vanilla'));
  const title = normalizeTitle(String(body.title ?? ''));
  if (!title) return htmlError(reply, (request as any).user, 400, '입력 오류', '문서 제목을 입력하세요.', '/new', '새 문서');
  const { namespace } = documentTypeConfig(type);
  return reply.redirect(`${wikiUrl(namespace, title)}/edit?type=${encodeURIComponent(type)}`);
});

app.get('/new/wiki', async (request, reply) => {
  const templates = await documentTemplatesForSpace(null, 'basic');
  return reply.type('text/html').send(newDocumentFormPage('wiki', (request as any).user, request.query as any, [], templates));
});

app.post('/new/wiki', async (request, reply) => {
  const body = request.body as any;
  const title = normalizeTitle(String(body.title ?? ''));
  if (!title) return htmlError(reply, (request as any).user, 400, '입력 오류', '문서 제목을 입력하세요.', '/new/wiki', '위키 문서 만들기');
  const template = String(body.template ?? '').trim();
  return reply.redirect(`${wikiUrl('main', title)}/edit${template ? `?template=${encodeURIComponent(template)}` : '?blank=1'}`);
});

app.get('/new/mod-page', async (request, reply) => {
  const params = request.query as any;
  const rows = await modWikiCards({});
  const space = params.wikiSlug ? await modSubwikiSpace(String(params.wikiSlug)) : null;
  const templates = await documentTemplatesForSpace(space?.id ? Number(space.id) : null, 'mod_wiki');
  return reply.type('text/html').send(newDocumentFormPage('mod-page', (request as any).user, params, rows, templates));
});

app.post('/new/mod-page', async (request, reply) => {
  const body = request.body as any;
  const slug = normalizeTitle(String(body.wikiSlug ?? '')).replace(/^\/+|\/+$/g, '');
  const title = normalizeTitle(String(body.title ?? '')).replace(/^\/+|\/+$/g, '');
  if (!slug || !title) return htmlError(reply, (request as any).user, 400, '입력 오류', '모드 위키와 문서 제목을 모두 입력하세요.', '/new/mod-page', '모드 문서 만들기');
  const template = String(body.template ?? '').trim();
  return reply.redirect(`${wikiUrl('mod', `${slug}/${title}`)}/edit${template ? `?template=${encodeURIComponent(template)}` : '?blank=1'}`);
});

app.get('/new/server-page', async (request, reply) => {
  const params = request.query as any;
  const rows = await serverWikiCards({});
  const space = params.wikiSlug ? await serverSubwikiSpace(String(params.wikiSlug)) : null;
  const templates = await documentTemplatesForSpace(space?.id ? Number(space.id) : null, 'server_wiki');
  return reply.type('text/html').send(newDocumentFormPage('server-page', (request as any).user, params, rows, templates));
});

app.post('/new/server-page', async (request, reply) => {
  const body = request.body as any;
  const slug = normalizeTitle(String(body.wikiSlug ?? '')).replace(/^\/+|\/+$/g, '');
  const title = normalizeTitle(String(body.title ?? '')).replace(/^\/+|\/+$/g, '');
  if (!slug || !title) return htmlError(reply, (request as any).user, 400, '입력 오류', '서버 위키와 문서 제목을 모두 입력하세요.', '/new/server-page', '서버 문서 만들기');
  const template = String(body.template ?? '').trim();
  const area = normalizeDocumentArea(body.area);
  const params = new URLSearchParams();
  if (template) params.set('template', template);
  else params.set('blank', '1');
  if (area) params.set('area', area);
  const queryString = params.toString();
  return reply.redirect(`${wikiUrl('server', `${slug}/${title}`)}/edit${queryString ? `?${queryString}` : '?blank=1'}`);
});

app.get('/new/dev', async (request, reply) => {
  const templates = await documentTemplatesForSpace(null, 'developer');
  return reply.type('text/html').send(newDocumentFormPage('dev', (request as any).user, request.query as any, [], templates));
});

app.post('/new/dev', async (request, reply) => {
  const body = request.body as any;
  const title = normalizeTitle(String(body.title ?? ''));
  if (!title) return htmlError(reply, (request as any).user, 400, '입력 오류', '문서 제목을 입력하세요.', '/new/dev', '개발 문서 만들기');
  const template = String(body.template ?? '').trim();
  return reply.redirect(`${wikiUrl('dev', title)}/edit${template ? `?template=${encodeURIComponent(template)}` : '?blank=1'}`);
});

app.get('/robots.txt', async (_request, reply) => {
  reply.type('text/plain; charset=utf-8');
  return `User-agent: *
Allow: /

Sitemap: ${new URL('/sitemap.xml', config.baseUrl).toString()}
`;
});

app.get('/favicon.ico', async (_request, reply) => reply.redirect('/assets/favicon.svg'));

app.get('/sitemap.xml', async (_request, reply) => {
  const publicActor = { anonymous: true, groups: [], permissions: [], actorIpText: '' };
  const rows = await query<any>(
    `SELECT p.id, p.space_id, p.protection_level, p.status, n.code AS namespace_code, p.title, p.updated_at
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE p.status NOT IN ('deleted','hidden') AND n.code IN ('main','guide','data','mod','modpack','server','dev','help','project')
     ORDER BY p.updated_at DESC
     LIMIT 5000`
  );
  const visibleRows = [];
  for (const row of rows) {
    if (await canReadPageResource(publicActor, row)) visibleRows.push(row);
  }
  const urls = visibleRows
    .map(
      (row) => `<url><loc>${xmlEscape(new URL(wikiUrl(row.namespace_code, row.title), config.baseUrl).toString())}</loc><lastmod>${new Date(row.updated_at).toISOString()}</lastmod></url>`
    )
    .join('');
  reply.type('application/xml; charset=utf-8');
  return `<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"><url><loc>${xmlEscape(config.baseUrl)}</loc></url>${urls}</urlset>`;
});

app.get('/login', async (request, reply) => {
  const next = safeNextPath((request.query as any).next);
  const nextInput = next ? `<input type="hidden" name="next" value="${escapePage(next)}">` : '';
  return reply.type('text/html').send(
    authPage(
      '로그인',
      '이메일 로그인',
      'MineWiki에 로그인',
      `<form class="auth-form" method="post">
        ${nextInput}
        <label>이메일
          <input name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required>
        </label>
        <label>비밀번호
          <input name="password" type="password" autocomplete="current-password" placeholder="비밀번호" required>
        </label>
        <div class="auth-row"><a href="/forgot-password">비밀번호를 잊으셨나요?</a></div>
        ${turnstileWidget('login')}
        <button>로그인</button>
      </form>
      <p class="auth-switch">계정이 없나요? <a href="/join">가입하기</a></p>`,
      (request as any).user
    )
  );
});

app.get('/join', async (request, reply) => {
  const inviteCode = String((request.query as any).invite ?? '');
  const settings = await one<any>(`SELECT signup_mode FROM open_beta_settings WHERE id=1`);
  if (settings?.signup_mode === 'closed') {
    return reply.code(403).type('text/html').send(messagePage('가입 닫힘', '현재 베타 가입이 닫혀 있습니다.', (request as any).user, { tone: 'error', actionHref: '/login', actionLabel: '로그인' }));
  }
  return reply.type('text/html').send(
    authPage(
      '베타 가입',
      '이메일 인증 가입',
      'MineWiki 계정 만들기',
      `<form class="auth-form" method="post">
        <label>초대 코드
          <input name="inviteCode" value="${escapePage(inviteCode)}" placeholder="${settings?.signup_mode === 'invite' ? '초대 코드' : '선택 사항'}" ${settings?.signup_mode === 'invite' ? 'required' : ''}>
        </label>
        <label>표시 이름
          <input name="displayName" autocomplete="name" placeholder="문서와 토론에 표시될 이름" required>
        </label>
        <label>이메일
          <input name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required>
        </label>
        <label>비밀번호
          <input name="password" type="password" autocomplete="new-password" placeholder="8자 이상" required>
        </label>
        <label>비밀번호 확인
          <input name="passwordConfirm" type="password" autocomplete="new-password" placeholder="한 번 더 입력" required>
        </label>
        ${turnstileWidget('signup')}
        <button>가입</button>
      </form>
      <p class="auth-note">아이디는 공개 로그인 수단으로 쓰지 않습니다. 로그인은 이메일과 비밀번호로만 가능합니다.</p>
      <p class="auth-switch">이미 계정이 있나요? <a href="/login">로그인</a></p>`,
      (request as any).user
    )
  );
});

app.post('/join', async (request, reply) => {
  const settings = await one<any>(`SELECT signup_mode FROM open_beta_settings WHERE id=1`);
  if (settings?.signup_mode === 'closed') {
    return reply
      .code(403)
      .type('text/html')
      .send(messagePage('가입 닫힘', '현재 새 계정 가입을 받지 않습니다.', (request as any).user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  }
  const body = request.body as any;
  const displayName = String(body.displayName ?? '').trim();
  const email = normalizeEmail(body.email);
  const password = String(body.password ?? '');
  const passwordConfirm = String(body.passwordConfirm ?? '');
  if (
    !consumeRateLimit(request, 'signup:ip', 8, 60 * 60 * 1000) ||
    (email && !consumeRateLimit(request, 'signup:email', 3, 60 * 60 * 1000, email))
  ) {
    return reply.code(429).type('text/html').send(rateLimitExceededPage());
  }
  if (!(await requireTurnstile(request, reply, 'signup'))) return reply;
  if (displayName.length < 2 || displayName.length > 64) return reply.code(400).type('text/html').send(authErrorPage('가입 오류', '표시 이름은 2~64자여야 합니다.', '/join', '가입으로 돌아가기'));
  if (!email) return reply.code(400).type('text/html').send(authErrorPage('가입 오류', '올바른 이메일 주소를 입력하세요.', '/join', '가입으로 돌아가기'));
  if (password.length < 8) return reply.code(400).type('text/html').send(authErrorPage('가입 오류', '비밀번호는 8자 이상이어야 합니다.', '/join', '가입으로 돌아가기'));
  if (password !== passwordConfirm) return reply.code(400).type('text/html').send(authErrorPage('가입 오류', '비밀번호 확인이 일치하지 않습니다.', '/join', '가입으로 돌아가기'));
  let invite: any = null;
  const inviteCode = String(body.inviteCode ?? '').trim();
  if (settings?.signup_mode === 'invite' || inviteCode) {
    invite = await betaInviteByCode(inviteCode);
    if (!invite) return reply.code(404).type('text/html').send(authErrorPage('초대 코드 없음', '초대 코드를 찾을 수 없습니다.', '/join', '가입으로 돌아가기'));
  }
  const existing = await one<any>(`SELECT id FROM users WHERE email=:email`, { email });
  if (existing) return reply.code(409).type('text/html').send(authErrorPage('가입 오류', '이미 사용 중인 이메일입니다.', '/login', '로그인으로 이동'));
  const username = await generatedInternalUsername();
  const passwordHash = await bcrypt.hash(password, 10);
  const result = await exec(
    `INSERT INTO users (username, display_name, email, password_hash, status, created_at, updated_at)
     VALUES (:username, :displayName, :email, :passwordHash, 'pending', NOW(), NOW())`,
    { username, displayName, email, passwordHash }
  );
  const userId = Number(result.insertId);
  const groupCode = betaInviteGroup(invite?.role_hint);
  await exec(`INSERT IGNORE INTO user_groups (user_id, group_id) SELECT :userId, id FROM groups WHERE code=:groupCode`, { userId, groupCode });
  const token = await createEmailVerification(userId, email);
  try {
    await sendVerificationEmail(email, displayName, emailVerificationUrl(token));
  } catch (error) {
    request.log.error({ err: error, userId }, 'email verification send failed');
    await exec(`DELETE FROM email_verification_tokens WHERE user_id=:userId AND consumed_at IS NULL`, { userId });
    await exec(`DELETE FROM user_groups WHERE user_id=:userId`, { userId });
    await exec(`DELETE FROM users WHERE id=:userId AND status='pending'`, { userId });
    return reply.code(500).type('text/html').send(messagePage('이메일 전송 실패', `인증 메일 발송에 실패했습니다. ${config.supportEmail}로 문의하세요.`, null, { tone: 'error', actionHref: '/join', actionLabel: '가입으로 돌아가기' }));
  }
  if (invite) await exec(`UPDATE beta_invites SET status='used', used_by=:userId, used_at=NOW() WHERE id=:id`, { userId, id: invite.id });
  return reply.type('text/html').send(emailVerificationSentPage(email));
});

app.get('/verify-email', async (request, reply) => {
  if (!consumeRateLimit(request, 'verify-email:ip', 30, 15 * 60 * 1000)) {
    return reply.code(429).type('text/html').send(rateLimitExceededPage());
  }
  const token = String((request.query as any).token ?? '').trim();
  if (!/^[A-Za-z0-9_-]{20,200}$/.test(token)) {
    return reply.code(400).type('text/html').send(invalidEmailVerificationPage());
  }
  const verification = await one<any>(
    `SELECT evt.id AS token_id, evt.email AS token_email, u.id AS user_id, u.username, u.status
     FROM email_verification_tokens evt
     JOIN users u ON u.id=evt.user_id
     WHERE evt.token_hash=:tokenHash
       AND evt.consumed_at IS NULL
       AND evt.expires_at > NOW()
       AND u.status IN ('pending','active')
     LIMIT 1`,
    { tokenHash: hashVerificationToken(token) }
  );
  if (!verification) {
    return reply.code(400).type('text/html').send(invalidEmailVerificationPage());
  }
  await exec(
    `UPDATE users
     SET status='active', email_verified_at=COALESCE(email_verified_at, NOW()), updated_at=NOW()
     WHERE id=:userId AND status IN ('pending','active')`,
    { userId: verification.user_id }
  );
  await exec(`UPDATE email_verification_tokens SET consumed_at=NOW() WHERE id=:tokenId`, { tokenId: verification.token_id });
  await ensureUserWiki(Number(verification.user_id));
  reply.setCookie('uid', String(verification.user_id), sessionCookieOptions);
  return reply.redirect(`/user/${encodeURIComponent(String(verification.username))}`);
});

app.post('/login', async (request, reply) => {
  const body = request.body as any;
  const email = normalizeEmail(body.email);
  if (
    !consumeRateLimit(request, 'login:ip', 20, 15 * 60 * 1000) ||
    (email && !consumeRateLimit(request, 'login:email', 8, 15 * 60 * 1000, email))
  ) {
    return reply.code(429).type('text/html').send(rateLimitExceededPage());
  }
  if (!(await requireTurnstile(request, reply, 'login'))) return reply;
  const user = await login(email, body.password);
  if (!user) return reply.code(401).type('text/html').send(authErrorPage('로그인 실패', '이메일 또는 비밀번호가 올바르지 않습니다.'));
  await ensureUserWiki(Number(user.id));
  reply.setCookie('uid', String(user.id), sessionCookieOptions);
  return reply.redirect(safeNextPath(body.next) || '/');
});

app.get('/forgot-password', async (request, reply) =>
  reply.type('text/html').send(
    authPage(
      '비밀번호 찾기',
      '계정 복구',
      '비밀번호 재설정',
      `<form class="auth-form" method="post">
        <label>가입 이메일
          <input name="email" type="email" inputmode="email" autocomplete="email" placeholder="you@example.com" required>
        </label>
        ${turnstileWidget('password_reset_request')}
        <button>재설정 메일 보내기</button>
      </form>
      <p class="auth-switch"><a href="/login">로그인으로 돌아가기</a></p>`,
      (request as any).user
    )
  )
);

app.post('/forgot-password', async (request, reply) => {
  const body = request.body as any;
  const email = normalizeEmail(body.email);
  if (
    !consumeRateLimit(request, 'forgot-password:ip', 8, 60 * 60 * 1000) ||
    (email && !consumeRateLimit(request, 'forgot-password:email', 3, 60 * 60 * 1000, email))
  ) {
    return reply.code(429).type('text/html').send(rateLimitExceededPage());
  }
  if (!(await requireTurnstile(request, reply, 'password_reset_request'))) return reply;
  if (email) {
    const user = await one<any>(`SELECT id, display_name, email FROM users WHERE email=:email AND status='active' LIMIT 1`, { email });
    if (user?.id && user?.email) {
      try {
        const token = await createPasswordReset(Number(user.id), String(user.email).toLowerCase());
        await sendPasswordResetEmail(String(user.email), String(user.display_name ?? 'MineWiki 사용자'), passwordResetUrl(token));
      } catch (error) {
        request.log.error({ err: error, email }, 'password reset email send failed');
      }
    }
  }
  return reply.type('text/html').send(passwordResetSentPage());
});

app.get('/reset-password', async (request, reply) => {
  const token = String((request.query as any).token ?? '').trim();
  const reset = await passwordResetByToken(token);
  if (!reset) return reply.code(400).type('text/html').send(invalidPasswordResetPage());
  return reply.type('text/html').send(
    authPage(
      '비밀번호 재설정',
      '새 비밀번호',
      '비밀번호 다시 설정',
      `<form class="auth-form" method="post">
        <input type="hidden" name="token" value="${escapePage(token)}">
        <label>새 비밀번호
          <input name="password" type="password" autocomplete="new-password" placeholder="8자 이상" required>
        </label>
        <label>새 비밀번호 확인
          <input name="passwordConfirm" type="password" autocomplete="new-password" placeholder="한 번 더 입력" required>
        </label>
        ${turnstileWidget('password_reset')}
        <button>비밀번호 변경</button>
      </form>`,
      (request as any).user
    )
  );
});

app.post('/reset-password', async (request, reply) => {
  const body = request.body as any;
  const token = String(body.token ?? '').trim();
  if (!consumeRateLimit(request, 'reset-password:ip', 10, 15 * 60 * 1000, token.slice(0, 16))) {
    return reply.code(429).type('text/html').send(rateLimitExceededPage());
  }
  if (!(await requireTurnstile(request, reply, 'password_reset'))) return reply;
  const reset = await passwordResetByToken(token);
  if (!reset) return reply.code(400).type('text/html').send(invalidPasswordResetPage());
  const password = String(body.password ?? '');
  const passwordConfirm = String(body.passwordConfirm ?? '');
  if (password.length < 8) return reply.code(400).type('text/html').send(authErrorPage('비밀번호 재설정 오류', '비밀번호는 8자 이상이어야 합니다.', `/reset-password?token=${encodeURIComponent(token)}`, '다시 입력'));
  if (password !== passwordConfirm) return reply.code(400).type('text/html').send(authErrorPage('비밀번호 재설정 오류', '비밀번호 확인이 일치하지 않습니다.', `/reset-password?token=${encodeURIComponent(token)}`, '다시 입력'));
  const passwordHash = await bcrypt.hash(password, 10);
  await exec(
    `UPDATE users
     SET password_hash=:passwordHash, email_verified_at=COALESCE(email_verified_at, NOW()), updated_at=NOW()
     WHERE id=:userId AND status='active'`,
    { passwordHash, userId: reset.user_id }
  );
  await exec(`UPDATE password_reset_tokens SET consumed_at=NOW() WHERE id=:tokenId`, { tokenId: reset.token_id });
  await exec(`UPDATE password_reset_tokens SET consumed_at=NOW() WHERE user_id=:userId AND consumed_at IS NULL`, { userId: reset.user_id });
  return reply.type('text/html').send(
    authPage(
      '비밀번호 변경 완료',
      '완료',
      '비밀번호가 변경되었습니다.',
      `<p class="auth-message">새 비밀번호로 다시 로그인할 수 있습니다.</p>
       <div class="auth-actions"><a class="button" href="/login">로그인</a></div>`
    )
  );
});

app.get('/logout', async (request, reply) => {
  return reply.type('text/html').send(logoutConfirmPage((request as any).user));
});

app.post('/logout', async (_request, reply) => {
  reply.clearCookie('uid', { path: '/', sameSite: 'lax', secure: cookieIsSecure });
  return reply.redirect('/');
});

app.get('/recent', async (request, reply) => {
  const q = request.query as any;
  const filters = recentChangeFilters(q, false);
  const rows = await recentChanges({ ...filters, limit: 50 });
  return reply.type('text/html').send(recentChangesPage(rows, q, (request as any).user));
});

app.get('/admin/recent', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.redirect(loginHrefForRequest(request));
  const q = request.query as any;
  const filters = recentChangeFilters({ includeManagement: '1', includeDeleted: '1', ...q }, true);
  filters.actorId = await recentActorIdFromQuery(q, true);
  const rows = await recentChanges({ ...filters, limit: 100 });
  return reply.type('text/html').send(recentChangesPage(rows, { includeManagement: '1', includeDeleted: '1', ...q }, user, { admin: true }));
});

app.get('/api/recent', async (request) => {
  const user = (request as any).user;
  const q = request.query as any;
  const privileged = can(user, 'report.handle');
  const filters = recentChangeFilters(q, privileged);
  filters.actorId = await recentActorIdFromQuery(q, privileged);
  return recentChanges({ ...filters, limit: Math.min(Number(q.limit || 50), privileged ? 200 : 50) });
});

app.get('/watchlist', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  const [pages, changes] = await Promise.all([watchedPages(user), watchedRecentChanges(user, 50)]);
  return reply.type('text/html').send(watchlistPage(pages, changes, user));
});

app.post('/watchlist/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).type('text/html').send(messagePage('감시문서 오류', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/watchlist', actionLabel: '감시문서' }));
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) {
    return reply.code(404).type('text/html').send(messagePage('문서 없음', '감시 설정을 바꿀 문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/watchlist', actionLabel: '감시문서' }));
  }
  const watchDiscussion = (request.body as any)?.watchDiscussion === '0' ? 0 : 1;
  await exec(
    `INSERT INTO watched_pages (user_id, page_id, watch_discussion, created_at)
     VALUES (:userId, :pageId, :watchDiscussion, NOW())
     ON DUPLICATE KEY UPDATE watch_discussion=VALUES(watch_discussion)`,
    { userId: user.id, pageId, watchDiscussion }
  );
  return reply.redirect(safeNextPath((request.body as any)?.next) || '/watchlist');
});

app.post('/watchlist/:id/remove', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).type('text/html').send(messagePage('감시문서 오류', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/watchlist', actionLabel: '감시문서' }));
  await exec(`DELETE FROM watched_pages WHERE user_id=:userId AND page_id=:pageId`, { userId: user.id, pageId });
  return reply.redirect(safeNextPath((request.body as any)?.next) || '/watchlist');
});

app.get('/tasks', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  const [assigned, recommended, done] = await Promise.all([
    query<any>(
      `SELECT ${contributorTaskSelectFields}
       FROM contributor_tasks ct
       LEFT JOIN pages target_page ON target_page.id=ct.target_id AND ct.target_type IN ('page','server','mod')
       LEFT JOIN namespaces target_namespace ON target_namespace.id=target_page.namespace_id
       WHERE ct.assigned_to=:userId AND ct.status IN ('open','assigned')
       ORDER BY FIELD(ct.priority,'urgent','high','normal','low'), COALESCE(ct.due_at, ct.created_at), ct.id DESC LIMIT 50`,
      { userId: user.id }
    ),
    query<any>(
      `SELECT ${contributorTaskSelectFields}
       FROM contributor_tasks ct
       LEFT JOIN pages target_page ON target_page.id=ct.target_id AND ct.target_type IN ('page','server','mod')
       LEFT JOIN namespaces target_namespace ON target_namespace.id=target_page.namespace_id
       WHERE ct.assigned_to IS NULL AND ct.status='open'
       ORDER BY FIELD(ct.priority,'urgent','high','normal','low'), ct.id DESC LIMIT 30`
    ),
    query<any>(
      `SELECT ${contributorTaskSelectFields}
       FROM contributor_tasks ct
       LEFT JOIN pages target_page ON target_page.id=ct.target_id AND ct.target_type IN ('page','server','mod')
       LEFT JOIN namespaces target_namespace ON target_namespace.id=target_page.namespace_id
       WHERE ct.assigned_to=:userId AND ct.status='done'
       ORDER BY ct.completed_at DESC LIMIT 10`,
      { userId: user.id }
    )
  ]);
  const actor = aclActorForRequest(request);
  const [visibleAssigned, visibleRecommended, visibleDone] = await Promise.all([
    filterContributorTasksForActor(actor, assigned),
    filterContributorTasksForActor(actor, recommended),
    filterContributorTasksForActor(actor, done)
  ]);
  return reply.type('text/html').send(contributorTasksPage({ assigned: visibleAssigned, recommended: visibleRecommended, done: visibleDone }, user, request.query as any));
});

app.post('/tasks/:id/claim', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  const taskId = nullablePositiveInt((request.params as any).id);
  if (!taskId) return reply.code(400).type('text/html').send(messagePage('작업 오류', '작업을 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/tasks', actionLabel: '내 작업' }));
  const task = await contributorTaskRow(taskId);
  if (!task) return reply.code(404).type('text/html').send(messagePage('작업 없음', '선택한 작업을 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/tasks', actionLabel: '내 작업' }));
  const visible = await filterContributorTasksForActor(aclActorForRequest(request), [task]);
  if (!visible.length) return reply.code(403).type('text/html').send(messagePage('작업 접근 제한', '이 작업을 볼 권한이 없습니다.', user, { tone: 'error', actionHref: '/tasks', actionLabel: '내 작업' }));
  if (String(task.status ?? 'open') !== 'open' || task.assigned_to) {
    return reply.code(409).type('text/html').send(messagePage('이미 배정된 작업', '다른 사용자가 이미 맡았거나 더 이상 열려 있지 않은 작업입니다.', user, { tone: 'error', actionHref: '/tasks', actionLabel: '내 작업' }));
  }
  await exec(
    `UPDATE contributor_tasks
     SET assigned_to=:userId, status='assigned', updated_at=NOW()
     WHERE id=:taskId AND assigned_to IS NULL AND status='open'`,
    { taskId, userId: user.id }
  );
  return reply.redirect(`/tasks?claimed=${encodeURIComponent(String(taskId))}`);
});

app.post('/tasks/:id/complete', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  const taskId = nullablePositiveInt((request.params as any).id);
  if (!taskId) return reply.code(400).type('text/html').send(messagePage('작업 오류', '작업을 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/tasks', actionLabel: '내 작업' }));
  const task = await contributorTaskRow(taskId);
  if (!task) return reply.code(404).type('text/html').send(messagePage('작업 없음', '선택한 작업을 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/tasks', actionLabel: '내 작업' }));
  const canManage = await canManageContributorTasks(user);
  const visible = canManage ? [task] : await filterContributorTasksForActor(aclActorForRequest(request), [task]);
  if (!visible.length) return reply.code(403).type('text/html').send(messagePage('작업 접근 제한', '이 작업을 볼 권한이 없습니다.', user, { tone: 'error', actionHref: '/tasks', actionLabel: '내 작업' }));
  if (!canManage && Number(task.assigned_to ?? 0) !== Number(user.id)) {
    return reply.code(403).type('text/html').send(messagePage('작업 권한 없음', '내게 배정된 작업만 완료할 수 있습니다. 추천 작업은 먼저 맡아 주세요.', user, { tone: 'error', actionHref: '/tasks', actionLabel: '내 작업' }));
  }
  if (String(task.status ?? 'open') === 'done') return reply.redirect('/tasks?completed=1');
  await exec(
    `UPDATE contributor_tasks
     SET status='done', assigned_to=COALESCE(assigned_to, :userId), completed_at=NOW(), updated_at=NOW()
     WHERE id=:taskId AND status IN ('open','assigned')`,
    { taskId, userId: user.id }
  );
  await completeContributorTask(taskId, user.id);
  return reply.redirect(`/tasks?completed=${encodeURIComponent(String(taskId))}`);
});

app.get('/search', async (request, reply) => {
  const aclActor = aclActorForRequest(request);
  const searchQuery = request.query as any;
  const q = boundedText(searchQuery.q, 255);
  const space = String(searchQuery.space ?? '');
  const prefix = normalizeTitle(String(searchQuery.prefix ?? '')).replace(/^\/+|\/+$/g, '');
  const shouldResolve = q && !space && !prefix && String(searchQuery.noResolve ?? '') !== '1';
  if (shouldResolve) {
    const resolved = await resolveSearchQueryForActor(q, aclActor);
    if (resolved.action === 'redirect') return reply.redirect(resolved.target);
  }
  const rows = q ? await readableSearchRows(aclActor, await searchPages(q, 100)) : [];
  const filtered = rows.filter((row) => {
    if (space && !matchesSearchSpace(row, space)) return false;
    if (!prefix) return true;
    const title = normalizeTitle(row.title ?? '');
    const localPath = normalizeTitle(row.local_path ?? '');
    return title === prefix || title.startsWith(`${prefix}/`) || localPath === prefix || localPath.startsWith(`${prefix}/`);
  });
  const queryLogId = q ? await logSearchQuery(q, filtered.length, (request as any).user?.id ?? null) : null;
  return reply.type('text/html').send(searchPage(q, filtered, (request as any).user, space, prefix, rows, queryLogId));
});

app.get('/search/click', async (request, reply) => {
  const params = request.query as any;
  const queryText = boundedText(params.q, 255);
  const pageId = nullablePositiveInt(params.pageId);
  const rankNo = boundedPositiveInt(params.rank, 1000);
  const queryLogId = nullablePositiveInt(params.queryLogId);
  const to = String(params.to ?? '/');
  if (queryText && pageId && await canRecordSearchClick(pageId, aclActorForRequest(request))) {
    await recordSearchClick(queryText, pageId, rankNo, (request as any).user?.id ?? null, queryLogId);
  }
  return reply.redirect(safeLocalRedirect(to));
});

app.get('/category/*', async (request, reply) => {
  const aclActor = aclActorForRequest(request);
  const rawTitle = String((request.params as any)['*'] ?? '');
  const title = normalizeTitle(decodePathPart(rawTitle));
  const rows = title ? await pagesInCategory(title) : [];
  const visibleRows = [];
  for (const row of rows) {
    if (await canReadPageResource(aclActor, row)) visibleRows.push(row);
  }
  return reply.type('text/html').send(categoryPage(title || '분류', visibleRows, (request as any).user));
});

app.get('/file', async (request, reply) => reply.type('text/html').send(spaceHomePage('file', (request as any).user)));

app.get('/file/upload', async (request, reply) => {
  const user = (request as any).user;
  const canUpload = await canUploadFile(aclActorForRequest(request));
  return reply.type('text/html').send(fileUploadPage(user, canUpload));
});

app.get('/files/new', async (_request, reply) => reply.redirect('/file/upload'));

app.post('/file/upload', async (request, reply) => {
  const user = (request as any).user;
  const result = await uploadFileAction(request);
  if (!result.ok) {
    const canUpload = await canUploadFile(aclActorForRequest(request));
    return reply.code(result.status).type('text/html').send(fileUploadPage(user, canUpload, result.message));
  }
  return reply.redirect(wikiUrl('file', result.fileName));
});

app.get('/file/*', async (request, reply) => {
  const fileName = normalizeTitle(decodePathPart(String((request.params as any)['*'] ?? '')));
  const file = await fileDetail(fileName, aclActorForRequest(request));
  if (!file) return reply.code(404).type('text/html').send(messagePage('파일 없음', '파일을 찾을 수 없습니다.', (request as any).user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  return reply.type('text/html').send(fileDetailPage(file, (request as any).user));
});

app.post('/files/:id/report', async (request, reply) => {
  const user = (request as any).user;
  const result = await createFileReport(request, reply);
  if (!result) return reply;
  if (!result.ok) {
    return reply.code(result.status ?? 400).type('text/html').send(messagePage('파일 신고 오류', result.message ?? '파일 신고를 접수할 수 없습니다.', user, {
      tone: 'error',
      actionHref: '/wiki',
      actionLabel: '위키 대문'
    }));
  }
  return reply.type('text/html').send(messagePage('파일 신고 접수', '파일 검토 요청이 운영자 업무 큐에 등록되었습니다.', user, {
    actionHref: '/recent',
    actionLabel: '최근 바뀜',
    secondaryHref: '/wiki',
    secondaryLabel: '위키 대문'
  }));
});

app.get('/servers', async (request, reply) => {
  const aclActor = aclActorForRequest(request);
  const filters = request.query as Record<string, string>;
  const [wikiRows, serverRows] = await Promise.all([serverWikiCards(filters), serverList(filters)]);
  const [visibleWikiRows, visibleServerRows] = await Promise.all([
    withReadableDocCounts(aclActor, await filterRowsByReadablePage(aclActor, wikiRows)),
    filterRowsByReadablePage(aclActor, serverRows)
  ]);
  return reply.type('text/html').send(serverHubPage([...visibleWikiRows, ...visibleServerRows], filters, (request as any).user));
});
app.get('/servers/import', async (_request, reply) => reply.redirect('/servers/new?import=1'));
app.get('/servers/new', async (request, reply) => {
  const queryParams = request.query as Record<string, string>;
  const starterSets = await starterSetsForType('server_wiki');
  return reply.type('text/html').send(serverWikiRequestPage((request as any).user, queryParams.import === '1', queryParams, starterSets));
});
app.post('/servers/new', async (request, reply) => {
  const user = (request as any).user;
  const starterSets = await starterSetsForType('server_wiki');
  if (!user) return reply.code(403).type('text/html').send(serverWikiRequestPage(null, Boolean((request.body as any)?.needsImport), request.body as any, starterSets));
  const body = request.body as any;
  const title = normalizeTitle(String(body.title ?? '').trim());
  const slug = normalizeServerSubwikiSlug(body.slug ?? title);
  if (!title || !slug) return reply.code(400).type('text/html').send(serverWikiRequestPage(user, Boolean(body.needsImport), body, starterSets));
  const note = [
    `slug: ${slug}`,
    body.host ? `host: ${String(body.host).trim()}` : '',
    body.edition ? `edition: ${String(body.edition).trim()}` : '',
    body.supportedVersions ? `supportedVersions: ${String(body.supportedVersions).trim()}` : '',
    body.genres ? `genres: ${String(body.genres).trim()}` : '',
    body.starterSet ? `starterSet: ${String(body.starterSet).trim()}` : '',
    body.needsImport ? 'needsImport: true' : '',
    body.sourceNote ? `sourceNote: ${String(body.sourceNote).trim()}` : '',
    body.note ? `note: ${String(body.note).trim()}` : ''
  ].filter(Boolean).join('\n').slice(0, 4000);
  const result = await exec(
    `INSERT INTO subwiki_requests (request_type, title, requested_by, note, created_at, updated_at)
     VALUES ('server', :title, :userId, :note, NOW(), NOW())`,
    { title, userId: user.id, note }
  );
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
     VALUES ('subwiki_request', 'subwiki_request', :id, 'normal', NOW(), NOW())`,
    { id: result.insertId }
  );
  return reply.type('text/html').send(serverWikiRequestSubmittedPage(Number(result.insertId), user));
});

app.get('/wiki', async (_request, reply) => reply.redirect('/wiki/%EB%8C%80%EB%AC%B8'));
app.get('/mods', async (request, reply) => {
  const aclActor = aclActorForRequest(request);
  const filters = request.query as Record<string, string>;
  const rows = await withReadableDocCounts(aclActor, await filterRowsByReadablePage(aclActor, await modWikiCards(filters)));
  return reply.type('text/html').send(modIndexPage(rows, filters, (request as any).user));
});
app.get('/mods/new', async (request, reply) => {
  const starterSets = await starterSetsForType('mod_wiki');
  return reply.type('text/html').send(newModWikiPage((request as any).user, request.query as any, starterSets));
});
app.post('/mods/new', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).type('text/html').send(messagePage('로그인 필요', '모드 위키를 만들려면 로그인이 필요합니다.', user, { tone: 'error', actionHref: '/login', actionLabel: '로그인' }));
  try {
    const result = await createModSubwiki(request.body as any, user.id);
    return reply.redirect(`/mod/${encodeURIComponent(result.slug)}`);
  } catch {
    const starterSets = await starterSetsForType('mod_wiki');
    return reply.code(400).type('text/html').send(newModWikiPage(user, request.body as any, starterSets));
  }
});
app.get('/mod', async (_request, reply) => reply.redirect('/mods'));
app.get('/modpack', async (_request, reply) => reply.redirect('/mods'));
app.get('/server', async (request, reply) => {
  const query = request.url.includes('?') ? request.url.slice(request.url.indexOf('?')) : '';
  return reply.redirect(`/servers${query}`);
});
app.get('/my/servers', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  const rows = await myServerRows(user);
  return reply.type('text/html').send(myServersPage(rows, user));
});
app.get('/special/my-servers', async (_request, reply) => reply.redirect('/my/servers'));
app.get('/server/:slug/manage', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const space = await serverSubwikiSpace(slug);
  if (!space) return reply.code(404).type('text/html').send(messagePage('서버 위키 없음', '서버 공식 위키를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/servers', actionLabel: '서버 목록' }));
  if (!user) return reply.redirect(`/login?next=${encodeURIComponent(`/server/${slug}/manage`)}`);
  if (!(await canManageSubwiki(user, Number(space.id)))) return reply.code(403).type('text/html').send(messagePage('권한 없음', '서버 공식 문서 관리 권한이 필요합니다.', user, { tone: 'error', actionHref: `/server/${encodeURIComponent(slug)}`, actionLabel: '서버 위키' }));
  const [docs, sidebar, roles, jobs, settings, seasons, serverInfo, billing] = await Promise.all([
    query<any>(
      `SELECT p.id, p.title, p.updated_at, qs.status AS quality_status
       FROM pages p
       JOIN namespaces n ON n.id=p.namespace_id
       LEFT JOIN page_quality_status qs ON qs.page_id=p.id
       WHERE n.code='server' AND p.title LIKE :prefix AND p.status!='deleted'
       ORDER BY p.title`,
      { prefix: `${slug}/%` }
    ),
    query<any>(`SELECT id, parent_id, label, target_title, sort_order FROM subwiki_sidebar_items WHERE space_id=:spaceId ORDER BY sort_order, id`, { spaceId: space.id }),
    query<any>(
      `SELECT sr.id, sr.role, sr.status, u.display_name, u.username
       FROM subwiki_roles sr JOIN users u ON u.id=sr.user_id
       WHERE sr.space_id=:spaceId ORDER BY FIELD(sr.role,'owner','manager','editor','reviewer'), u.display_name`,
      { spaceId: space.id }
    ),
    query<any>(`SELECT id, source_type, status, source_note, created_at FROM gitbook_import_jobs WHERE space_id=:spaceId ORDER BY id DESC LIMIT 10`, { spaceId: space.id }),
    one<any>(`SELECT custom_domain, short_path, allow_public_edit, public_edit_enabled, require_review, review_required FROM subwiki_settings WHERE space_id=:spaceId`, { spaceId: space.id }),
    query<any>(`SELECT ${serverSeasonFields} FROM server_seasons WHERE space_id=:spaceId ORDER BY FIELD(status,'active','planned','archived'), starts_at DESC, id DESC`, { spaceId: space.id }),
    one<any>(`SELECT ${entityServerFields} FROM entity_servers WHERE page_id=:pageId`, { pageId: space.root_page_id }),
    serverBillingContext(Number(space.id))
  ]);
  return reply.type('text/html').send(serverOperatorDashboardPage(space, docs, sidebar, roles, jobs, settings, seasons, serverInfo, user, billing));
});
app.post('/server/:slug/manage/documents', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키를 관리할 권한이 없습니다.', `/server/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const docTitle = normalizeTitle(String(body.title ?? '').trim());
  if (!docTitle) return subwikiManageError(reply, user, 400, '문서 제목을 입력하세요.', manageHref);
  const template = normalizeServerDocumentTemplate(body.template);
  const pageTitle = `${slug}/${docTitle.replace(/^\/+/, '')}`;
  const page = appliedPage(await savePage({
    namespace: 'server',
    title: pageTitle,
    content: serverDocTemplate(space.title ?? slug, docTitle, template),
    summary: '서버 운영자 대시보드 문서 생성',
    userId: user?.id ?? null,
    pageType: 'server'
  }));
  const parentId = await sidebarParentIdFromBody(Number(space.id), body.parentId, 0, manageHref, user, reply);
  if (parentId === false) return;
  await upsertSidebarItem(Number(space.id), page.pageId, docTitle, pageTitle, await nextSidebarSort(Number(space.id)), parentId);
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/easy-edit', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키를 관리할 권한이 없습니다.', `/server/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const doc = serverEasyEditDocument(space.title ?? slug, normalizeServerEasyEditDocType(body.docType), body);
  if (!doc) return subwikiManageError(reply, user, 400, '지원하지 않는 쉬운 편집 문서 유형입니다.', manageHref);
  const pageTitle = `${slug}/${doc.title}`;
  const page = appliedPage(await savePage({
    namespace: 'server',
    title: pageTitle,
    content: doc.content,
    summary: `서버 운영자 쉬운 편집: ${doc.title}`,
    userId: user?.id ?? null,
    pageType: 'server'
  }));
  await upsertSidebarItem(Number(space.id), page.pageId, doc.title, pageTitle, await nextSidebarSort(Number(space.id)));
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/status', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키를 관리할 권한이 없습니다.', `/server/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const operationalStatus = normalizeServerOperationalStatus(body.operationalStatus);
  if (body.operationalStatus && !operationalStatus) return subwikiManageError(reply, user, 400, '서버 운영 상태 값이 올바르지 않습니다.', manageHref);
  const edition = ['java', 'bedrock', 'crossplay', 'unknown'].includes(String(body.edition ?? '')) ? String(body.edition) : 'unknown';
  const host = normalizeServerHost(body.host);
  if (body.host && !host) return subwikiManageError(reply, user, 400, '서버 주소 형식이 올바르지 않습니다.', manageHref);
  const port = normalizeServerPort(body.port ?? body.host);
  if ((body.port || body.host) && port === null) return subwikiManageError(reply, user, 400, '서버 포트 형식이 올바르지 않습니다.', manageHref);
  await exec(
    `UPDATE entity_servers
     SET host=COALESCE(:host, host),
         edition=:edition,
         supported_versions=COALESCE(:supportedVersions, supported_versions),
         genres=COALESCE(:genres, genres),
         operational_status=COALESCE(:operationalStatus, operational_status),
         status_enabled=:statusEnabled,
         updated_at=NOW()
     WHERE page_id=:pageId`,
    {
      pageId: Number(space.root_page_id),
      host,
      edition,
      supportedVersions: boundedOptionalText(body.supportedVersions, 255),
      genres: boundedOptionalText(body.genres, 255),
      operationalStatus,
      statusEnabled: body.statusEnabled ? 1 : 0
    }
  );
  await exec(
    `UPDATE server_wikis
     SET host=COALESCE(:host, host), port=COALESCE(:port, port), edition=:edition, supported_versions=COALESCE(:supportedVersions, supported_versions), genres=COALESCE(:genres, genres), updated_at=NOW()
     WHERE space_id=:spaceId`,
    {
      spaceId: space.id,
      host,
      port,
      edition,
      supportedVersions: boundedOptionalText(body.supportedVersions, 255),
      genres: boundedOptionalText(body.genres, 255)
    }
  );
  await syncServerEndpointFromEntity(Number(space.root_page_id));
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/sidebar', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키를 관리할 권한이 없습니다.', `/server/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const itemId = nullablePositiveInt(body.itemId);
  if (!itemId) return subwikiManageError(reply, user, 400, '사이드바 항목을 찾을 수 없습니다.', manageHref);
  const label = boundedText(body.label, 255) || null;
  const parentId = await sidebarParentIdFromBody(Number(space.id), body.parentId, itemId, manageHref, user, reply);
  if (parentId === false) return;
  const sortOrder = body.sortOrder === undefined || body.sortOrder === '' ? null : boundedUnsignedInt(body.sortOrder, 1_000_000);
  if (body.sortOrder !== undefined && body.sortOrder !== '' && sortOrder === null) return subwikiManageError(reply, user, 400, '사이드바 정렬 순서는 0 이상의 숫자여야 합니다.', manageHref);
  await exec(
    `UPDATE subwiki_sidebar_items SET label=COALESCE(:label,label), parent_id=:parentId, sort_order=COALESCE(:sortOrder,sort_order), updated_at=NOW()
     WHERE id=:id AND space_id=:spaceId`,
    { id: itemId, spaceId: space.id, label, parentId, sortOrder }
  );
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/settings', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키를 관리할 권한이 없습니다.', `/server/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const shortPath = normalizeShortPath(body.shortPath);
  if (body.shortPath && shortPath === null) return subwikiManageError(reply, user, 400, '짧은 주소는 /server/... 형식으로 입력하세요.', manageHref);
  await exec(
    `UPDATE subwiki_settings
     SET short_path=:shortPath,
         allow_public_edit=:allowPublicEdit,
         public_edit_enabled=:allowPublicEdit,
         require_review=:requireReview,
         review_required=:requireReview,
         updated_at=NOW()
     WHERE space_id=:spaceId`,
    {
      spaceId: space.id,
      shortPath: shortPath ?? `/server/${slug}`,
      allowPublicEdit: body.allowPublicEdit ? 1 : 0,
      requireReview: body.requireReview ? 1 : 0
    }
  );
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/custom-domain', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키 소유자 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`);
  if (!(await serverFeature(Number(space.id), 'customDomain'))) return subwikiManageError(reply, user, 402, 'Pro 이상에서 커스텀 도메인을 사용할 수 있습니다.', manageHref);
  const serverWikiId = await serverWikiIdForSpace(Number(space.id));
  if (!serverWikiId) return subwikiManageError(reply, user, 404, '서버 위키 프로필을 찾을 수 없습니다.', manageHref);
  const domain = normalizeCustomDomain((request.body as any).domain);
  if (!domain) return subwikiManageError(reply, user, 400, '커스텀 도메인 형식이 올바르지 않습니다.', manageHref);
  const appHost = normalizeHttpHost(new URL(config.baseUrl).host);
  if (appHost && domain === appHost) return subwikiManageError(reply, user, 400, 'MineWiki 기본 도메인은 커스텀 도메인으로 사용할 수 없습니다.', manageHref);
  const token = crypto.randomBytes(16).toString('hex');
  const value = `minewiki-domain=${serverWikiId}.${token}`;
  await exec(
    `INSERT INTO server_custom_domains (server_wiki_id, domain, status, verification_token_hash, dns_record_name, dns_record_value, ssl_status, created_by, created_at, updated_at)
     VALUES (:serverWikiId, :domain, 'pending', :tokenHash, :recordName, :recordValue, 'none', :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE server_wiki_id=VALUES(server_wiki_id), status='pending', verification_token_hash=VALUES(verification_token_hash), dns_record_name=VALUES(dns_record_name), dns_record_value=VALUES(dns_record_value), created_by=VALUES(created_by), updated_at=NOW()`,
    {
      serverWikiId,
      domain,
      tokenHash: hashContent(value),
      recordName: `_minewiki.${domain}`,
      recordValue: value,
      userId: user.id
    }
  );
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/custom-domain/:domainId/verify', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키 소유자 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`);
  const serverWikiId = await serverWikiIdForSpace(Number(space.id));
  const domainId = nullablePositiveInt((request.params as any).domainId);
  if (!domainId) return subwikiManageError(reply, user, 400, '도메인 항목을 찾을 수 없습니다.', manageHref);
  const domain = await one<any>(`SELECT ${customDomainFields} FROM server_custom_domains WHERE id=:id AND server_wiki_id=:serverWikiId`, {
    id: domainId,
    serverWikiId
  });
  if (!domain) return subwikiManageError(reply, user, 404, '등록된 도메인을 찾을 수 없습니다.', manageHref);
  const records = await dns.resolveTxt(domain.dns_record_name).catch(() => []);
  const found = records.map((record) => record.join(''));
  const ok = found.includes(String(domain.dns_record_value));
  await exec(
    `UPDATE server_custom_domains
     SET status=:status, verified_at=IF(:ok=1, NOW(), verified_at), updated_at=NOW()
     WHERE id=:id`,
    { id: domain.id, status: ok ? 'verified' : 'failed', ok: ok ? 1 : 0 }
  );
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/custom-domain/:domainId/activate', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키 소유자 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`);
  const serverWikiId = await serverWikiIdForSpace(Number(space.id));
  const domainId = nullablePositiveInt((request.params as any).domainId);
  if (!domainId) return subwikiManageError(reply, user, 400, '도메인 항목을 찾을 수 없습니다.', manageHref);
  const domain = await one<any>(`SELECT ${customDomainFields} FROM server_custom_domains WHERE id=:id AND server_wiki_id=:serverWikiId AND status IN ('verified','active')`, {
    id: domainId,
    serverWikiId
  });
  if (!domain) return subwikiManageError(reply, user, 404, '인증된 도메인을 찾을 수 없습니다.', manageHref);
  await exec(`UPDATE server_custom_domains SET status='verified', updated_at=NOW() WHERE server_wiki_id=:serverWikiId AND status='active'`, { serverWikiId });
  await exec(`UPDATE server_custom_domains SET status='active', ssl_status='pending', activated_at=NOW(), updated_at=NOW() WHERE id=:id`, { id: domain.id });
  await exec(`UPDATE subwiki_settings SET custom_domain=:domain, updated_at=NOW() WHERE space_id=:spaceId`, { domain: domain.domain, spaceId: space.id });
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/custom-domain/:domainId/disable', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키 소유자 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`);
  const serverWikiId = await serverWikiIdForSpace(Number(space.id));
  const domainId = nullablePositiveInt((request.params as any).domainId);
  if (!domainId) return subwikiManageError(reply, user, 400, '도메인 항목을 찾을 수 없습니다.', manageHref);
  const domain = await one<any>(`SELECT ${customDomainFields} FROM server_custom_domains WHERE id=:id AND server_wiki_id=:serverWikiId`, {
    id: domainId,
    serverWikiId
  });
  if (!domain) return subwikiManageError(reply, user, 404, '등록된 도메인을 찾을 수 없습니다.', manageHref);
  await exec(`UPDATE server_custom_domains SET status='disabled', updated_at=NOW() WHERE id=:id`, { id: domain.id });
  await exec(`UPDATE subwiki_settings SET custom_domain=NULL, updated_at=NOW() WHERE space_id=:spaceId AND custom_domain=:domain`, { spaceId: space.id, domain: domain.domain });
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/theme', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키를 관리할 권한이 없습니다.', `/server/${encodeURIComponent(slug)}`);
  if (!(await serverFeature(Number(space.id), 'themeTokens'))) return subwikiManageError(reply, user, 402, 'Plus 이상에서 서버 테마를 사용할 수 있습니다.', manageHref);
  const serverWikiId = await serverWikiIdForSpace(Number(space.id));
  if (!serverWikiId) return subwikiManageError(reply, user, 404, '서버 위키 프로필을 찾을 수 없습니다.', manageHref);
  const body = request.body as any;
  const primaryColor = normalizeCssColor(body.primaryColor);
  const accentColor = normalizeCssColor(body.accentColor);
  const themeKey = normalizeThemeKey(body.themeKey);
  const backgroundMode = normalizeThemeBackgroundMode(body.backgroundMode);
  const requestedBranding = String(body.brandingMode ?? 'minewiki');
  const brandingMode = requestedBranding === 'white_label' && (await serverFeature(Number(space.id), 'whiteLabel')) ? 'white_label' : requestedBranding === 'compact' ? 'compact' : 'minewiki';
  await exec(
    `INSERT INTO server_theme_settings (server_wiki_id, theme_key, primary_color, accent_color, background_mode, branding_mode, updated_by, created_at, updated_at)
     VALUES (:serverWikiId, :themeKey, :primaryColor, :accentColor, :backgroundMode, :brandingMode, :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE theme_key=VALUES(theme_key), primary_color=VALUES(primary_color), accent_color=VALUES(accent_color), background_mode=VALUES(background_mode), branding_mode=VALUES(branding_mode), updated_by=VALUES(updated_by), updated_at=NOW()`,
    { serverWikiId, themeKey, primaryColor, accentColor, backgroundMode, brandingMode, userId: user.id }
  );
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/theme/css', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키 소유자 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`);
  if (!(await serverFeature(Number(space.id), 'customCss'))) return subwikiManageError(reply, user, 402, 'Business 이상에서 제한 CSS를 사용할 수 있습니다.', manageHref);
  const serverWikiId = await serverWikiIdForSpace(Number(space.id));
  if (!serverWikiId) return subwikiManageError(reply, user, 404, '서버 위키 프로필을 찾을 수 없습니다.', manageHref);
  const css = sanitizeServerCustomCss((request.body as any).customCss);
  if (css === null) return subwikiManageError(reply, user, 400, '허용되지 않는 CSS가 포함되어 있습니다.', manageHref);
  await exec(
    `INSERT INTO server_theme_settings (server_wiki_id, custom_css, custom_css_status, updated_by, created_at, updated_at)
     VALUES (:serverWikiId, :css, 'pending', :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE custom_css=VALUES(custom_css), custom_css_status='pending', updated_by=VALUES(updated_by), updated_at=NOW()`,
    { serverWikiId, css, userId: user.id }
  );
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/subscription', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  if (!can(user, 'report.handle')) return subwikiManageError(reply, user, 403, '관리 권한이 필요합니다.', manageHref);
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  const serverWikiId = await serverWikiIdForSpace(Number(space.id));
  const plan = await one<any>(`SELECT id FROM billing_plans WHERE plan_key=:planKey AND status='active'`, { planKey: String((request.body as any).planKey ?? 'free') });
  if (!serverWikiId || !plan) return subwikiManageError(reply, user, 404, '구독 플랜을 찾을 수 없습니다.', manageHref);
  await exec(`UPDATE server_subscriptions SET status='cancelled', cancelled_at=NOW(), updated_at=NOW() WHERE server_wiki_id=:serverWikiId AND status IN ('trialing','active','past_due')`, {
    serverWikiId
  });
  if (String((request.body as any).planKey ?? 'free') !== 'free') {
    await exec(
      `INSERT INTO server_subscriptions (server_wiki_id, plan_id, status, started_at, renews_at, created_by, created_at, updated_at)
       VALUES (:serverWikiId, :planId, 'active', NOW(), DATE_ADD(NOW(), INTERVAL 1 MONTH), :userId, NOW(), NOW())`,
      { serverWikiId, planId: plan.id, userId: user.id }
    );
  }
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/permissions', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키 소유자 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const level = normalizePageProtectionLevel(body.protectionLevel) ?? 'owner_only';
  if (['trusted_only', 'admin_only', 'locked'].includes(level) && !(await serverFeature(Number(space.id), 'accessControl'))) {
    return subwikiManageError(reply, user, 402, 'Pro 이상에서 고급 접근 제어를 사용할 수 있습니다.', manageHref);
  }
  const reason = boundedText(body.reason, 500);
  const rootOnly = !body.applyAll;
  await exec(
    `UPDATE pages p
     JOIN namespaces n ON n.id=p.namespace_id
     SET p.protection_level=:level,
         p.status=CASE WHEN :level='open' THEN 'normal' ELSE 'protected' END,
         p.updated_at=NOW()
     WHERE n.code='server'
       AND p.status!='deleted'
       AND (p.title=:rootTitle OR (:rootOnly=0 AND p.title LIKE :prefix))`,
    {
      level,
      rootTitle: slug,
      rootOnly: rootOnly ? 1 : 0,
      prefix: `${slug}/%`
    }
  );
  await logAdmin(user?.id ?? null, 'server.permissions', 'server_subwiki', Number(space.id), {
    slug,
    level,
    scope: rootOnly ? 'root' : 'all',
    reason
  });
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/roles', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키 소유자 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const target = await userByIdentifier(body.username);
  if (!target) return subwikiManageError(reply, user, 404, '사용자를 찾을 수 없습니다.', manageHref);
  const [limit, currentOwners] = await Promise.all([
    serverOperatorLimit(Number(space.id)),
    one<any>(`SELECT COUNT(*) AS count FROM server_owners WHERE page_id=:pageId AND status='active'`, { pageId: Number(space.root_page_id) })
  ]);
  if (Number(currentOwners?.count ?? 0) >= limit) return subwikiManageError(reply, user, 402, `현재 플랜의 운영자 한도는 ${limit}명입니다.`, manageHref);
  const role = normalizeSubwikiRole(body.role) ?? 'editor';
  const serverOwnerRole = role === 'owner' || role === 'manager' ? role : 'editor';
  await grantServerOwner(Number(space.root_page_id), Number(target.id), serverOwnerRole, 'active', user?.id ?? null);
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/roles/:roleId/revoke', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키 소유자 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`);
  const roleId = nullablePositiveInt((request.params as any).roleId);
  if (!roleId) return subwikiManageError(reply, user, 400, '운영자 항목을 찾을 수 없습니다.', manageHref);
  const role = await one<any>(`SELECT ${subwikiRoleBackupFields} FROM subwiki_roles WHERE id=:id AND space_id=:spaceId`, {
    id: roleId,
    spaceId: space.id
  });
  if (!role) return subwikiManageError(reply, user, 404, '운영자 권한을 찾을 수 없습니다.', manageHref);
  await exec(`UPDATE subwiki_roles SET status='revoked', revoked_at=NOW(), revoked_by=:actorId WHERE id=:id`, {
    id: role.id,
    actorId: user?.id ?? null
  });
  await exec(`UPDATE server_owners SET status='revoked', revoked_at=NOW(), revoked_by=:actorId WHERE page_id=:pageId AND user_id=:userId`, {
    pageId: space.root_page_id,
    userId: role.user_id,
    actorId: user?.id ?? null
  });
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.post('/server/:slug/manage/seasons', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키를 관리할 권한이 없습니다.', `/server/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const title = normalizeTitle(String(body.title ?? '').trim());
  if (!title) return subwikiManageError(reply, user, 400, '시즌 문서 제목을 입력하세요.', manageHref);
  const status = normalizeServerSeasonStatus(body.status) ?? 'planned';
  const seasonKey = title.replace(/\s+/g, '_').replace(/[^\w가-힣._-]/g, '').slice(0, 128) || `season-${Date.now()}`;
  const pageTitle = `${slug}/${title}`;
  const summary = boundedText(body.summary, 5000);
  const page = appliedPage(await savePage({
    namespace: 'server',
    title: pageTitle,
    content: serverSeasonTemplate(space.title ?? slug, title, summary, status),
    summary: '서버 시즌 문서 생성',
    userId: user?.id ?? null,
    pageType: 'server'
  }));
  await exec(
    `INSERT INTO server_seasons (space_id, season_key, title, status, starts_at, ends_at, summary, page_id, created_by, created_at, updated_at)
     VALUES (:spaceId, :seasonKey, :title, :status, :startsAt, :endsAt, :summary, :pageId, :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE title=VALUES(title), status=VALUES(status), starts_at=VALUES(starts_at), ends_at=VALUES(ends_at),
       summary=VALUES(summary), page_id=VALUES(page_id), updated_at=NOW()`,
    {
      spaceId: space.id,
      seasonKey,
      title,
      status,
      startsAt: normalizeDateInput(body.startsAt),
      endsAt: normalizeDateInput(body.endsAt),
      summary: summary || null,
      pageId: page.pageId,
      userId: user?.id ?? null
    }
  );
  await upsertSidebarItem(Number(space.id), page.pageId, title, pageTitle, await nextSidebarSort(Number(space.id)));
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});
app.get('/server/:slug/export', async (request, reply) => {
  return sendServerSubwikiExport(request, reply, String((request.params as any).slug ?? ''), true);
});
app.get('/mod/:slug/manage', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const space = await modSubwikiSpace(slug);
  if (!space) return reply.code(404).type('text/html').send(messagePage('모드 위키 없음', '모드 위키를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/mods', actionLabel: '모드 목록' }));
  if (!user) return reply.redirect(`/login?next=${encodeURIComponent(`/mod/${slug}/manage`)}`);
  if (!(await canManageSubwiki(user, Number(space.id)))) return reply.code(403).type('text/html').send(messagePage('권한 없음', '모드 위키 관리 권한이 필요합니다.', user, { tone: 'error', actionHref: `/mod/${encodeURIComponent(slug)}`, actionLabel: '모드 위키' }));
  const [docs, sidebar, roles, settings, modInfo] = await Promise.all([
    query<any>(
      `SELECT p.id, p.title, p.updated_at, qs.status AS quality_status
       FROM pages p
       JOIN namespaces n ON n.id=p.namespace_id
       LEFT JOIN page_quality_status qs ON qs.page_id=p.id
       WHERE n.code='mod' AND p.title LIKE :prefix AND p.status!='deleted'
       ORDER BY p.local_path='대문' DESC, p.local_path, p.title`,
      { prefix: `${slug}/%` }
    ),
    query<any>(`SELECT id, parent_id, label, target_title, sort_order FROM subwiki_sidebar_items WHERE space_id=:spaceId ORDER BY sort_order, id`, { spaceId: space.id }),
    query<any>(
      `SELECT sr.id, sr.role, sr.status, u.display_name, u.username
       FROM subwiki_roles sr JOIN users u ON u.id=sr.user_id
       WHERE sr.space_id=:spaceId ORDER BY FIELD(sr.role,'owner','manager','editor','reviewer'), u.display_name`,
      { spaceId: space.id }
    ),
    one<any>(`SELECT custom_domain, short_path, allow_public_edit, public_edit_enabled, require_review, review_required FROM subwiki_settings WHERE space_id=:spaceId`, { spaceId: space.id }),
    one<any>(`SELECT ${modWikiFields} FROM mod_wikis WHERE space_id=:spaceId`, { spaceId: space.id })
  ]);
  return reply.type('text/html').send(modOperatorDashboardPage(space, docs, sidebar, roles, settings, modInfo, user));
});
app.post('/mod/:slug/manage/documents', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/mod/${encodeURIComponent(slug)}/manage`;
  const space = await modSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '모드 위키를 찾을 수 없습니다.', '/mods');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '모드 위키를 관리할 권한이 없습니다.', `/mod/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const docTitle = normalizeTitle(String(body.title ?? '').trim());
  if (!docTitle) return subwikiManageError(reply, user, 400, '문서 제목을 입력하세요.', manageHref);
  const parentId = await sidebarParentIdFromBody(Number(space.id), body.parentId, 0, manageHref, user, reply);
  if (parentId === false) return;
  const template = normalizeModDocumentTemplate(body.template);
  const pageTitle = `${slug}/${docTitle.replace(/^\/+/, '')}`;
  const page = appliedPage(await savePage({
    namespace: 'mod',
    title: pageTitle,
    content: modWikiDocTemplate(space.title ?? slug, docTitle, template),
    summary: '모드 위키 대시보드 문서 생성',
    userId: user?.id ?? null,
    pageType: 'mod'
  }));
  await upsertSidebarItem(Number(space.id), page.pageId, docTitle, pageTitle, await nextSidebarSort(Number(space.id)), parentId);
  return reply.redirect(`/mod/${encodeURIComponent(slug)}/manage`);
});
app.post('/mod/:slug/manage/sidebar', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/mod/${encodeURIComponent(slug)}/manage`;
  const space = await modSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '모드 위키를 찾을 수 없습니다.', '/mods');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '모드 위키를 관리할 권한이 없습니다.', `/mod/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const itemId = nullablePositiveInt(body.itemId);
  if (!itemId) return subwikiManageError(reply, user, 400, '사이드바 항목을 찾을 수 없습니다.', manageHref);
  const label = boundedText(body.label, 255) || null;
  const parentId = await sidebarParentIdFromBody(Number(space.id), body.parentId, itemId, manageHref, user, reply);
  if (parentId === false) return;
  const sortOrder = body.sortOrder === undefined || body.sortOrder === '' ? null : boundedUnsignedInt(body.sortOrder, 1_000_000);
  if (body.sortOrder !== undefined && body.sortOrder !== '' && sortOrder === null) return subwikiManageError(reply, user, 400, '사이드바 정렬 순서는 0 이상의 숫자여야 합니다.', manageHref);
  await exec(
    `UPDATE subwiki_sidebar_items SET label=COALESCE(:label,label), parent_id=:parentId, sort_order=COALESCE(:sortOrder,sort_order), updated_at=NOW()
     WHERE id=:id AND space_id=:spaceId`,
    { id: itemId, spaceId: space.id, label, parentId, sortOrder }
  );
  return reply.redirect(`/mod/${encodeURIComponent(slug)}/manage`);
});
app.post('/mod/:slug/manage/settings', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const space = await modSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '모드 위키를 찾을 수 없습니다.', '/mods');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '모드 위키를 관리할 권한이 없습니다.', `/mod/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  await exec(
    `UPDATE mod_wikis
     SET category=COALESCE(:category, category),
         loaders=COALESCE(:loaders, loaders),
         supported_versions=COALESCE(:supportedVersions, supported_versions),
         official_url=COALESCE(:officialUrl, official_url),
         source_url=COALESCE(:sourceUrl, source_url),
         license=COALESCE(:license, license),
         updated_at=NOW()
     WHERE space_id=:spaceId`,
    {
      spaceId: space.id,
      category: boundedOptionalText(body.category, 128),
      loaders: boundedOptionalText(body.loaders, 255),
      supportedVersions: boundedOptionalText(body.supportedVersions, 5000),
      officialUrl: normalizeOptionalHttpUrl(body.officialUrl),
      sourceUrl: normalizeOptionalHttpUrl(body.sourceUrl),
      license: boundedOptionalText(body.license, 128)
    }
  );
  await exec(
    `UPDATE subwiki_settings
     SET allow_public_edit=:allowPublicEdit,
         public_edit_enabled=:allowPublicEdit,
         require_review=:requireReview,
         review_required=:requireReview,
         updated_at=NOW()
     WHERE space_id=:spaceId`,
    { spaceId: space.id, allowPublicEdit: body.allowPublicEdit ? 1 : 0, requireReview: body.requireReview ? 1 : 0 }
  );
  return reply.redirect(`/mod/${encodeURIComponent(slug)}/manage`);
});
app.post('/mod/:slug/manage/roles', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/mod/${encodeURIComponent(slug)}/manage`;
  const space = await modSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '모드 위키를 찾을 수 없습니다.', '/mods');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '모드 위키 소유자 권한이 필요합니다.', `/mod/${encodeURIComponent(slug)}`);
  const body = request.body as any;
  const target = await userByIdentifier(body.username);
  if (!target) return subwikiManageError(reply, user, 404, '사용자를 찾을 수 없습니다.', manageHref);
  const role = normalizeSubwikiRole(body.role) ?? 'editor';
  await exec(
    `INSERT INTO subwiki_roles (space_id, user_id, role, status, granted_by, granted_at)
     VALUES (:spaceId, :userId, :role, 'active', :actorId, NOW())
     ON DUPLICATE KEY UPDATE status='active', revoked_at=NULL, revoked_by=NULL, granted_by=VALUES(granted_by), granted_at=VALUES(granted_at)`,
    { spaceId: space.id, userId: target.id, role, actorId: user?.id ?? null }
  );
  return reply.redirect(manageHref);
});
app.post('/mod/:slug/manage/roles/:roleId/revoke', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/mod/${encodeURIComponent(slug)}/manage`;
  const space = await modSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '모드 위키를 찾을 수 없습니다.', '/mods');
  if (!(await canOwnSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '모드 위키 소유자 권한이 필요합니다.', `/mod/${encodeURIComponent(slug)}`);
  const roleId = nullablePositiveInt((request.params as any).roleId);
  if (!roleId) return subwikiManageError(reply, user, 400, '역할 항목을 찾을 수 없습니다.', manageHref);
  const role = await one<any>(`SELECT id FROM subwiki_roles WHERE id=:id AND space_id=:spaceId`, { id: roleId, spaceId: space.id });
  if (!role) return subwikiManageError(reply, user, 404, '역할 항목을 찾을 수 없습니다.', manageHref);
  await exec(`UPDATE subwiki_roles SET status='revoked', revoked_at=NOW(), revoked_by=:actorId WHERE id=:id`, {
    id: role.id,
    actorId: user?.id ?? null
  });
  return reply.redirect(manageHref);
});
app.get('/dev', async (request, reply) => {
  const aclActor = aclActorForRequest(request);
  const rows = await query<any>(
    `SELECT p.id, p.space_id, p.protection_level, p.status, n.code AS namespace_code, p.title
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE n.code='dev' AND p.status NOT IN ('deleted','hidden')
     ORDER BY p.title LIMIT 120`
  );
  const groups: Record<string, any[]> = { Protocol: [], 'Plugin API': [], 'Mod API': [], Data: [], Tools: [] };
  for (const row of await filterRowsByReadablePage(aclActor, rows)) {
    const title = String(row.title);
    const key = title.includes('Protocol') || title.includes('Packet') || title.includes('VarInt')
      ? 'Protocol'
      : title.includes('Paper') || title.includes('Bukkit') || title.includes('Spigot') || title.includes('Velocity') || title.includes('Plugin') || title.includes('Command') || title.includes('Event') || title.includes('Scheduler')
        ? 'Plugin API'
        : title.includes('Fabric') || title.includes('Forge') || title.includes('NeoForge') || title.includes('Mod API') || title.includes('Mixin')
          ? 'Mod API'
          : title.includes('NBT') || title.includes('Data') || title.includes('Resource') || title.includes('Registry') || title.includes('Pack') || title.includes('Loot')
            ? 'Data'
            : 'Tools';
    groups[key].push(row);
  }
  return reply.type('text/html').send(developHubPage(groups, (request as any).user));
});
app.get('/templates/new', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).type('text/html').send(messagePage('로그인 필요', '문서 양식을 만들려면 로그인해야 합니다.', user, { tone: 'error', ...accessActionOptions(request, user), currentSpace: 'template' }));
  const space = String((request.query as any).space ?? '');
  const kind = space === 'dev' ? 'dev' : 'global';
  return reply.type('text/html').send(documentTemplateFormPage(user, { kind }, request.query as any));
});
app.post('/templates/new', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return htmlError(reply, user, 403, '로그인 필요', '템플릿을 만들려면 로그인해야 합니다.', '/login', '로그인');
  const body = request.body as any;
  await createDocumentTemplate(null, body, user.id, can(user, 'report.handle') ? 'global' : 'user');
  return reply.redirect('/new?templateSaved=1');
});
app.get('/mod/:slug/templates/new', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).type('text/html').send(messagePage('로그인 필요', '문서 양식을 만들려면 로그인해야 합니다.', user, { tone: 'error', ...accessActionOptions(request, user), currentSpace: 'mod' }));
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? '')));
  const space = await modSubwikiSpace(slug);
  if (!space) return reply.code(404).type('text/html').send(messagePage('모드 위키 없음', '모드 위키를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/mods', actionLabel: '모드 목록' }));
  return reply.type('text/html').send(documentTemplateFormPage(user, { kind: 'mod', slug, spaceTitle: space.title ?? space.name }, request.query as any));
});
app.post('/mod/:slug/templates/new', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return htmlError(reply, user, 403, '로그인 필요', '템플릿을 만들려면 로그인해야 합니다.', '/login', '로그인');
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? '')));
  const space = await modSubwikiSpace(slug);
  if (!space) return htmlError(reply, user, 404, '모드 위키 없음', '모드 위키를 찾을 수 없습니다.', '/mods', '모드 목록');
  const manager = await canManageSubwiki(user, Number(space.id));
  await createDocumentTemplate(Number(space.id), request.body as any, user.id, manager ? 'space' : 'user');
  return reply.redirect(`/mod/${encodeURIComponent(slug)}/new?templateSaved=1`);
});
app.get('/server/:slug/templates/new', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).type('text/html').send(messagePage('로그인 필요', '문서 양식을 만들려면 로그인해야 합니다.', user, { tone: 'error', ...accessActionOptions(request, user), currentSpace: 'server' }));
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? '')));
  const space = await serverSubwikiSpace(slug);
  if (!space) return reply.code(404).type('text/html').send(messagePage('서버 위키 없음', '서버 공식 위키를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/servers', actionLabel: '서버 목록' }));
  return reply.type('text/html').send(documentTemplateFormPage(user, { kind: 'server', slug, spaceTitle: space.title ?? space.name }, request.query as any));
});
app.post('/server/:slug/templates/new', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return htmlError(reply, user, 403, '로그인 필요', '템플릿을 만들려면 로그인해야 합니다.', '/login', '로그인');
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? '')));
  const space = await serverSubwikiSpace(slug);
  if (!space) return htmlError(reply, user, 404, '서버 위키 없음', '서버 공식 위키를 찾을 수 없습니다.', '/servers', '서버 목록');
  const manager = await canManageSubwiki(user, Number(space.id));
  await createDocumentTemplate(Number(space.id), request.body as any, user.id, manager ? 'space' : 'user');
  return reply.redirect(`/server/${encodeURIComponent(slug)}/new?templateSaved=1`);
});
app.get('/mod/:slug/new', async (request, reply) => {
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? '')));
  const space = await modSubwikiSpace(slug);
  const templates = await documentTemplatesForSpace(space?.id ? Number(space.id) : null, 'mod_wiki');
  return reply.type('text/html').send(newSubwikiDocumentPage('mod', slug, (request as any).user, request.query as any, templates, Boolean(space)));
});
app.post('/mod/:slug/new', async (request, reply) => {
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? ''))).replace(/^\/+|\/+$/g, '');
  const title = normalizeTitle(String((request.body as any).title ?? '')).replace(/^\/+|\/+$/g, '');
  if (!slug || !title) return htmlError(reply, (request as any).user, 400, '입력 오류', '문서 제목을 입력하세요.', `/mod/${encodeURIComponent(slug)}/new`, '모드 문서 만들기');
  const template = String((request.body as any).template ?? '').trim();
  return reply.redirect(`${wikiUrl('mod', `${slug}/${title}`)}/edit${template ? `?template=${encodeURIComponent(template)}` : '?blank=1'}`);
});
app.get('/server/:slug/new', async (request, reply) => {
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? '')));
  const space = await serverSubwikiSpace(slug);
  const templates = await documentTemplatesForSpace(space?.id ? Number(space.id) : null, 'server_wiki');
  return reply.type('text/html').send(newSubwikiDocumentPage('server', slug, (request as any).user, request.query as any, templates, Boolean(space)));
});
app.post('/server/:slug/new', async (request, reply) => {
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? ''))).replace(/^\/+|\/+$/g, '');
  const title = normalizeTitle(String((request.body as any).title ?? '')).replace(/^\/+|\/+$/g, '');
  if (!slug || !title) return htmlError(reply, (request as any).user, 400, '입력 오류', '문서 제목을 입력하세요.', `/server/${encodeURIComponent(slug)}/new`, '서버 문서 만들기');
  const template = String((request.body as any).template ?? '').trim();
  const area = normalizeDocumentArea((request.body as any).area);
  const params = new URLSearchParams();
  if (template) params.set('template', template);
  else params.set('blank', '1');
  if (area) params.set('area', area);
  const queryString = params.toString();
  return reply.redirect(`${wikiUrl('server', `${slug}/${title}`)}/edit${queryString ? `?${queryString}` : '?blank=1'}`);
});
app.get('/dev/new', async (request, reply) => {
  const templates = await documentTemplatesForSpace(null, 'developer');
  return reply.type('text/html').send(newDocumentFormPage('dev', (request as any).user, request.query as any, [], templates));
});
app.post('/dev/new', async (request, reply) => {
  const title = normalizeTitle(String((request.body as any).title ?? ''));
  if (!title) return htmlError(reply, (request as any).user, 400, '입력 오류', '문서 제목을 입력하세요.', '/dev/new', '개발 문서 만들기');
  const template = String((request.body as any).template ?? '').trim();
  return reply.redirect(`${wikiUrl('dev', title)}/edit${template ? `?template=${encodeURIComponent(template)}` : '?blank=1'}`);
});
app.get('/help', async (request, reply) => reply.type('text/html').send(spaceHomePage('help', (request as any).user)));
app.get('/project', async (request, reply) => reply.type('text/html').send(spaceHomePage('project', (request as any).user)));
app.get('/special', async (request, reply) => reply.type('text/html').send(spaceHomePage('special', (request as any).user)));
app.get('/template', async (request, reply) => reply.type('text/html').send(spaceHomePage('template', (request as any).user)));
app.get('/server/:slug/claim', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? '')));
  const space = await serverSubwikiSpace(slug);
  if (!space) return reply.code(404).type('text/html').send(messagePage('서버 위키 없음', '서버 공식 위키를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/servers', actionLabel: '서버 목록' }));
  if (!(await canManageSubwiki(user, Number(space.id)))) return reply.code(403).type('text/html').send(messagePage('권한 없음', '서버 운영자 인증 권한이 필요합니다.', user, { tone: 'error', actionHref: `/server/${encodeURIComponent(slug)}`, actionLabel: '서버 위키' }));
  const serverInfo = await one<any>(
    `SELECT ${entityServerSelectFields}, sw.host AS wiki_host, sw.port AS wiki_port
     FROM wiki_spaces ws
     LEFT JOIN entity_servers es ON es.page_id=ws.root_page_id
     LEFT JOIN server_wikis sw ON sw.space_id=ws.id
     WHERE ws.id=:spaceId`,
    { spaceId: space.id }
  );
  const claim = await latestServerClaim(Number(space.root_page_id), Number(user.id));
  const checks = claim ? await dnsChecksForClaim(Number(claim.id)) : [];
  return reply.type('text/html').send(serverClaimPage(space, serverInfo, claim, checks, user));
});
app.post('/server/:slug/claim', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return htmlError(reply, user, 403, '로그인 필요', '서버 인증을 진행하려면 로그인해야 합니다.', '/login', '로그인');
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? '')));
  const space = await serverSubwikiSpace(slug);
  if (!space) return htmlError(reply, user, 404, '서버 위키 없음', '서버 공식 위키를 찾을 수 없습니다.', '/servers', '서버 목록');
  if (!(await canManageSubwiki(user, Number(space.id)))) return htmlError(reply, user, 403, '권한 없음', '서버 운영자 인증 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`, '서버 위키');
  const serverInfo = await one<any>(`SELECT COALESCE(es.host, sw.host) AS host FROM wiki_spaces ws LEFT JOIN entity_servers es ON es.page_id=ws.root_page_id LEFT JOIN server_wikis sw ON sw.space_id=ws.id WHERE ws.id=:spaceId`, {
    spaceId: space.id
  });
  try {
    await createDnsServerClaim(Number(space.root_page_id), Number(user.id), serverInfo?.host);
  } catch (error: any) {
    return reply.code(400).type('text/html').send(messagePage('인증 토큰 발급 실패', `${error.message} IP 주소만으로는 DNS 인증을 사용할 수 없습니다. 서버 주소에 도메인을 등록한 뒤 다시 시도하세요.`, user, { tone: 'error', actionHref: `/server/${encodeURIComponent(slug)}/claim`, actionLabel: '인증으로 돌아가기' }));
  }
  return reply.redirect(`/server/${encodeURIComponent(slug)}/claim`);
});
app.post('/server/:slug/claim/verify', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return htmlError(reply, user, 403, '로그인 필요', '서버 인증을 진행하려면 로그인해야 합니다.', '/login', '로그인');
  const slug = normalizeTitle(decodePathPart(String((request.params as any).slug ?? '')));
  const space = await serverSubwikiSpace(slug);
  if (!space) return htmlError(reply, user, 404, '서버 위키 없음', '서버 공식 위키를 찾을 수 없습니다.', '/servers', '서버 목록');
  if (!(await canManageSubwiki(user, Number(space.id)))) return htmlError(reply, user, 403, '권한 없음', '서버 운영자 인증 권한이 필요합니다.', `/server/${encodeURIComponent(slug)}`, '서버 위키');
  const claimId = nullablePositiveInt((request.body as any).claimId);
  const claim = claimId
    ? await one<any>(`SELECT ${serverClaimVerifyFields} FROM server_claims WHERE id=:claimId AND page_id=:pageId AND status='pending'`, { claimId, pageId: Number(space.root_page_id) })
    : await latestServerClaim(Number(space.root_page_id), Number(user.id));
  if (!claim) return htmlError(reply, user, 404, '인증 요청 없음', '진행 중인 서버 인증 요청을 찾을 수 없습니다.', `/server/${encodeURIComponent(slug)}/claim`, '인증 화면');
  const result = await verifyDnsServerClaim(claim);
  if (result.ok) {
    await exec(
      `UPDATE server_claims
       SET status='verified', verified_at=COALESCE(verified_at, NOW()), last_verified_at=NOW(), renewal_required_at=DATE_ADD(NOW(), INTERVAL 1 YEAR), expires_at=DATE_ADD(NOW(), INTERVAL 1 YEAR), token_plain=NULL, updated_at=NOW()
       WHERE id=:id`,
      { id: claim.id }
    );
    await exec(`UPDATE entity_servers SET verified_status='verified', updated_at=NOW() WHERE page_id=:pageId`, { pageId: Number(space.root_page_id) });
    await syncServerWikiVerifiedStatus(Number(space.root_page_id), 'verified');
    await markServerPageVerified(Number(space.root_page_id), Number(claim.user_id));
    await grantServerOwner(Number(space.root_page_id), Number(claim.user_id), 'owner', 'active', Number(claim.user_id));
  }
  return reply.redirect(`/server/${encodeURIComponent(slug)}/claim`);
});
app.get('/me', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  const wiki = await ensureUserWiki(Number(user.id));
  const [stats, changes] = await Promise.all([
    userDashboardStats(Number(user.id)),
    query<any>(
      `SELECT rc.page_id, rc.change_type, rc.title, rc.namespace_code, rc.summary, rc.created_at,
              p.display_title, p.space_id, p.protection_level, p.status
       FROM recent_changes rc
       LEFT JOIN pages p ON p.id=rc.page_id
       WHERE rc.actor_id=:userId
       ORDER BY rc.created_at DESC LIMIT 8`,
      { userId: user.id }
    )
  ]);
  const visibleChanges = await filterRecentRowsForActor(aclActorForRequest(request), changes);
  return reply.type('text/html').send(userDashboardPage(user, wiki, stats, visibleChanges));
});
app.get('/me/sandbox', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.redirect(loginHrefForRequest(request));
  await ensureUserWiki(Number(user.id));
  return reply.redirect(`/user/${encodeURIComponent(user.username)}/${encodeURIComponent('연습장')}`);
});
app.get('/users/:id', async (request, reply) => {
  const id = nullablePositiveInt((request.params as any).id);
  const target = id ? await one<any>(`SELECT username FROM users WHERE id=:id AND status='active'`, { id }) : null;
  if (!target) return reply.code(404).type('text/html').send(messagePage('사용자 없음', '사용자를 찾을 수 없습니다.', (request as any).user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  return reply.redirect(`/user/${encodeURIComponent(String(target.username))}`);
});
app.get('/user/*', async (request, reply) => renderUserWikiPage(request, reply, String((request.params as any)['*'] ?? '')));
app.get('/mod/*', async (request, reply) => renderSpaceWikiPage(request, reply, 'mod', (request.params as any)['*']));
app.get('/modpack/*', async (request, reply) => renderSpaceWikiPage(request, reply, 'modpack', (request.params as any)['*']));
app.get('/server/*', async (request, reply) => renderSpaceWikiPage(request, reply, 'server', (request.params as any)['*']));
app.get('/dev/*', async (request, reply) => renderSpaceWikiPage(request, reply, 'dev', (request.params as any)['*']));
app.get('/help/*', async (request, reply) => renderSpaceWikiPage(request, reply, 'help', (request.params as any)['*']));
app.get('/project/*', async (request, reply) => renderSpaceWikiPage(request, reply, 'project', (request.params as any)['*']));
app.post('/mod/*', async (request, reply) => saveSpaceWikiPage(request, reply, 'mod', (request.params as any)['*']));
app.post('/modpack/*', async (request, reply) => saveSpaceWikiPage(request, reply, 'modpack', (request.params as any)['*']));
app.post('/server/*', async (request, reply) => saveSpaceWikiPage(request, reply, 'server', (request.params as any)['*']));
app.post('/dev/*', async (request, reply) => saveSpaceWikiPage(request, reply, 'dev', (request.params as any)['*']));
app.post('/help/*', async (request, reply) => saveSpaceWikiPage(request, reply, 'help', (request.params as any)['*']));
app.post('/project/*', async (request, reply) => saveSpaceWikiPage(request, reply, 'project', (request.params as any)['*']));
app.get('/*', async (request, reply) => {
  const rawPath = decodePathPart(String((request.params as any)['*'] ?? ''));
  if (await renderCustomDomainWikiPage(request, reply, rawPath)) return;
  return reply.code(404).type('text/html').send(messagePage('문서 없음', '요청한 경로를 찾을 수 없습니다.', (request as any).user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문', secondaryHref: '/search', secondaryLabel: '검색' }));
});

app.get('/announcements', async (request, reply) => {
  const rows = await publicAnnouncements((request as any).user);
  return reply.type('text/html').send(announcementsPage(rows, (request as any).user));
});
app.get('/release-notes', async (request, reply) => {
  const rows = await query<any>(`SELECT version, title, body, release_type, published_at FROM release_notes WHERE published_at IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT 100`);
  return reply.type('text/html').send(releaseNotesPage(rows, (request as any).user));
});
app.get('/status', async (request, reply) => {
  const incidents = await query<any>(`SELECT title, incident_type, severity, status, started_at, resolved_at, summary FROM incidents ORDER BY started_at DESC LIMIT 20`);
  return reply.type('text/html').send(serviceStatusPage({ incidents }, (request as any).user));
});

app.get('/special/recent-revisions', async (request, reply) => {
  const user = (request as any).user;
  const aclActor = aclActorForRequest(request);
  const includeRestricted = canViewRestrictedRevisions(user);
  const rows = await query<any>(
    `SELECT r.id AS revision_id, r.page_id, p.space_id, p.protection_level, p.status, n.code AS namespace_code, n.code AS namespace, p.title,
       r.revision_no, r.visibility, COALESCE(u.display_name,u.username,'익명') AS actor, r.edit_summary, r.created_at, CONCAT('/revision/', r.id) AS url
     FROM page_revisions r
     JOIN pages p ON p.id=r.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN users u ON u.id=r.created_by
     WHERE p.status NOT IN ('deleted','hidden') ${includeRestricted ? '' : "AND (r.visibility IS NULL OR r.visibility='public')"}
     ORDER BY r.created_at DESC
     LIMIT 200`
  );
  const visibleRows = [];
  for (const row of rows) {
    if (await canReadPageResource(aclActor, row) && (await aclDecision(aclActor, 'history', row)).allowed) {
      visibleRows.push({
        title: row.title,
        namespace: row.namespace,
        revision_no: row.revision_no,
        visibility: row.visibility,
        actor: row.actor,
        edit_summary: row.edit_summary,
        created_at: row.created_at,
        url: row.url
      });
    }
  }
  return reply.type('text/html').send(dataListPage('최근 리비전', visibleRows, user, {
    currentSpace: includeRestricted ? 'admin' : 'main',
    summary: includeRestricted ? '권한 범위 안에서 최근 리비전을 점검합니다.' : '공개 리비전을 위키 표 형식으로 정리합니다.'
  }));
});

app.get('/special/hidden-revisions', async (request, reply) => {
  const user = (request as any).user;
  if (!canViewRestrictedRevisions(user)) return reply.code(403).type('text/html').send(messagePage('권한 없음', '숨겨진 리비전을 볼 권한이 없습니다.', user, { tone: 'error', actionHref: '/recent', actionLabel: '최근 바뀜' }));
  const visibilityList = canViewSuppressedRevisions(user) ? "'hidden','admin_only','suppressed'" : "'hidden','admin_only'";
  const rows = await query<any>(
    `SELECT r.id AS revision_id, n.code AS namespace, p.title, r.revision_no, r.visibility, COALESCE(u.display_name,u.username,'익명') AS actor,
       r.edit_summary, r.created_at, rvl.reason AS last_reason, rvl.created_at AS visibility_changed_at, CONCAT('/revision/', r.id) AS url
     FROM page_revisions r
     JOIN pages p ON p.id=r.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN users u ON u.id=r.created_by
     LEFT JOIN (
       SELECT l1.id, l1.revision_id, l1.old_visibility, l1.new_visibility, l1.reason, l1.changed_by, l1.created_at FROM revision_visibility_logs l1
       JOIN (SELECT revision_id, MAX(id) AS max_id FROM revision_visibility_logs GROUP BY revision_id) latest ON latest.max_id=l1.id
     ) rvl ON rvl.revision_id=r.id
     WHERE r.visibility IN (${visibilityList})
     ORDER BY r.created_at DESC
     LIMIT 200`
  );
  const visibleRows = rows.map((row) => ({
    title: row.title,
    namespace: row.namespace,
    revision_no: row.revision_no,
    visibility: row.visibility,
    actor: row.actor,
    edit_summary: row.edit_summary,
    created_at: row.created_at,
    last_reason: row.last_reason,
    visibility_changed_at: row.visibility_changed_at,
    url: row.url
  }));
  return reply.type('text/html').send(dataListPage('숨겨진 리비전', visibleRows, user, {
    currentSpace: 'admin',
    summary: '숨김 처리된 리비전과 처리 사유를 점검합니다.'
  }));
});

async function redirectOperatorAlias(request: any, reply: any) {
  const user = request.user;
  return reply.redirect(can(user, 'report.handle') ? '/admin/operator' : '/login?next=%2Fadmin%2Foperator');
}

app.get('/special/operator-home', redirectOperatorAlias);
app.get('/special/운영자_홈', redirectOperatorAlias);
app.get('/admin/operator', renderOperatorHome);

app.get('/special/revision-search', async (request, reply) => {
  const user = (request as any).user;
  const aclActor = aclActorForRequest(request);
  const params = request.query as any;
  const q = String(params.q ?? '').trim();
  const namespace = String(params.namespace ?? '').trim();
  const visibility = String(params.visibility ?? '').trim();
  const includeRestricted = canViewRestrictedRevisions(user);
  const includeSuppressed = canViewSuppressedRevisions(user);
  const allowedVisibility = includeSuppressed ? ['public', 'hidden', 'admin_only', 'suppressed'] : ['public', 'hidden', 'admin_only'];
  const visibilityClause = includeRestricted && allowedVisibility.includes(visibility) ? 'AND r.visibility=:visibility' : '';
  const restrictedClause = includeRestricted ? (includeSuppressed ? '' : "AND r.visibility!='suppressed'") : "AND (r.visibility IS NULL OR r.visibility='public')";
  const namespaceClause = namespace ? 'AND n.code=:namespace' : '';
  const qClause = q ? `AND (p.title LIKE :likeQuery OR r.edit_summary LIKE :likeQuery OR u.username LIKE :likeQuery OR u.display_name LIKE :likeQuery)` : '';
  const rows = await query<any>(
    `SELECT r.id AS revision_id, r.page_id, p.space_id, p.protection_level, p.status, n.code AS namespace_code, n.code AS namespace, p.title, r.revision_no, r.visibility, COALESCE(u.display_name,u.username,'익명') AS actor,
       r.edit_summary, r.created_at, CONCAT('/revision/', r.id) AS url
     FROM page_revisions r
     JOIN pages p ON p.id=r.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN users u ON u.id=r.created_by
     WHERE p.status!='deleted' ${restrictedClause} ${visibilityClause} ${namespaceClause} ${qClause}
     ORDER BY r.created_at DESC
     LIMIT 200`,
    { q, likeQuery: `%${q}%`, namespace, visibility }
  );
  const visibleRows = [];
  for (const row of rows) {
    if (await canReadPageResource(aclActor, row) && (await aclDecision(aclActor, 'history', row)).allowed) {
      const { page_id, space_id, protection_level, status, namespace_code, ...item } = row;
      visibleRows.push(item);
    }
  }
  return reply.type('text/html').send(revisionSearchPage(visibleRows, { q, namespace, visibility }, user, includeRestricted));
});

app.get('/special/:kind', async (request, reply) => {
  const kind = (request.params as any).kind;
  if (!isSpecialQualityKind(kind)) {
    return reply
      .code(404)
      .type('text/html')
      .send(messagePage('특수 문서 없음', '요청한 특수 문서를 찾을 수 없습니다.', (request as any).user, { tone: 'error', actionHref: '/special', actionLabel: '특수 문서' }));
  }
  const rows = await qualityListForActor(kind, aclActorForRequest(request));
  return reply.type('text/html').send(qualityPage(specialQualityLabel(kind), rows, (request as any).user, kind));
});

app.get('/revision/:revisionId', async (request, reply) => {
  const user = (request as any).user;
  const aclActor = aclActorForRequest(request);
  const revisionId = nullablePositiveInt((request.params as any).revisionId);
  if (!revisionId) return reply.code(404).type('text/html').send(messagePage('리비전 없음', '리비전을 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/recent', actionLabel: '최근 바뀜' }));
  const revision = await pageRevisionById(revisionId, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user), true);
  if (!revision) return reply.code(404).type('text/html').send(messagePage('리비전 없음', '리비전을 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/recent', actionLabel: '최근 바뀜' }));
  const revisionPageResource = await getPageById(Number(revision.page_id));
  if (!(await canReadPageResource(aclActor, revisionPageResource)) || !(await aclDecision(aclActor, 'history', revisionPageResource)).allowed) {
    return reply.code(404).type('text/html').send(messagePage('리비전 없음', '리비전을 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/recent', actionLabel: '최근 바뀜' }));
  }
  if (revision.page_status === 'deleted') {
    const revisionPage = await renderRevisionPage(revision, user);
    if (!revisionPage) return reply.code(404).type('text/html').send(messagePage('리비전 없음', '리비전을 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/recent', actionLabel: '최근 바뀜' }));
    await attachDiscussionChrome(revisionPage, user, aclActor);
    return reply.type('text/html').send(articlePage(revisionPage, user));
  }
  return reply.redirect(`${wikiUrl(revision.namespace_code, revision.title)}?oldid=${revision.id}`);
});

app.get('/wiki/*', async (request, reply) => {
  const user = (request as any).user;
  const aclActor = aclActorForRequest(request);
  const rawPath = (request.params as any)['*'] as string;
  const toolPath = splitWikiToolPath(rawPath);
  const resolved = resolveWikiPath(toolPath.basePath);
  const livePage = (await getPageByTitle(resolved.namespace, resolved.title)) ?? (await getPageByAlias(resolved.namespace, resolved.title));
  const deletedPage = !livePage && ['history', 'diff', 'raw'].includes(toolPath.tool) ? await getPageByTitleIncludingDeleted(resolved.namespace, resolved.title) : null;
  const page = livePage ?? deletedPage;
  const requestedType = normalizeDocumentType(String((request.query as any).type ?? documentTypeForNamespace(resolved.namespace)));
  if (toolPath.tool === 'permissions' || toolPath.tool === 'acl' || toolPath.tool === 'aclHistory') {
    if (!page) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    const events = await pageProtectionEvents(Number(page.id));
    await attachAclOverview(page, user);
    await attachDocumentToolChrome(page, resolved.namespace, aclActor);
    if (toolPath.tool === 'aclHistory') return reply.type('text/html').send(aclHistoryPage(page, events, user));
    return reply.type('text/html').send(permissionInfoPage(page, events, user));
  }
  if (page && !(await canReadPageResource(aclActor, page))) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  if (toolPath.tool === 'discussion') {
    if (!page) return reply.code(404).type('text/html').send(messagePage('문서 없음', '토론 문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    if (page.page_type === 'mod') page.modDetails = await modDetails(Number(page.id));
    page.sidebarItems = await sidebarForPage(page.namespace_code, page.title, aclActor);
    page.recentRows = await recentChanges(15);
    page.sectionLocks = await sectionLocks(Number(page.id));
    page.discussionStatus = discussionTabStatus((request.query as any).status);
    await attachDiscussionChrome(page, user, aclActor);
    await attachSubwikiTheme(page, page.namespace_code);
    await recordPageView(page, request);
    return reply.type('text/html').send(discussionPage(page, user));
  }
  if (toolPath.tool === 'edit') {
    const editTitle = page?.title ?? resolved.title;
    if (resolved.namespace === 'main' && isUserWikiTitle(editTitle) && !(await canEditUserWikiTitle(user, editTitle))) {
      return reply.code(403).type('text/html').send(messagePage('권한 없음', '사용자 문서는 본인과 관리자만 수정할 수 있습니다.', user, { tone: 'error', actionHref: wikiUrl(resolved.namespace, editTitle), actionLabel: '문서 보기' }));
    }
    const announcements = await publicAnnouncements((request as any).user);
    const policyNotice = editPolicyNotice(page, resolved.namespace, editTitle, user);
    const blank = String((request.query as any).blank ?? '') === '1';
    const initialContent = page?.content_raw ?? (blank ? '' : ((await templateContent((request.query as any).template, resolved.title, resolved.namespace)) || defaultMarkup(resolved.title, resolved.namespace, requestedType)));
    return reply
      .type('text/html')
      .send(
        editPage(
          resolved.namespace,
          page?.title ?? resolved.title,
          initialContent,
          user,
          announcements,
          page?.page_type ?? pageTypeForDocumentType(requestedType),
          page?.current_revision_id ?? '',
          policyNotice
        )
      );
  }
  if (toolPath.tool === 'history') {
    if (!page) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    if (!(await aclDecision(aclActor, 'history', page)).allowed) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    page.aclLogs = await aclLogsForPage(Number(page.id));
    await attachDocumentToolChrome(page, resolved.namespace, aclActor);
    const filterTag = revisionHistoryFilterTag(request.query, user);
    const revisions = await pageRevisions(Number(page.id), canViewRestrictedRevisions(user), canViewSuppressedRevisions(user));
    return reply.type('text/html').send(revisionHistoryPage(page, filterRevisionHistory(revisions, filterTag, user), user, { filterTag }));
  }
  if (toolPath.tool === 'diff') {
    if (!page) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    if (!(await aclDecision(aclActor, 'history', page)).allowed) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    const revisions = await pageRevisions(Number(page.id), canViewRestrictedRevisions(user), canViewSuppressedRevisions(user));
    const query = request.query as any;
    const to = Number(query.to || revisions[0]?.id || 0);
    const from = Number(query.from || revisions[1]?.id || to);
    const result = await diffRevisions(Number(page.id), from, to, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user));
    if (!result) return reply.code(404).type('text/html').send(messagePage('비교 없음', '비교할 리비전을 찾을 수 없습니다.', (request as any).user, { tone: 'error', actionHref: wikiUrl(page.namespace_code, page.title), actionLabel: '문서 보기' }));
    const fromRevision = revisions.find((revision) => Number(revision.id) === from);
    const toRevision = revisions.find((revision) => Number(revision.id) === to);
    await attachDocumentToolChrome(page, resolved.namespace, aclActor);
    return reply
      .type('text/html')
      .send(revisionDiffPage(page, { ...result, fromRevisionNo: fromRevision?.revision_no, toRevisionNo: toRevision?.revision_no }, user));
  }
  if (toolPath.tool === 'raw') return renderRawDocumentPage(request, reply, page, user, aclActor);
  const oldid = Number((request.query as any).oldid || 0);
  if (!page && oldid) {
    const revision = await pageRevisionById(oldid, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user), true);
    if (revision && revision.namespace_code === resolved.namespace && normalizeTitle(revision.title) === normalizeTitle(resolved.title)) {
      const revisionPage = await renderRevisionPage(revision, user);
      if (revisionPage) {
        await attachDiscussionChrome(revisionPage, user, aclActor);
        await attachSubwikiTheme(revisionPage, revisionPage.namespace_code);
        return reply.type('text/html').send(articlePage(revisionPage, user));
      }
    }
  }
  if (!page) {
    return reply
      .code(404)
      .type('text/html')
      .send(missingDocumentPage(resolved.namespace, resolved.title, user, request.query as any));
  }
  if (page.page_type === 'mod') {
    page.modDetails = await modDetails(Number(page.id));
  }
  if (oldid) {
    const revisionPage = await getPageAtRevision(Number(page.id), oldid, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user), String(page.status ?? '') === 'deleted');
    if (!revisionPage) return reply.code(404).type('text/html').send(messagePage('리비전 없음', '이 문서의 공개 리비전을 찾을 수 없습니다.', user, { tone: 'error', actionHref: wikiUrl(page.namespace_code, page.title), actionLabel: '현재 문서' }));
    if (revisionPage.page_type === 'mod') revisionPage.modDetails = await modDetails(Number(revisionPage.id));
    revisionPage.sidebarItems = await sidebarForPage(revisionPage.namespace_code, revisionPage.title, aclActor);
    revisionPage.recentRows = await recentChanges(15);
    await attachDiscussionChrome(revisionPage, user, aclActor);
    return reply.type('text/html').send(articlePage(revisionPage, user));
  }
  page.recentRows = await recentChanges(15);
  page.sectionLocks = await sectionLocks(Number(page.id));
  await attachDiscussionChrome(page, user, aclActor);
  await recordPageView(page, request);
  return reply.type('text/html').send(articlePage(page, user));
});

app.post('/wiki/*', async (request, reply) => {
  const fullPath = (request.params as any)['*'] as string;
  if (fullPath.endsWith('/discussion')) {
    const rawPath = fullPath.replace(/\/discussion$/, '');
    const resolved = resolveWikiPath(rawPath);
    return createDiscussionFromWikiPath(request, reply, resolved.namespace, resolved.title);
  }
  if (fullPath.endsWith('/rollback')) {
    const rawPath = fullPath.replace(/\/rollback$/, '');
    const resolved = resolveWikiPath(rawPath);
    const page = (await getPageByTitle(resolved.namespace, resolved.title)) ?? (await getPageByAlias(resolved.namespace, resolved.title));
    const user = (request as any).user;
    const revisionId = nullablePositiveInt((request.body as any).revisionId);
    const pageHref = wikiUrl(resolved.namespace, resolved.title);
    if (!revisionId) return htmlError(reply, user, 400, '입력 오류', '되돌릴 리비전을 선택하세요.', `${pageHref}/history`, '판 기록');
    if (!page) return htmlError(reply, user, 404, '문서 없음', '문서를 찾을 수 없습니다.', '/wiki', '위키 대문');
    if (!(await aclDecision(user, 'revert', page)).allowed) return htmlError(reply, user, 403, '권한 없음', '보호된 문서입니다.', pageHref, '문서 보기');
    const rollbackRevision = await pageRevision(Number(page.id), revisionId, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user));
    if (!rollbackRevision) return htmlError(reply, user, 404, '리비전 없음', '리비전을 찾을 수 없습니다.', `${pageHref}/history`, '판 기록');
    await assertLockedSectionsUnchanged(page, rollbackRevision.content_raw ?? '', user);
    await rollbackToRevision(Number(page.id), revisionId, user?.id ?? null);
    return reply.redirect(wikiUrl(resolved.namespace, page.title));
  }
  if (fullPath.endsWith('/acl')) {
    const rawAclPath = fullPath.replace(/\/acl$/, '');
    const resolvedAcl = resolveWikiPath(rawAclPath);
    return handleAclPost(request, reply, resolvedAcl.namespace, resolvedAcl.title);
  }
  if (!fullPath.endsWith('/edit')) return htmlError(reply, (request as any).user, 404, '문서 없음', '요청한 문서 작업을 찾을 수 없습니다.', '/wiki', '위키 대문');
  const rawPath = fullPath.replace(/\/edit$/, '');
  const resolved = resolveWikiPath(rawPath);
  const body = request.body as any;
  const user = (request as any).user;
  if (!consumeActorRateLimit(request, 'page-edit', 30, 90, 60 * 60 * 1000)) return htmlError(reply, user, 429, '편집 제한', '짧은 시간 안에 편집 요청이 너무 많습니다. 잠시 후 다시 시도하세요.', wikiUrl(resolved.namespace, resolved.title), '문서 보기');
  if (!user && !(await requireTurnstile(request, reply, 'anonymous_edit'))) return reply;
  const aclActor = aclActorForRequest(request);
  const content = limitedText(body.content, maxPageContentLength);
  if (content === null) return htmlError(reply, user, 413, '본문 초과', '문서 본문이 너무 깁니다.', `${wikiUrl(resolved.namespace, resolved.title)}/edit`, '편집으로 돌아가기');
  const page = (await getPageByTitle(resolved.namespace, resolved.title)) ?? (await getPageByAlias(resolved.namespace, resolved.title));
  const targetNamespace = (body.namespace ?? resolved.namespace) as NamespaceCode;
  const targetTitle = normalizeTitle(body.title ?? resolved.title);
  const userWikiEditTitle = resolved.namespace === 'main' && isUserWikiTitle(page?.title ?? resolved.title) ? String(page?.title ?? resolved.title) : '';
  if (userWikiEditTitle && (targetNamespace !== 'main' || normalizeTitle(targetTitle) !== normalizeTitle(userWikiEditTitle))) {
    return htmlError(reply, user, 403, '권한 없음', '사용자 문서 제목은 변경할 수 없습니다.', `${wikiUrl(resolved.namespace, resolved.title)}/edit`, '편집으로 돌아가기');
  }
  if ((userWikiEditTitle || (targetNamespace === 'main' && isUserWikiTitle(targetTitle))) && !(await canEditUserWikiTitle(user, userWikiEditTitle || targetTitle))) {
    return htmlError(reply, user, 403, '권한 없음', '사용자 위키는 본인만 편집할 수 있습니다.', wikiUrl(resolved.namespace, resolved.title), '문서 보기');
  }
  const targetPage = targetNamespace === resolved.namespace && targetTitle === resolved.title ? page : await getPageByTitle(targetNamespace, targetTitle);
  const pageAccess = page ? await pageEditAccess(aclActor, page) : { allowed: true, forceReviewReason: null as string | null };
  const targetAccess = targetPage && targetPage.id !== page?.id ? await pageEditAccess(aclActor, targetPage) : { allowed: true, forceReviewReason: null as string | null };
  if (!pageAccess.allowed || !targetAccess.allowed) return htmlError(reply, user, 403, '권한 없음', '보호된 문서입니다.', wikiUrl(resolved.namespace, resolved.title), '문서 보기');
  const baseRevisionId = body.baseRevisionId ? nullablePositiveInt(body.baseRevisionId) : 0;
  if (body.baseRevisionId && !baseRevisionId) return htmlError(reply, user, 400, '입력 오류', '기준 리비전 값이 올바르지 않습니다.', `${wikiUrl(resolved.namespace, resolved.title)}/edit`, '편집으로 돌아가기');
  if (page && baseRevisionId && Number(page.current_revision_id) !== baseRevisionId) {
    return reply
      .code(409)
      .type('text/html')
      .send(
        editConflictPage(
          targetNamespace,
          targetTitle,
          page.content_raw ?? '',
          content,
          user,
          normalizeSavedPageType(body.pageType) ?? page.page_type ?? '',
          page.current_revision_id ?? '',
          boundedText(body.summary, 255)
        )
      );
  }
  try {
    if (user) await enforceOpenBetaEditPolicy(user.id, content);
    const [newUserReason, subwikiPolicy] = await Promise.all([
      user ? newUserReviewReason(user.id) : Promise.resolve('비로그인 편집 검토'),
      subwikiEditPolicy(targetNamespace, targetTitle, user)
    ]);
    if (!subwikiPolicy.allowed) return htmlError(reply, user, 403, '권한 없음', '이 위키는 공개 편집을 허용하지 않습니다.', wikiUrl(targetNamespace, targetTitle), '문서 보기');
    const areaReview = normalizeDocumentArea(body.area) === 'review_required' ? '문서 영역: 검토 필요' : null;
    const mainPageReview = targetNamespace === 'main' && targetTitle === '대문' ? '대문 고위험 문서 검토 정책' : null;
    const forceReviewReason = [newUserReason, subwikiPolicy.forceReviewReason, pageAccess.forceReviewReason, targetAccess.forceReviewReason, areaReview, mainPageReview].filter(Boolean).join(' / ') || null;
    if (page) await assertLockedSectionsUnchanged(page, content, user);
    if (targetPage && targetPage.id !== page?.id) await assertLockedSectionsUnchanged(targetPage, content, user);
    const saved = await savePage({
      namespace: targetNamespace,
      title: targetTitle,
      displayTitle: targetNamespace === 'main' ? userWikiDisplayTitle(targetTitle) : undefined,
      content,
      summary: boundedText(body.summary, 255) || undefined,
      userId: user?.id ?? null,
      actorIpText: user ? null : requestRemoteIp(request),
      pageType: normalizeSavedPageType(body.pageType),
      baseRevisionId,
      isMinor: parseBoolean(body.isMinor),
      forceReviewReason
    });
    if (saved.pending) {
      return reply
        .type('text/html')
        .send(messagePage('검토 대기', `이 편집은 운영자 검토 후 반영됩니다. 검토 번호: #${saved.pendingReviewId}`, user, { actionHref: wikiUrl(targetNamespace, targetTitle), actionLabel: '문서로 돌아가기' }));
    }
  } catch (error: any) {
    return htmlError(reply, user, 400, '편집 오류', String(error.message ?? '편집을 저장할 수 없습니다.'), `${wikiUrl(resolved.namespace, resolved.title)}/edit`, '편집으로 돌아가기');
  }
  return reply.redirect(wikiUrl(targetNamespace, targetTitle));
});

app.get('/admin', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  const [reports, users, logs, work, feedback] = await Promise.all([
    query<any>(`SELECT id, page_id, reason, status, created_at FROM reports ORDER BY created_at DESC LIMIT 20`),
    query<any>(`SELECT id, username, display_name, status, created_at FROM users ORDER BY id DESC LIMIT 20`),
    query<any>(`SELECT id, action, target_type, target_id, created_at FROM admin_logs ORDER BY created_at DESC LIMIT 20`),
    adminWorkItems(20),
    betaFeedbackItems(30)
  ]);
  return reply.type('text/html').send(adminPage({ work, reports, users, logs, feedback }, user));
});
app.post('/admin/feedback/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const feedbackId = nullablePositiveInt((request.params as any).id);
  if (!feedbackId) return adminError(reply, user, 400, '입력 오류', '피드백 항목을 찾을 수 없습니다.', '/admin');
  await updateBetaFeedback(feedbackId, body.status, user?.id ?? null);
  return reply.redirect('/admin');
});

app.get('/admin/reports', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  return reply.type('text/html').send(adminReportsPage(await adminReportRows(200), user));
});

app.post('/admin/reports/:id/resolve', async (request, reply) => {
  const user = (request as any).user;
  try {
    await resolveReportAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
    return reply.redirect('/admin/reports');
  } catch (error: any) {
    return adminError(reply, user, error?.statusCode ?? 400, '신고 처리 오류', String(error?.message ?? '신고를 처리할 수 없습니다.'), '/admin/reports', '신고 관리');
  }
});

app.get('/admin/publication', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  return reply.type('text/html').send(adminPublicationPage(await adminPublicationData(), user));
});

app.post('/admin/publication/settings', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  if (!(await saveOpenBetaSettings(body, user?.id ?? null))) return adminError(reply, user, 400, '설정 저장 오류', '가입 방식과 서버 노출 기준을 확인해 주세요.', '/admin/publication', '공개 운영');
  return reply.redirect('/admin/publication');
});

app.post('/admin/publication/announcements', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  const content = boundedText(body.body, 20_000);
  if (!title || !content) return adminError(reply, user, 400, '공지 작성 오류', '제목과 본문을 입력해 주세요.', '/admin/publication', '공개 운영');
  await exec(
    `INSERT INTO announcements (title, body, type, visibility, starts_at, ends_at, created_by, created_at, updated_at)
     VALUES (:title, :body, :type, :visibility, :startsAt, :endsAt, :userId, NOW(), NOW())`,
    {
      title,
      body: content,
      type: normalizeAnnouncementType(body.type),
      visibility: normalizeAnnouncementVisibility(body.visibility),
      startsAt: normalizeDateTimeInput(body.startsAt),
      endsAt: normalizeDateTimeInput(body.endsAt),
      userId: user?.id ?? null
    }
  );
  return reply.redirect('/admin/publication');
});

app.post('/admin/publication/release-notes', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const version = boundedReleaseVersion(body.version);
  const title = boundedText(body.title, 255);
  const content = boundedText(body.body, 20_000);
  if (!version || !title || !content) return adminError(reply, user, 400, '릴리즈 작성 오류', '버전, 제목, 본문을 확인해 주세요.', '/admin/publication', '공개 운영');
  await exec(
    `INSERT INTO release_notes (version, title, body, release_type, published_by, published_at, created_at)
     VALUES (:version, :title, :body, :releaseType, :userId, :publishedAt, NOW())
     ON DUPLICATE KEY UPDATE title=VALUES(title), body=VALUES(body), release_type=VALUES(release_type), published_by=VALUES(published_by), published_at=VALUES(published_at)`,
    {
      version,
      title,
      body: content,
      releaseType: normalizeReleaseNoteType(body.releaseType),
      userId: user?.id ?? null,
      publishedAt: normalizeDateTimeInput(body.publishedAt) ?? currentSqlDateTime()
    }
  );
  return reply.redirect('/admin/publication');
});

app.post('/admin/publication/incidents', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  if (!title) return adminError(reply, user, 400, '상태 등록 오류', '제목을 입력해 주세요.', '/admin/publication', '공개 운영');
  const status = normalizeIncidentStatus(body.status);
  if (!status) return adminError(reply, user, 400, '상태 등록 오류', '상태 값을 확인해 주세요.', '/admin/publication', '공개 운영');
  await exec(
    `INSERT INTO incidents (title, incident_type, severity, status, started_at, summary, created_by, created_at, updated_at)
     VALUES (:title, :incidentType, :severity, :status, :startedAt, :summary, :userId, NOW(), NOW())`,
    {
      title,
      incidentType: normalizeIncidentType(body.incidentType),
      severity: normalizeIncidentSeverity(body.severity),
      status,
      startedAt: normalizeDateTimeInput(body.startedAt) ?? currentSqlDateTime(),
      summary: boundedText(body.summary, 5000) || null,
      userId: user?.id ?? null
    }
  );
  return reply.redirect('/admin/publication');
});

app.post('/admin/publication/campaigns', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  if (!title) return adminError(reply, user, 400, '캠페인 생성 오류', '제목을 입력해 주세요.', '/admin/publication', '공개 운영');
  await exec(
    `INSERT INTO writing_campaigns (title, description, campaign_type, status, starts_at, ends_at, created_by, created_at, updated_at)
     VALUES (:title, :description, :campaignType, :status, :startsAt, :endsAt, :userId, NOW(), NOW())`,
    {
      title,
      description: boundedText(body.description, 4000) || null,
      campaignType: normalizeCampaignType(body.campaignType),
      status: normalizeCampaignStatus(body.status),
      startsAt: normalizeDateTimeInput(body.startsAt),
      endsAt: normalizeDateTimeInput(body.endsAt),
      userId: user?.id ?? null
    }
  );
  return reply.redirect('/admin/publication');
});

app.post('/admin/publication/report-sla', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const reason = boundedText(body.reason, 255);
  const priority = normalizeTaskPriority(body.priority ?? 'normal');
  if (!reason || !priority) return adminError(reply, user, 400, 'SLA 저장 오류', '신고 사유와 우선순위를 확인해 주세요.', '/admin/publication', '공개 운영');
  await exec(
    `INSERT INTO report_sla_rules (reason, priority, target_minutes, enabled, created_at, updated_at)
     VALUES (:reason, :priority, :targetMinutes, :enabled, NOW(), NOW())
     ON DUPLICATE KEY UPDATE priority=VALUES(priority), target_minutes=VALUES(target_minutes), enabled=VALUES(enabled), updated_at=NOW()`,
    {
      reason,
      priority,
      targetMinutes: boundedUnsignedInt(body.targetMinutes ?? 1440, 60 * 24 * 30) ?? 1440,
      enabled: body.enabled === undefined ? 0 : parseBoolean(body.enabled) ? 1 : 0
    }
  );
  return reply.redirect('/admin/publication');
});

app.post('/admin/publication/policy-versions', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const page = await searchTargetPageFromBody(body, ['pageRef', 'pageId']);
  const policyKey = boundedKey(body.policyKey, 64);
  const version = boundedReleaseVersion(body.version ?? '1.0');
  const status = normalizePolicyVersionStatus(body.status ?? 'draft');
  if (!page || !policyKey || !version || !status) return adminError(reply, user, 400, '정책 버전 저장 오류', '정책 문서, 키, 버전, 상태를 확인해 주세요.', '/admin/publication', '공개 운영');
  await exec(
    `INSERT INTO policy_versions (page_id, policy_key, version, status, effective_at, created_by, created_at)
     VALUES (:pageId, :policyKey, :version, :status, :effectiveAt, :userId, NOW())
     ON DUPLICATE KEY UPDATE status=VALUES(status), effective_at=VALUES(effective_at)`,
    { pageId: page.id, policyKey, version, status, effectiveAt: normalizeDateTimeInput(body.effectiveAt), userId: user?.id ?? null }
  );
  return reply.redirect('/admin/publication');
});

async function adminPublicationData() {
  const [settings, announcements, releaseNotes, incidents, campaigns, reportSlaRules, policyVersions] = await Promise.all([
    one<any>(`SELECT ${openBetaSettingsFields} FROM open_beta_settings WHERE id=1`),
    query<any>(`SELECT ${announcementFields} FROM announcements ORDER BY id DESC LIMIT 80`),
    query<any>(`SELECT id, version, title, body, release_type, published_at, created_at FROM release_notes ORDER BY published_at DESC, id DESC LIMIT 80`),
    query<any>(`SELECT id, title, incident_type, severity, status, started_at, resolved_at, summary FROM incidents ORDER BY started_at DESC, id DESC LIMIT 80`),
    query<any>(`SELECT id, title, description, campaign_type, status, starts_at, ends_at FROM writing_campaigns ORDER BY FIELD(status,'active','paused','draft','completed','archived'), id DESC LIMIT 80`),
    query<any>(`SELECT id, reason, priority, target_minutes, enabled, created_at, updated_at FROM report_sla_rules ORDER BY FIELD(priority,'urgent','high','normal','low'), reason LIMIT 80`),
    query<any>(
      `SELECT pv.id, pv.page_id, pv.policy_key, pv.version, pv.status, pv.effective_at, pv.created_by, pv.created_at,
              p.title, p.display_title, n.code AS namespace_code
       FROM policy_versions pv
       JOIN pages p ON p.id=pv.page_id
       JOIN namespaces n ON n.id=p.namespace_id
       ORDER BY pv.policy_key, pv.created_at DESC LIMIT 80`
    )
  ]);
  return { settings: settings ?? {}, announcements, releaseNotes, incidents, campaigns, reportSlaRules, policyVersions };
}

app.get('/admin/identity', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  return reply.type('text/html').send(adminIdentityPage(await adminIdentityData(), user));
});

app.post('/admin/identity/users/:id/trust', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const userId = nullablePositiveInt((request.params as any).id);
  const trustLevel = normalizeTrustLevel((request.body as any)?.trustLevel) ?? 'normal';
  if (!userId) return adminError(reply, user, 400, '신뢰 저장 오류', '사용자를 찾을 수 없습니다.', '/admin/identity', '사용자/권한');
  await exec(
    `INSERT INTO user_trust (user_id, trust_level, updated_at)
     VALUES (:userId, :trustLevel, NOW())
     ON DUPLICATE KEY UPDATE trust_level=VALUES(trust_level), updated_at=NOW()`,
    { userId, trustLevel }
  );
  await syncManualTrustGroups(userId, trustLevel);
  return reply.redirect('/admin/identity');
});

app.post('/admin/identity/users/:id/block', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'user.block') && !can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '사용자 차단 권한이 필요합니다.', '/admin/identity', '사용자/권한');
  const targetId = nullablePositiveInt((request.params as any).id);
  if (!targetId || user?.id === targetId) return adminError(reply, user, 400, '차단 오류', '차단할 사용자를 확인해 주세요.', '/admin/identity', '사용자/권한');
  const body = request.body as any;
  await blockUser(targetId, user?.id ?? null, body?.reason ?? '관리자 차단', body?.expiresAt ?? null);
  return reply.redirect('/admin/identity');
});

app.post('/admin/identity/users/:id/unblock', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'user.block') && !can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '사용자 차단 해제 권한이 필요합니다.', '/admin/identity', '사용자/권한');
  const targetId = nullablePositiveInt((request.params as any).id);
  if (!targetId) return adminError(reply, user, 400, '차단 해제 오류', '사용자를 확인해 주세요.', '/admin/identity', '사용자/권한');
  const body = request.body as any;
  await unblockUser(targetId, user?.id ?? null, body?.reason ?? '관리자 차단 해제');
  return reply.redirect('/admin/identity');
});

app.post('/admin/identity/server-owners', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'server.official_edit') && !can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '서버 소유자 관리 권한이 필요합니다.', '/admin/identity', '사용자/권한');
  const body = request.body as any;
  const page = await searchTargetPageFromBody(body, ['pageRef', 'pageId']);
  const owner = await adminUserByRef(body.userRef ?? body.userId);
  if (!page || String(page.namespace_code ?? '') !== 'server' || !owner) return adminError(reply, user, 400, '소유자 저장 오류', '서버 문서와 사용자를 확인해 주세요.', '/admin/identity', '사용자/권한');
  const role = normalizeServerOwnerRole(body.role) ?? 'owner';
  const status = normalizeServerOwnerStatus(body.status) ?? 'active';
  await grantServerOwner(Number(page.id), Number(owner.id), role, status, user?.id ?? null);
  await logAdmin(user?.id ?? null, 'server_owner.grant', 'server', Number(page.id), { userId: owner.id, role, status });
  return reply.redirect('/admin/identity');
});

app.post('/admin/identity/server-owners/:id/revoke', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'server.official_edit') && !can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '서버 소유자 관리 권한이 필요합니다.', '/admin/identity', '사용자/권한');
  const ownerId = nullablePositiveInt((request.params as any).id);
  const owner = ownerId ? await one<any>(`SELECT ${serverOwnerFields} FROM server_owners WHERE id=:id`, { id: ownerId }) : null;
  if (!owner) return adminError(reply, user, 404, '소유자 없음', '서버 소유자 항목을 찾을 수 없습니다.', '/admin/identity', '사용자/권한');
  await exec(`UPDATE server_owners SET status='revoked', revoked_at=NOW(), revoked_by=:userId WHERE id=:id`, { id: owner.id, userId: user?.id ?? null });
  await syncServerOwnerSubwikiRole(Number(owner.page_id), Number(owner.user_id), owner.role, 'revoked', user?.id ?? null);
  await logAdmin(user?.id ?? null, 'server_owner.revoke', 'server', Number(owner.page_id), { userId: owner.user_id });
  return reply.redirect('/admin/identity');
});

app.post('/admin/identity/acl-groups/:key/members', async (request, reply) => {
  const user = (request as any).user;
  if (!canManageAclGroups(user)) return adminError(reply, user, 403, '권한 없음', 'ACL 그룹 관리 권한이 필요합니다.', '/admin/identity', '사용자/권한');
  const groupKey = String((request.params as any).key ?? '').trim();
  const group = /^[a-z0-9_-]{1,64}$/.test(groupKey)
    ? await one<any>(`SELECT id, group_key FROM acl_groups WHERE group_key=:groupKey AND status!='archived'`, { groupKey })
    : null;
  if (!group) return adminError(reply, user, 404, 'ACL 그룹 없음', '그룹을 찾을 수 없습니다.', '/admin/identity', '사용자/권한');
  const body = request.body as any;
  const memberType = String(body.memberType ?? '').trim();
  const reason = boundedText(body.reason, 500);
  const expiresAt = aclExpiresAt(body.expiresIn);
  if (memberType === 'user') {
    const member = await adminUserByRef(body.userRef ?? body.value ?? body.userId);
    if (!member) return adminError(reply, user, 400, '멤버 추가 오류', '사용자를 찾을 수 없습니다.', '/admin/identity', '사용자/권한');
    await exec(
      `INSERT INTO acl_group_members (group_id, member_type, user_id, reason, expires_at, added_by, added_at)
       VALUES (:groupId, 'user', :userId, :reason, :expiresAt, :addedBy, NOW())`,
      { groupId: group.id, userId: member.id, reason, expiresAt, addedBy: user?.id ?? null }
    );
    return reply.redirect('/admin/identity');
  }
  if (memberType === 'ip') {
    const ip = String(body.ip ?? body.value ?? '').trim();
    if (!net.isIP(ip)) return adminError(reply, user, 400, '멤버 추가 오류', 'IP 주소를 확인해 주세요.', '/admin/identity', '사용자/권한');
    await exec(
      `INSERT INTO acl_group_members (group_id, member_type, ip, reason, expires_at, added_by, added_at)
       VALUES (:groupId, 'ip', INET6_ATON(:ip), :reason, :expiresAt, :addedBy, NOW())`,
      { groupId: group.id, ip, reason, expiresAt, addedBy: user?.id ?? null }
    );
    return reply.redirect('/admin/identity');
  }
  if (memberType === 'cidr') {
    const cidr = normalizeAclSubjectValue('cidr', body.cidr ?? body.value);
    if (!cidr) return adminError(reply, user, 400, '멤버 추가 오류', 'CIDR 값을 확인해 주세요.', '/admin/identity', '사용자/권한');
    await exec(
      `INSERT INTO acl_group_members (group_id, member_type, cidr, reason, expires_at, added_by, added_at)
       VALUES (:groupId, 'cidr', :cidr, :reason, :expiresAt, :addedBy, NOW())`,
      { groupId: group.id, cidr, reason, expiresAt, addedBy: user?.id ?? null }
    );
    return reply.redirect('/admin/identity');
  }
  return adminError(reply, user, 400, '멤버 추가 오류', '멤버 종류를 확인해 주세요.', '/admin/identity', '사용자/권한');
});

app.post('/admin/identity/acl-groups/:key/members/:memberId/remove', async (request, reply) => {
  const user = (request as any).user;
  if (!canManageAclGroups(user)) return adminError(reply, user, 403, '권한 없음', 'ACL 그룹 관리 권한이 필요합니다.', '/admin/identity', '사용자/권한');
  const groupKey = String((request.params as any).key ?? '').trim();
  const memberId = nullablePositiveInt((request.params as any).memberId);
  if (!memberId || !/^[a-z0-9_-]{1,64}$/.test(groupKey)) return adminError(reply, user, 400, '멤버 제거 오류', '멤버 정보를 확인해 주세요.', '/admin/identity', '사용자/권한');
  await exec(
    `UPDATE acl_group_members m
     JOIN acl_groups g ON g.id=m.group_id
     SET m.removed_at=NOW()
     WHERE m.id=:memberId AND g.group_key=:groupKey AND m.removed_at IS NULL`,
    { memberId, groupKey }
  );
  return reply.redirect('/admin/identity');
});

async function adminIdentityData() {
  const [users, serverOwners, aclGroups, aclMembers] = await Promise.all([
    query<any>(
      `SELECT u.id, u.username, u.display_name, u.status, u.created_at,
              COALESCE(ut.trust_level,'new') AS trust_level, ut.good_edits, ut.reports_received, ut.filter_hits,
              GROUP_CONCAT(g.code ORDER BY g.code SEPARATOR ',') AS groups
       FROM users u
       LEFT JOIN user_trust ut ON ut.user_id=u.id
       LEFT JOIN user_groups ug ON ug.user_id=u.id
       LEFT JOIN groups g ON g.id=ug.group_id
       GROUP BY u.id, u.username, u.display_name, u.status, u.created_at, ut.trust_level, ut.good_edits, ut.reports_received, ut.filter_hits
       ORDER BY FIELD(u.status,'blocked','pending','active'), FIELD(COALESCE(ut.trust_level,'new'),'restricted','new','normal','autoconfirmed','trusted'), u.id DESC
       LIMIT 100`
    ),
    query<any>(
      `SELECT so.id, so.page_id, so.user_id, so.role, so.status, so.granted_at, so.revoked_at,
              p.title AS server_title, u.username, u.display_name
       FROM server_owners so
       JOIN pages p ON p.id=so.page_id
       JOIN users u ON u.id=so.user_id
       ORDER BY FIELD(so.status,'pending','active','revoked'), p.title, FIELD(so.role,'owner','manager','editor') LIMIT 100`
    ),
    query<any>(
      `SELECT g.id, g.group_key, g.title, g.description, g.status, g.created_at, g.updated_at,
              COUNT(m.id) AS active_member_count
       FROM acl_groups g
       LEFT JOIN acl_group_members m ON m.group_id=g.id
         AND m.removed_at IS NULL
         AND (m.expires_at IS NULL OR m.expires_at > NOW())
       GROUP BY g.id, g.group_key, g.title, g.description, g.status, g.created_at, g.updated_at
       ORDER BY g.group_key LIMIT 100`
    ),
    query<any>(
      `SELECT m.id, g.group_key, g.title AS group_title, m.member_type, m.user_id, u.username, u.display_name,
              INET6_NTOA(m.ip) AS ip_text, m.cidr, m.reason, m.expires_at, m.added_at
       FROM acl_group_members m
       JOIN acl_groups g ON g.id=m.group_id
       LEFT JOIN users u ON u.id=m.user_id
       WHERE m.removed_at IS NULL AND (m.expires_at IS NULL OR m.expires_at > NOW())
       ORDER BY g.group_key, m.added_at DESC LIMIT 200`
    )
  ]);
  return { users, serverOwners, aclGroups, aclMembers };
}

async function adminUserByRef(value: unknown) {
  const id = nullablePositiveInt(value);
  if (id) return one<any>(`SELECT id, username, display_name FROM users WHERE id=:id AND status!='disabled'`, { id });
  return userByIdentifier(value);
}

app.get('/admin/audits', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  return reply.type('text/html').send(adminAuditHubPage(await adminAuditHubData(), user));
});

app.post('/admin/audits/content', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const page = await searchTargetPageFromBody(body, ['pageRef', 'pageId']);
  const auditType = normalizeContentAuditType(body.auditType);
  const status = normalizeContentAuditStatus(body.status ?? 'pending');
  if (!page || !auditType || !status) return adminError(reply, user, 400, '감사 저장 오류', '문서, 감사 유형, 상태를 확인해 주세요.', '/admin/audits', '감사 허브');
  await exec(
    `INSERT INTO content_audits (page_id, audit_type, status, note, audited_by, audited_at, created_at)
     VALUES (:pageId, :auditType, :status, :note, :userId, IF(:status='pending', NULL, NOW()), NOW())`,
    { pageId: page.id, auditType, status, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  return reply.redirect('/admin/audits');
});

app.post('/admin/audits/search', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const searchQuery = boundedText(body.query, 255);
  if (!searchQuery) return adminError(reply, user, 400, '검색 감사 오류', '검색어를 입력해 주세요.', '/admin/audits', '감사 허브');
  const expectedPage = await searchTargetPageFromBody(body, ['expectedPageRef', 'expectedPageId']);
  const results = await searchPages(searchQuery, 5);
  const passed = expectedPage ? results[0]?.page_id === expectedPage.id : results.length > 0;
  const status = passed ? 'passed' : results.length === 0 ? 'needs_alias' : 'bad_ranking';
  await exec(
    `INSERT INTO search_audits (query, expected_page_id, status, note, audited_by, audited_at, created_at)
     VALUES (:query, :expectedPageId, :status, :note, :userId, NOW(), NOW())`,
    { query: searchQuery, expectedPageId: expectedPage?.id ?? null, status, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  if (status !== 'passed') {
    await exec(
      `INSERT INTO contributor_tasks (task_type, target_type, title, description, priority, created_by, created_at, updated_at)
       VALUES ('fix_search_alias', 'search_term', :title, :description, 'high', :userId, NOW(), NOW())`,
      { title: `"${searchQuery}" 검색 감사 처리`, description: `검색 감사 상태: ${status}`, userId: user?.id ?? null }
    );
  }
  return reply.redirect('/admin/audits');
});

app.post('/admin/audits/security', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const testKey = boundedKey(body.testKey, 128);
  const status = normalizeSecurityTestStatus(body.status ?? 'pending');
  const severity = normalizeIssueSeverity(body.severity);
  if (!testKey || !status) return adminError(reply, user, 400, '보안 점검 오류', '테스트 키와 상태를 확인해 주세요.', '/admin/audits', '감사 허브');
  await exec(
    `INSERT INTO security_test_runs (test_key, status, severity, note, tested_by, tested_at, created_at)
     VALUES (:testKey, :status, :severity, :note, :userId, IF(:status='pending', NULL, NOW()), NOW())`,
    { testKey, status, severity, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  return reply.redirect('/admin/audits');
});

app.post('/admin/audits/performance', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const checkKey = boundedKey(body.checkKey, 128);
  const targetArea = normalizePerformanceTargetArea(body.targetArea ?? 'page');
  const status = normalizePerformanceCheckStatus(body.status ?? 'pending');
  if (!checkKey || !targetArea || !status) return adminError(reply, user, 400, '성능 점검 오류', '체크 키, 영역, 상태를 확인해 주세요.', '/admin/audits', '감사 허브');
  await exec(
    `INSERT INTO performance_checks (check_key, target_area, status, note, checked_by, checked_at, created_at)
     VALUES (:checkKey, :targetArea, :status, :note, :userId, IF(:status='pending', NULL, NOW()), NOW())`,
    { checkKey, targetArea, status, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  return reply.redirect('/admin/audits');
});

app.post('/admin/audits/consistency', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const result = await runConsistencyChecks(Boolean(body.autoFix));
  await logAdmin(user?.id ?? null, 'consistency.run', 'audit', null, { autoFix: Boolean(body.autoFix), result });
  return reply.redirect('/admin/audits');
});

app.post('/admin/audits/user-trust/:id/evaluate', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const userId = nullablePositiveInt((request.params as any).id);
  if (!userId) return adminError(reply, user, 400, '사용자 재평가 오류', '사용자를 찾을 수 없습니다.', '/admin/audits', '감사 허브');
  await evaluateUserTrust(userId);
  return reply.redirect('/admin/audits');
});

async function adminAuditHubData() {
  const [contentAudits, searchAudits, securityTests, permissionAudits, performanceChecks, userTrust] = await Promise.all([
    query<any>(
      `SELECT ca.id, ca.page_id, ca.audit_type, ca.status, ca.note, ca.audited_by, ca.audited_at, ca.created_at,
              p.title, p.display_title, n.code AS namespace_code
       FROM content_audits ca
       LEFT JOIN pages p ON p.id=ca.page_id
       LEFT JOIN namespaces n ON n.id=p.namespace_id
       ORDER BY FIELD(ca.status,'failed','needs_fix','pending','passed'), ca.id DESC LIMIT 100`
    ),
    query<any>(
      `SELECT sa.id, sa.query, sa.expected_page_id, sa.status, sa.note, sa.audited_by, sa.audited_at, sa.created_at,
              p.title AS expected_title, p.display_title AS expected_display_title, n.code AS expected_namespace_code
       FROM search_audits sa
       LEFT JOIN pages p ON p.id=sa.expected_page_id
       LEFT JOIN namespaces n ON n.id=p.namespace_id
       ORDER BY FIELD(sa.status,'pending','needs_alias','needs_page','bad_ranking','passed'), sa.id DESC LIMIT 100`
    ),
    query<any>(`SELECT id, test_key, status, severity, note, tested_by, tested_at, created_at FROM security_test_runs ORDER BY FIELD(severity,'critical','high','medium','low'), id DESC LIMIT 100`),
    query<any>(`SELECT ${permissionAuditFields} FROM permission_audits ORDER BY FIELD(status,'failed','pending','passed'), id DESC LIMIT 100`),
    query<any>(`SELECT ${performanceCheckFields} FROM performance_checks ORDER BY FIELD(status,'failed','needs_work','pending','passed'), id DESC LIMIT 100`),
    query<any>(
      `SELECT u.id, u.username, u.display_name, COALESCE(ut.trust_level,'new') trust_level, ut.good_edits, ut.reports_received, ut.filter_hits, ut.last_evaluated_at
       FROM users u LEFT JOIN user_trust ut ON ut.user_id=u.id
       ORDER BY FIELD(COALESCE(ut.trust_level,'new'),'restricted','new','normal','autoconfirmed','trusted'), u.id DESC LIMIT 100`
    )
  ]);
  return { contentAudits, searchAudits, securityTests, permissionAudits, performanceChecks, userTrust };
}

app.get('/admin/search', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  const [failed, noClicks, pins, disambiguations, dictionary, aliases] = await Promise.all([
    failedSearches(100),
    noClickSearches(100),
    query<any>(
      `SELECT sp.id, sp.query, sp.page_id, sp.note, sp.enabled, sp.created_by, sp.created_at, p.title, n.code AS namespace_code
       FROM search_pins sp
       JOIN pages p ON p.id=sp.page_id
       JOIN namespaces n ON n.id=p.namespace_id
       ORDER BY sp.enabled DESC, sp.query ASC, sp.id DESC LIMIT 100`
    ),
    query<any>(
      `SELECT sdc.id, sdc.query, sdc.normalized_query, sdc.page_id, sdc.label, sdc.note, sdc.weight, sdc.enabled, sdc.created_by, sdc.created_at, p.title, n.code AS namespace_code
       FROM search_disambiguation_candidates sdc
       JOIN pages p ON p.id=sdc.page_id
       JOIN namespaces n ON n.id=p.namespace_id
       ORDER BY sdc.enabled DESC, sdc.query ASC, sdc.weight DESC, sdc.id DESC LIMIT 100`
    ),
    query<any>(
      `SELECT sd.id, sd.term, sd.normalized, sd.normalized_term, sd.replacement, sd.action, sd.target_page_id, sd.term_type, sd.weight, sd.enabled, sd.note, sd.created_by, sd.created_at, p.title, n.code AS namespace_code
       FROM search_dictionary sd
       LEFT JOIN pages p ON p.id=sd.target_page_id
       LEFT JOIN namespaces n ON n.id=p.namespace_id
       ORDER BY sd.enabled DESC, sd.id DESC LIMIT 100`
    ),
    query<any>(
      `SELECT pa.id, pa.alias_title, pa.alias_type, pa.created_at,
              ans.code AS alias_namespace_code,
              tp.id AS target_page_id, tp.title AS target_title, tns.code AS target_namespace_code
       FROM page_aliases pa
       JOIN namespaces ans ON ans.id=pa.namespace_id
       JOIN pages tp ON tp.id=pa.target_page_id
       JOIN namespaces tns ON tns.id=tp.namespace_id
       ORDER BY pa.id DESC LIMIT 100`
    )
  ]);
  return reply.type('text/html').send(adminSearchPage({ failed, noClicks, pins, disambiguations, dictionary, aliases }, user));
});

app.post('/admin/search/no-click-tasks', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '검색 운영 권한이 필요합니다.', '/login', '로그인');
  await enqueueNoClickSearchTasks(100);
  return reply.redirect('/admin/search');
});

app.post('/admin/search/pins', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '검색 운영 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const page = await searchTargetPageFromBody(body, ['pageRef', 'pageId']);
  const searchQuery = normalizeTitle(body.query ?? '');
  if (!searchQuery) return adminError(reply, user, 400, '검색어 필요', '고정할 검색어를 입력하세요.', '/admin/search', '검색 운영');
  if (!page) return adminError(reply, user, 400, '문서 확인 필요', '고정할 문서를 제목 또는 번호로 입력하세요.', '/admin/search', '검색 운영');
  await exec(
    `INSERT INTO search_pins (query, page_id, note, created_by, created_at)
     VALUES (:query, :pageId, :note, :userId, NOW())
     ON DUPLICATE KEY UPDATE enabled=1, note=VALUES(note)`,
    { query: searchQuery, pageId: Number(page.id), note: body.note ?? null, userId: user?.id ?? null }
  );
  return reply.redirect('/admin/search');
});

app.post('/admin/search/disambiguations', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '검색 운영 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const page = await searchTargetPageFromBody(body, ['pageRef', 'pageId']);
  const searchQuery = normalizeTitle(body.query ?? '');
  if (!searchQuery) return adminError(reply, user, 400, '검색어 필요', '동음이의 후보를 연결할 검색어를 입력하세요.', '/admin/search', '검색 운영');
  if (!page) return adminError(reply, user, 400, '문서 확인 필요', '후보 문서를 제목 또는 번호로 입력하세요.', '/admin/search', '검색 운영');
  await exec(
    `INSERT INTO search_disambiguation_candidates (query, normalized_query, page_id, label, note, weight, enabled, created_by, created_at)
     VALUES (:query, :normalized, :pageId, :label, :note, :weight, 1, :userId, NOW())
     ON DUPLICATE KEY UPDATE normalized_query=VALUES(normalized_query), label=VALUES(label), note=VALUES(note), weight=VALUES(weight), enabled=1`,
    {
      query: searchQuery,
      normalized: normalizeSearch(searchQuery),
      pageId: Number(page.id),
      label: body.label || null,
      note: body.note || null,
      weight: nullablePositiveInt(body.weight) ?? 100,
      userId: user?.id ?? null
    }
  );
  return reply.redirect('/admin/search');
});

app.post('/admin/search/dictionary', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '검색 운영 권한이 필요합니다.', '/login', '로그인');
  const result = await upsertSearchDictionary(request.body as any, user?.id ?? null);
  if (!result.ok) return adminError(reply, user, 400, '검색 사전 오류', result.error === 'target_not_found' ? '대상 문서를 찾을 수 없습니다.' : '검색어와 처리 방식을 확인하세요.', '/admin/search', '검색 운영');
  return reply.redirect('/admin/search');
});

app.post('/admin/search/aliases', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle') && !can(user, 'page.move')) return adminError(reply, user, 403, '권한 없음', '검색 별칭 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const page = await searchTargetPageFromBody(body, ['targetPageRef', 'targetPageId', 'pageRef']);
  if (!page) return adminError(reply, user, 400, '별칭 저장 오류', '대상 문서를 제목 또는 번호로 입력해 주세요.', '/admin/search', '검색 운영');
  if (!(await aclDecision(aclActorForRequest(request), 'move', page)).allowed) return adminError(reply, user, 403, '권한 없음', '이 문서에 별칭을 추가할 권한이 없습니다.', '/admin/search', '검색 운영');
  const namespace = normalizeEditableNamespace(body.namespace ?? page.namespace_code) ?? page.namespace_code;
  const aliasTitle = normalizeTitle(body.aliasTitle);
  if (!aliasTitle) return adminError(reply, user, 400, '별칭 저장 오류', '별칭 제목을 입력해 주세요.', '/admin/search', '검색 운영');
  const aliasType = normalizeAliasType(body.aliasType);
  await addPageAlias(namespace, aliasTitle, Number(page.id), aliasType);
  await logAdmin(user?.id ?? null, 'search_alias.create', 'page', Number(page.id), { namespace, aliasTitle, aliasType });
  return reply.redirect('/admin/search');
});

app.get('/admin/filters', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  const filters = await editFilterRows();
  return reply.type('text/html').send(adminEditFiltersPage(filters, user));
});

app.post('/admin/filters', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '편집 필터 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const name = boundedText(body.name, 255);
  const filterType = normalizeEditFilterType(body.filterType ?? 'keyword');
  const action = normalizeEditFilterAction(body.action ?? 'warn');
  if (!name || !filterType || !action) return adminError(reply, user, 400, '필터 저장 오류', '필터 이름, 종류, 처리 방식을 확인해 주세요.', '/admin/filters', '편집 필터');
  await exec(
    `INSERT INTO edit_filters (name, description, filter_type, pattern, action, enabled, created_by, created_at, updated_at)
     VALUES (:name, :description, :filterType, :pattern, :action, :enabled, :userId, NOW(), NOW())`,
    {
      name,
      description: boundedText(body.description, 1000) || null,
      filterType,
      pattern: boundedText(body.pattern, 5000) || null,
      action,
      enabled: body.enabled ? 1 : 0,
      userId: user?.id ?? null
    }
  );
  await logAdmin(user?.id ?? null, 'edit_filter.create', 'edit_filter', null, { name, filterType, action });
  return reply.redirect('/admin/filters');
});

app.post('/admin/filters/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '편집 필터 관리 권한이 필요합니다.', '/login', '로그인');
  const filterId = nullablePositiveInt((request.params as any).id);
  const body = request.body as any;
  const name = boundedText(body.name, 255);
  const filterType = normalizeEditFilterType(body.filterType);
  const action = normalizeEditFilterAction(body.action);
  if (!filterId || !name || !filterType || !action) return adminError(reply, user, 400, '필터 저장 오류', '필터 번호, 이름, 종류, 처리 방식을 확인해 주세요.', '/admin/filters', '편집 필터');
  const result = await exec(
    `UPDATE edit_filters
     SET name=:name, description=:description, filter_type=:filterType, pattern=:pattern, action=:action, enabled=:enabled, updated_at=NOW()
     WHERE id=:id`,
    {
      id: filterId,
      name,
      description: boundedText(body.description, 1000) || null,
      filterType,
      pattern: boundedText(body.pattern, 5000) || null,
      action,
      enabled: body.enabled ? 1 : 0
    }
  );
  if (Number(result.affectedRows ?? 0) === 0) return adminError(reply, user, 404, '필터 없음', '편집 필터를 찾을 수 없습니다.', '/admin/filters', '편집 필터');
  await logAdmin(user?.id ?? null, 'edit_filter.update', 'edit_filter', filterId, { name, filterType, action, enabled: body.enabled ? 1 : 0 });
  return reply.redirect('/admin/filters');
});

async function editFilterRows() {
  return query<any>(
    `SELECT ef.id, ef.name, ef.description, ef.filter_type, ef.pattern, ef.action, ef.enabled, ef.created_by, ef.created_at, ef.updated_at,
            u.username AS created_username, u.display_name AS created_display_name,
            (SELECT COUNT(*) FROM edit_filter_hits efh WHERE efh.filter_id=ef.id) AS hit_count
     FROM edit_filters ef
     LEFT JOIN users u ON u.id=ef.created_by
     ORDER BY ef.enabled DESC, FIELD(ef.action,'block_save','require_review','warn','tag'), ef.id DESC`
  );
}

app.get('/beta', async (request, reply) => {
  const queryParams = (request.query ?? {}) as any;
  const status = await publicOpenBetaStatus();
  return reply.type('text/html').send(openBetaPage({ ...status, feedback: queryParams.feedback, issue: queryParams.issue }, (request as any).user));
});

app.post('/beta/feedback', async (request, reply) => {
  return createBetaFeedback(request, reply, true);
});

app.post('/beta/issues', async (request, reply) => {
  return createBetaIssue(request, reply, true);
});

app.get('/api/pages/:id', async (request, reply) => {
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  return publicPageResource(page);
});
app.get('/api/pages/by-title', async (request, reply) => {
  const q = request.query as any;
  const namespace = normalizeEditableNamespace(q.namespace ?? 'main');
  const title = normalizeTitle(q.title);
  if (!namespace) return reply.code(400).send({ error: 'invalid_namespace' });
  if (!title) return reply.code(400).send({ error: 'title_required' });
  const page = await getPageByTitle(namespace, title);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  return publicPageResource(page);
});
app.get('/api/pages/:id/revisions', async (request, reply) => {
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  if (!(await aclDecision(aclActorForRequest(request), 'history', page)).allowed) return reply.code(404).send({ error: 'not_found' });
  return pageRevisions(pageId, canViewRestrictedRevisions((request as any).user), canViewSuppressedRevisions((request as any).user));
});
app.get('/api/pages/:id/revisions/:revisionId', async (request, reply) => {
  const params = request.params as any;
  const pageId = nullablePositiveInt(params.id);
  const revisionId = nullablePositiveInt(params.revisionId);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  if (!revisionId) return reply.code(400).send({ error: 'invalid_revision_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  if (!(await aclDecision(aclActorForRequest(request), 'history', page)).allowed) return reply.code(404).send({ error: 'not_found' });
  const revision = await pageRevision(pageId, revisionId, canViewRestrictedRevisions((request as any).user), canViewSuppressedRevisions((request as any).user));
  if (!revision) return reply.code(404).send({ error: 'not_found' });
  return revision;
});
app.get('/api/revisions/:revisionId', async (request, reply) => {
  const aclActor = aclActorForRequest(request);
  const includeDeleted = canViewRestrictedRevisions((request as any).user);
  const revisionId = nullablePositiveInt((request.params as any).revisionId);
  if (!revisionId) return reply.code(400).send({ error: 'invalid_revision_id' });
  const revision = await pageRevisionById(revisionId, canViewRestrictedRevisions((request as any).user), canViewSuppressedRevisions((request as any).user), includeDeleted);
  if (!revision) return reply.code(404).send({ error: 'not_found' });
  const page = await getPageById(Number(revision.page_id));
  if (!(await canReadPageResource(aclActor, page))) return reply.code(404).send({ error: 'not_found' });
  if (!(await aclDecision(aclActor, 'history', page)).allowed) return reply.code(404).send({ error: 'not_found' });
  return revision;
});
app.get('/api/revisions/:revisionId/render', async (request, reply) => {
  const aclActor = aclActorForRequest(request);
  const includeDeleted = canViewRestrictedRevisions((request as any).user);
  const revisionId = nullablePositiveInt((request.params as any).revisionId);
  if (!revisionId) return reply.code(400).send({ error: 'invalid_revision_id' });
  const revision = await pageRevisionById(revisionId, canViewRestrictedRevisions((request as any).user), canViewSuppressedRevisions((request as any).user), includeDeleted);
  if (!revision) return reply.code(404).send({ error: 'not_found' });
  const page = await getPageAtRevision(Number(revision.page_id), Number(revision.id), canViewRestrictedRevisions((request as any).user), canViewSuppressedRevisions((request as any).user), includeDeleted && String(revision.page_status ?? '') === 'deleted');
  if (!page) return reply.code(404).send({ error: 'not_found' });
  if (!(await canReadPageResource(aclActor, page))) return reply.code(404).send({ error: 'not_found' });
  if (!(await aclDecision(aclActor, 'history', page)).allowed) return reply.code(404).send({ error: 'not_found' });
  return { revisionId: Number(revision.id), pageId: Number(revision.page_id), html: page.html ?? '', toc: page.toc_json ? JSON.parse(page.toc_json) : [] };
});
app.get('/api/pages/:id/diff', async (request, reply) => {
  const params = request.params as any;
  const q = request.query as any;
  const pageId = nullablePositiveInt(params.id);
  const fromRevisionId = nullablePositiveInt(q.from);
  const toRevisionId = nullablePositiveInt(q.to);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  if (!fromRevisionId || !toRevisionId) return reply.code(400).send({ error: 'invalid_revision_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  if (!(await aclDecision(aclActorForRequest(request), 'history', page)).allowed) return reply.code(404).send({ error: 'not_found' });
  const diff = await diffRevisions(pageId, fromRevisionId, toRevisionId, canViewRestrictedRevisions((request as any).user), canViewSuppressedRevisions((request as any).user));
  if (!diff) return reply.code(404).send({ error: 'not_found' });
  return diff;
});
app.get('/api/pages/:id/links', async (request, reply) => {
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  return pageLinks(pageId);
});
app.get('/api/pages/:id/categories', async (request, reply) => {
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  return pageCategories(pageId);
});
app.get('/api/pages/:id/sections/:anchor', async (request, reply) => {
  const params = request.params as any;
  const pageId = nullablePositiveInt(params.id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  const section = await getSection(pageId, params.anchor);
  if (!section) return reply.code(404).send({ error: 'not_found' });
  return section;
});
app.get('/api/pages/:id/section-locks', async (request, reply) => {
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  return sectionLocks(pageId);
});
app.post('/api/admin/pages/:id/section-locks', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'page.protect')) return reply.code(403).send({ error: 'forbidden' });
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const body = request.body as any;
  const section = await getSection(pageId, String(body.anchor ?? ''));
  if (!section) return reply.code(404).send({ error: 'section_not_found' });
  const lockType = normalizeSectionLockType(body.lockType) ?? 'admin_only';
  await exec(
    `INSERT INTO page_section_locks (page_id, anchor, heading, lock_type, owner_group, reason, created_by, created_at, updated_at)
     VALUES (:pageId, :anchor, :heading, :lockType, :ownerGroup, :reason, :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE heading=VALUES(heading), lock_type=VALUES(lock_type), owner_group=VALUES(owner_group), reason=VALUES(reason), updated_at=NOW()`,
    {
      pageId,
      anchor: section.anchor,
      heading: section.title,
      lockType,
      ownerGroup: body.ownerGroup || null,
      reason: body.reason || null,
      userId: user?.id ?? null
    }
  );
  await logAdmin(user?.id ?? null, 'section.lock', 'page', pageId, { anchor: section.anchor, lockType });
  return { ok: true };
});
app.delete('/api/admin/pages/:id/section-locks/:anchor', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'page.protect')) return reply.code(403).send({ error: 'forbidden' });
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  await exec(`DELETE FROM page_section_locks WHERE page_id=:pageId AND anchor=:anchor`, {
    pageId,
    anchor: (request.params as any).anchor
  });
  await logAdmin(user?.id ?? null, 'section.unlock', 'page', pageId, { anchor: (request.params as any).anchor });
  return { ok: true };
});
app.post('/admin/pages/:id/section-locks', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'page.protect')) return adminError(reply, user, 403, '권한 없음', '문단 잠금 권한이 필요합니다.', '/login', '로그인');
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return adminError(reply, user, 400, '입력 오류', '문서 번호가 올바르지 않습니다.', '/admin');
  const page = await getPageById(pageId);
  if (!page) return adminError(reply, user, 404, '문서 없음', '문서를 찾을 수 없습니다.', '/admin');
  const body = request.body as any;
  const section = await getSection(pageId, String(body.anchor ?? ''));
  if (!section) return adminError(reply, user, 404, '문단 없음', '문단을 찾을 수 없습니다.', wikiUrl(page.namespace_code, page.title), '문서 보기');
  const lockType = normalizeSectionLockType(body.lockType) ?? 'admin_only';
  await exec(
    `INSERT INTO page_section_locks (page_id, anchor, heading, lock_type, owner_group, reason, created_by, created_at, updated_at)
     VALUES (:pageId, :anchor, :heading, :lockType, :ownerGroup, :reason, :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE heading=VALUES(heading), lock_type=VALUES(lock_type), owner_group=VALUES(owner_group), reason=VALUES(reason), updated_at=NOW()`,
    { pageId, anchor: section.anchor, heading: section.title, lockType, ownerGroup: body.ownerGroup || null, reason: body.reason || null, userId: user?.id ?? null }
  );
  await logAdmin(user?.id ?? null, 'section.lock', 'page', pageId, { anchor: section.anchor, lockType });
  return reply.redirect(wikiUrl(page.namespace_code, page.title));
});
app.post('/admin/pages/:id/section-locks/:anchor/unlock', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'page.protect')) return adminError(reply, user, 403, '권한 없음', '문단 잠금 권한이 필요합니다.', '/login', '로그인');
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return adminError(reply, user, 400, '입력 오류', '문서 번호가 올바르지 않습니다.', '/admin');
  const page = await getPageById(pageId);
  if (!page) return adminError(reply, user, 404, '문서 없음', '문서를 찾을 수 없습니다.', '/admin');
  await exec(`DELETE FROM page_section_locks WHERE page_id=:pageId AND anchor=:anchor`, {
    pageId: page.id,
    anchor: (request.params as any).anchor
  });
  await logAdmin(user?.id ?? null, 'section.unlock', 'page', Number(page.id), { anchor: (request.params as any).anchor });
  return reply.redirect(wikiUrl(page.namespace_code, page.title));
});

app.post('/api/pages', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).send({ error: 'login_required' });
  if (!consumeActorRateLimit(request, 'api-page-edit', 30, 90, 60 * 60 * 1000)) return reply.code(429).send({ error: 'rate_limited' });
  const body = request.body as any;
  const content = limitedText(body.content, maxPageContentLength);
  if (content === null) return reply.code(413).send({ error: 'content_too_large', maxLength: maxPageContentLength });
  const baseRevisionId = body.baseRevisionId ? nullablePositiveInt(body.baseRevisionId) : null;
  if (body.baseRevisionId && !baseRevisionId) return reply.code(400).send({ error: 'invalid_base_revision_id' });
  try {
    await enforceOpenBetaEditPolicy(user.id, content);
    const namespace = normalizeEditableNamespace(body.namespace ?? 'main');
    if (!namespace) return reply.code(400).send({ error: 'invalid_namespace' });
    const title = normalizeTitle(body.title);
    if (!title) return reply.code(400).send({ error: 'title_required' });
    if (namespace === 'main' && isUserWikiTitle(title) && !(await canEditUserWikiTitle(user, title))) {
      return reply.code(403).send({ error: 'user_wiki_forbidden' });
    }
    const existing = await getPageByTitle(namespace, title);
    if (existing && baseRevisionId && Number(existing.current_revision_id) !== baseRevisionId) {
      return reply.code(409).send({
        error: 'edit_conflict',
        currentRevisionId: Number(existing.current_revision_id),
        submittedBaseRevisionId: baseRevisionId,
        page: {
          id: Number(existing.id),
          namespace: existing.namespace_code,
          title: existing.title
        },
        conflict: {
          currentContentSize: Buffer.byteLength(String(existing.content_raw ?? ''), 'utf8'),
          submittedContentSize: Buffer.byteLength(content, 'utf8')
        }
      });
    }
    const access = existing ? await pageEditAccess(user, existing) : { allowed: true, forceReviewReason: null as string | null };
    if (!access.allowed) return reply.code(403).send({ error: 'forbidden' });
    if (existing) await assertLockedSectionsUnchanged(existing, content, user);
    const subwikiPolicy = await subwikiEditPolicy(namespace, title, user);
    if (!subwikiPolicy.allowed) return reply.code(403).send({ error: 'subwiki_public_edit_disabled' });
    const mainPageReview = namespace === 'main' && title === '대문' ? '대문 고위험 문서 검토 정책' : null;
    const result = await savePage({
      namespace,
      title,
      content,
      summary: boundedText(body.summary, 255) || undefined,
      userId: (request as any).user?.id ?? null,
      pageType: normalizeSavedPageType(body.pageType),
      baseRevisionId,
      isMinor: parseBoolean(body.isMinor),
      forceReviewReason: [access.forceReviewReason, subwikiPolicy.forceReviewReason, mainPageReview].filter(Boolean).join(' / ') || null
    });
    return reply.code(201).send(result);
  } catch (error: any) {
    return reply.code(400).send({ error: 'save_failed', message: error.message });
  }
});

app.put('/api/pages/:id', async (request, reply) => {
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!page) return reply.code(404).send({ error: 'not_found' });
  const user = (request as any).user;
  const aclActor = aclActorForRequest(request);
  if (!user) return reply.code(403).send({ error: 'login_required' });
  if (!consumeActorRateLimit(request, 'api-page-edit', 30, 90, 60 * 60 * 1000)) return reply.code(429).send({ error: 'rate_limited' });
  if (!(await canReadPageResource(aclActor, page))) return reply.code(404).send({ error: 'not_found' });
  const access = await pageEditAccess(aclActor, page);
  if (!access.allowed) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const content = limitedText(body.content, maxPageContentLength);
  if (content === null) return reply.code(413).send({ error: 'content_too_large', maxLength: maxPageContentLength });
  const baseRevisionId = body.baseRevisionId ? nullablePositiveInt(body.baseRevisionId) : 0;
  if (body.baseRevisionId && !nullablePositiveInt(body.baseRevisionId)) return reply.code(400).send({ error: 'invalid_base_revision_id' });
  if (baseRevisionId && Number(page.current_revision_id) !== baseRevisionId) {
    return reply.code(409).send({
      error: 'edit_conflict',
      currentRevisionId: Number(page.current_revision_id),
      submittedBaseRevisionId: baseRevisionId,
      page: {
        id: Number(page.id),
        namespace: page.namespace_code,
        title: page.title
      },
      conflict: {
        currentContentSize: Buffer.byteLength(String(page.content_raw ?? ''), 'utf8'),
        submittedContentSize: Buffer.byteLength(content, 'utf8')
      }
    });
  }
  try {
    await enforceOpenBetaEditPolicy(user.id, content);
    const targetNamespace = page.namespace_code as NamespaceCode;
    const targetTitle = normalizeTitle(body.title ?? page.title);
    const existingUserWikiTitle = targetNamespace === 'main' && isUserWikiTitle(page.title) ? String(page.title) : '';
    if (existingUserWikiTitle && normalizeTitle(targetTitle) !== normalizeTitle(existingUserWikiTitle)) {
      return reply.code(403).send({ error: 'user_wiki_title_locked' });
    }
    if ((existingUserWikiTitle || (targetNamespace === 'main' && isUserWikiTitle(targetTitle))) && !(await canEditUserWikiTitle(user, existingUserWikiTitle || targetTitle))) {
      return reply.code(403).send({ error: 'user_wiki_forbidden' });
    }
    const [newUserReason, subwikiPolicy] = await Promise.all([
      newUserReviewReason(user.id),
      subwikiEditPolicy(targetNamespace, targetTitle, user)
    ]);
    if (!subwikiPolicy.allowed) return reply.code(403).send({ error: 'subwiki_public_edit_disabled' });
    const forceReviewReason = [newUserReason, subwikiPolicy.forceReviewReason, access.forceReviewReason].filter(Boolean).join(' / ') || null;
    await assertLockedSectionsUnchanged(page, content, user);
    return await savePage({
      namespace: targetNamespace,
      title: targetTitle,
      content,
      summary: boundedText(body.summary, 255) || undefined,
      userId: (request as any).user?.id ?? null,
      pageType: normalizeSavedPageType(body.pageType) ?? page.page_type,
      baseRevisionId,
      isMinor: parseBoolean(body.isMinor),
      forceReviewReason
    });
  } catch (error: any) {
    return reply.code(400).send({ error: 'save_failed', message: error.message });
  }
});

app.post('/api/pages/:id/preview', async (request, reply) => {
  if (!consumeActorRateLimit(request, 'page-preview', 120, 300, 15 * 60 * 1000)) return reply.code(429).send({ error: 'rate_limited' });
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'not_found' });
  const body = request.body as any;
  const content = limitedText(body.content, maxPreviewContentLength);
  if (content === null) return reply.code(413).send({ error: 'content_too_large', maxLength: maxPreviewContentLength });
  return previewMarkupResponse(content);
});

app.post('/api/preview', async (request, reply) => {
  if (!consumeActorRateLimit(request, 'page-preview', 120, 300, 15 * 60 * 1000)) return reply.code(429).send({ error: 'rate_limited' });
  const body = request.body as any;
  const content = limitedText(body.content, maxPreviewContentLength);
  if (content === null) return reply.code(413).send({ error: 'content_too_large', maxLength: maxPreviewContentLength });
  return previewMarkupResponse(content);
});

async function previewMarkupResponse(content: string) {
  const parsed = parseMarkup(content);
  const brokenLinks = [];
  for (const link of parsed.links.slice(0, 40)) {
    const target = parseLinkTarget(link);
    const exists = await getPageByTitle(target.namespace, target.title);
    if (!exists) brokenLinks.push(link);
  }
  const missingLinks = new Set(brokenLinks.map((link) => wikiLinkKey(link)));
  const files = await fileRenderMap(parsed.ast);
  const officialAreas = await officialAreaMap(parsed.components);
  const hasDocumentStatus = parsed.components.some((component) => component.name === 'document_status');
  const hasInfoBox = parsed.components.some((component) => ['mob_info', 'item_info', 'block_info', 'mod_info', 'server_info', 'api_info', 'packet_info'].includes(component.name));
  const inspection = [
    { key: 'status', label: '문서 상태', ok: hasDocumentStatus, detail: hasDocumentStatus ? '문서 상태 컴포넌트가 있습니다.' : '문서 상태 컴포넌트가 필요합니다.' },
    { key: 'category', label: '분류', ok: parsed.categories.length > 0, detail: parsed.categories.length ? `${parsed.categories.length}개 분류` : '분류가 없습니다.' },
    { key: 'infobox', label: '정보상자', ok: hasInfoBox, detail: hasInfoBox ? '문서 유형 정보상자가 있습니다.' : '몹/아이템/블록/모드/서버/API 정보상자가 필요합니다.' },
    { key: 'links', label: '내부 링크', ok: parsed.links.length > 0, detail: parsed.links.length ? `${parsed.links.length}개 링크` : '관련 문서 링크가 없습니다.' },
    { key: 'brokenLinks', label: '깨진 링크', ok: brokenLinks.length === 0, detail: brokenLinks.length ? brokenLinks.slice(0, 5).join(', ') : '깨진 링크가 없습니다.' },
    { key: 'blocking', label: '저장 차단', ok: parsed.blockingErrors.length === 0, detail: parsed.blockingErrors.length ? parsed.blockingErrors.join(', ') : '차단 오류가 없습니다.' }
  ];
  return { html: renderDocument(parsed.ast, { missingLinks, files, officialAreas }), diagnostics: [...parsed.errors, ...parsed.blockingErrors], inspection, ast: parsed.ast, links: parsed.links, categories: parsed.categories, brokenLinks };
}

app.put('/api/pages/:id/sections/:anchor', async (request, reply) => {
  const user = (request as any).user;
  const aclActor = aclActorForRequest(request);
  if (!user) return reply.code(403).send({ error: 'login_required' });
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!page) return reply.code(404).send({ error: 'not_found' });
  if (!(await canReadPageResource(aclActor, page))) return reply.code(404).send({ error: 'not_found' });
  if (!(await canEditPageResource(aclActor, page))) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const content = limitedText(body.content, maxPageContentLength);
  if (content === null) return reply.code(413).send({ error: 'content_too_large', maxLength: maxPageContentLength });
  try {
    await enforceOpenBetaEditPolicy(user.id, content);
    const subwikiPolicy = await subwikiEditPolicy(page.namespace_code, page.title, user);
    if (!subwikiPolicy.allowed) return reply.code(403).send({ error: 'subwiki_public_edit_disabled' });
    if (subwikiPolicy.forceReviewReason) return reply.code(403).send({ error: 'section_review_required', message: '이 위키는 공개 편집 검토가 필요하므로 전체 문서 편집을 사용하세요.' });
    await assertSectionEditAllowed(page, (request.params as any).anchor, user);
    const baseRevisionId = nullablePositiveInt(body.baseRevisionId);
    if (!baseRevisionId) return reply.code(400).send({ error: 'invalid_base_revision_id' });
    return await saveSection(pageId, (request.params as any).anchor, content, baseRevisionId, user.id);
  } catch (error: any) {
    if (error.message === 'edit_conflict') return reply.code(409).send({ error: 'edit_conflict' });
    return reply.code(400).send({ error: error.message });
  }
});

app.post('/api/pages/:id/move', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'page.move')) return reply.code(403).send({ error: 'forbidden' });
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!page) return reply.code(404).send({ error: 'not_found' });
  if (!(await aclDecision(user, 'move', page)).allowed) return reply.code(403).send({ error: 'acl_denied' });
  const body = request.body as any;
  const namespace = normalizeEditableNamespace(body.namespace ?? 'main');
  if (!namespace) return reply.code(400).send({ error: 'invalid_namespace' });
  const title = normalizeTitle(body.title);
  if (!title) return reply.code(400).send({ error: 'title_required' });
  await movePage(pageId, namespace, title, user?.id ?? null, boundedText(body.reason, 255) || null);
  return { ok: true };
});

app.post('/api/admin/pages/:id/split-section', async (request, reply) => {
  const user = (request as any).user;
  try {
    return await splitSectionAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
});

app.post('/admin/pages/:id/split-section', async (request, reply) => {
  const user = (request as any).user;
  try {
    const result = await splitSectionAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
    return reply.redirect(result.href);
  } catch (error: any) {
    return adminError(reply, user, error?.statusCode ?? 400, '문단 분리 오류', String(error?.message ?? '문단을 분리할 수 없습니다.'), '/wiki', '문서로 돌아가기');
  }
});

app.post('/api/admin/pages/:id/merge', async (request, reply) => {
  const user = (request as any).user;
  try {
    return await mergePageAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
});

app.post('/admin/pages/:id/merge', async (request, reply) => {
  const user = (request as any).user;
  try {
    const result = await mergePageAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
    return reply.redirect(result.href);
  } catch (error: any) {
    return adminError(reply, user, error?.statusCode ?? 400, '문서 병합 오류', String(error?.message ?? '문서를 병합할 수 없습니다.'), '/wiki', '문서로 돌아가기');
  }
});

app.post('/api/pages/:id/protect', async (request, reply) => {
  const user = (request as any).user;
  try {
    return await protectPageAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
});

app.delete('/api/pages/:id', async (request, reply) => {
  const user = (request as any).user;
  try {
    return await deletePageAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
});
app.post('/api/pages/:id/restore', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'page.restore')) return reply.code(403).send({ error: 'forbidden' });
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  await restorePage(pageId, user?.id ?? null);
  return { ok: true };
});
app.post('/api/pages/:id/rollback', async (request, reply) => {
  const user = (request as any).user;
  const pageId = nullablePositiveInt((request.params as any).id);
  const revisionId = nullablePositiveInt((request.body as any).revisionId);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  if (!revisionId) return reply.code(400).send({ error: 'invalid_revision_id' });
  const page = await getPageById(pageId);
  if (!page) return reply.code(404).send({ error: 'not_found' });
  if (!(await aclDecision(user, 'revert', page)).allowed) return reply.code(403).send({ error: 'forbidden' });
  const revision = await pageRevision(Number(page.id), revisionId, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user));
  if (!revision) return reply.code(404).send({ error: 'revision_not_found' });
  await assertLockedSectionsUnchanged(page, revision.content_raw ?? '', user);
  return rollbackToRevision(Number(page.id), Number(revision.id), user?.id ?? null);
});

app.get('/api/search', async (request) => {
  const aclActor = aclActorForRequest(request);
  const q = boundedText((request.query as any).q, 255);
  const space = String((request.query as any).space ?? '');
  if (!q) return [];
  const rows = await readableSearchRows(aclActor, await searchPages(q));
  if (q) await logSearchQuery(q, rows.length, (request as any).user?.id ?? null);
  return space ? rows.filter((row) => matchesSearchSpace(row, space)) : rows;
});
app.get('/api/search/suggest', async (request) => {
  const aclActor = aclActorForRequest(request);
  const q = boundedText((request.query as any).q, 255);
  const rows = await readableSearchRows(aclActor, await searchSuggestions(q, 20));
  return rows.slice(0, 8).map((row) => ({
    pageId: row.page_id,
    title: row.title,
    namespace: row.namespace_code,
    spaceId: row.space_id,
    spaceCode: row.space_code,
    spaceType: row.space_type,
    spaceTitle: row.space_title,
    url: wikiUrl(row.namespace_code, row.title),
    match: row.match_text,
    matchType: row.match_type,
    score: Number(row.score ?? 0)
  }));
});
app.get('/api/search/resolve', async (request) => {
  const aclActor = aclActorForRequest(request);
  const q = boundedText((request.query as any).q, 255);
  const space = String((request.query as any).space ?? '');
  const prefix = normalizeTitle(String((request.query as any).prefix ?? '')).replace(/^\/+|\/+$/g, '');
  if (!q) return { action: 'search', target: '/search', reason: 'no_query', candidates: [] };
  if (space || prefix) {
    const rows = (await readableSearchRows(aclActor, await searchPages(q, 30))).filter((row) => {
      if (space && !matchesSearchSpace(row, space)) return false;
      if (!prefix) return true;
      const title = normalizeTitle(row.title ?? '');
      const localPath = normalizeTitle(row.local_path ?? '');
      return title === prefix || title.startsWith(`${prefix}/`) || localPath === prefix || localPath.startsWith(`${prefix}/`);
    });
    const normalized = normalizeSearch(q);
    const exact = rows.filter((row) => normalizeSearch(row.title ?? '') === normalized || normalizeSearch(row.local_path ?? '') === normalized);
    if (exact.length === 1) return { action: 'redirect', target: wikiUrl(exact[0].namespace_code, exact[0].title), reason: 'scoped_exact' };
    return { action: 'search', target: `/search?q=${encodeURIComponent(q)}${space ? `&space=${encodeURIComponent(space)}` : ''}${prefix ? `&prefix=${encodeURIComponent(prefix)}` : ''}`, reason: exact.length > 1 ? 'ambiguous' : 'no_exact_match' };
  }
  return resolveSearchQueryForActor(q, aclActor);
});
app.post('/api/search/click', async (request, reply) => {
  const body = request.body as any;
  const queryText = boundedText(body.query, 255);
  const pageId = nullablePositiveInt(body.pageId);
  if (!queryText || !pageId || !(await canRecordSearchClick(pageId, aclActorForRequest(request)))) return reply.code(400).send({ error: 'invalid_click' });
  const queryLogId = await recordSearchClick(queryText, pageId, boundedPositiveInt(body.rankNo, 1000), (request as any).user?.id ?? null, nullablePositiveInt(body.queryLogId));
  return { ok: true, queryLogId };
});

type ComponentSchema = {
  label: string;
  fields: string[];
  required: string[];
  enums?: Record<string, string[]>;
  template: string;
};

const componentSchemas: Record<string, ComponentSchema> = {
  mob_info: {
    label: '몹 정보',
    fields: ['이름', '영문', '이미지', '분류', '체력', '공격력', '스폰', '드롭', '경험치', '에디션'],
    required: ['이름', '분류'],
    enums: { 에디션: ['Java Edition', 'Bedrock Edition', '둘 다'] },
    template: '{{몹 정보\n|이름=\n|영문=\n|이미지=\n|분류=\n|체력=\n|공격력=\n|스폰=\n|드롭=\n|경험치=\n|에디션=\n}}'
  },
  item_info: {
    label: '아이템 정보',
    fields: ['이름', '영문', '이미지', '종류', '중첩', '내구도', '희귀도', '획득', '사용처'],
    required: ['이름', '종류'],
    template: '{{아이템 정보\n|이름=\n|영문=\n|이미지=\n|종류=\n|중첩=\n|내구도=\n|희귀도=\n|획득=\n|사용처=\n}}'
  },
  block_info: {
    label: '블록 정보',
    fields: ['이름', '영문', '이미지', '종류', '투명', '밝기', '경도', '폭발 저항', '도구', '중첩', '획득'],
    required: ['이름', '종류'],
    enums: { 투명: ['예', '아니오'] },
    template: '{{블록 정보\n|이름=\n|영문=\n|이미지=\n|종류=\n|투명=\n|밝기=\n|경도=\n|폭발 저항=\n|도구=\n|중첩=\n|획득=\n}}'
  },
  mod_info: {
    label: '모드 정보',
    fields: ['이름', '영문', '분류', '로더', '지원 버전', '클라이언트 필요', '서버 필요', '의존성', '공식 링크', '소스 코드', '라이선스', '한국어', '마지막 확인'],
    required: ['이름', '분류', '로더', '지원 버전'],
    enums: { '클라이언트 필요': ['yes', 'no', 'optional', 'unknown'], '서버 필요': ['yes', 'no', 'optional', 'unknown'] },
    template: '{{모드 정보\n|이름=\n|영문=\n|분류=\n|로더=\n|지원 버전=\n|클라이언트 필요=\n|서버 필요=\n|의존성=\n|공식 링크=\n|소스 코드=\n|라이선스=\n|한국어=\n|마지막 확인=\n}}'
  },
  server_info: {
    label: '서버 정보',
    fields: ['이름', '주소', '에디션', '지원 버전', '장르', '인증', '화이트리스트', '디스코드', '공식 사이트', '상태 확인', '마지막 확인'],
    required: ['이름', '주소', '에디션'],
    enums: { 에디션: ['Java Edition', 'Bedrock Edition', '둘 다'], '상태 확인': ['사용', '미사용'] },
    template: '{{서버 정보\n|이름=\n|주소=\n|에디션=\n|지원 버전=\n|장르=\n|인증=\n|화이트리스트=\n|디스코드=\n|공식 사이트=\n|상태 확인=\n|마지막 확인=\n}}'
  },
  crafting_recipe: {
    label: '조합법',
    fields: ['1', '2', '3', '4', '5', '6', '7', '8', '9', '결과', '수량'],
    required: ['결과'],
    template: '{{조합법\n|1=\n|2=\n|3=\n|4=\n|5=\n|6=\n|7=\n|8=\n|9=\n|결과=\n|수량=1\n}}'
  },
  command_info: {
    label: '명령어 정보',
    fields: ['명령어', '권한', '에디션', '문법', '설명'],
    required: ['명령어', '문법'],
    template: '{{명령어 정보\n|명령어=\n|권한=\n|에디션=\n|문법=\n|설명=\n}}'
  },
  drop_table: {
    label: '드롭 표',
    fields: ['아이템', '종류', '비고'],
    required: ['아이템'],
    template: '{{드롭 표\n|아이템=\n|종류=\n|비고=\n}}'
  },
  smelting_recipe: {
    label: '제련법',
    fields: ['입력', '연료', '결과', '경험치', '시간'],
    required: ['입력', '결과'],
    template: '{{제련법\n|입력=\n|연료=\n|결과=\n|경험치=\n|시간=\n}}'
  },
  villager_trade: {
    label: '주민 거래',
    fields: ['직업', '레벨', '구매', '판매', '비고'],
    required: ['직업', '판매'],
    template: '{{주민 거래\n|직업=\n|레벨=\n|구매=\n|판매=\n|비고=\n}}'
  },
  edition_diff: {
    label: '에디션 차이',
    fields: ['Java', 'Bedrock', '비고'],
    required: ['Java', 'Bedrock'],
    template: '{{에디션 차이\n|Java=\n|Bedrock=\n|비고=\n}}'
  },
  version_history: {
    label: '버전 역사',
    fields: ['1.21', '1.20', '1.19', '비고'],
    required: ['1.21'],
    template: '{{버전 역사\n|1.21=\n|1.20=\n|1.19=\n|비고=\n}}'
  },
  mod_version_table: {
    label: '모드 버전표',
    fields: ['모드 버전', 'Minecraft', '로더', '변경점', '비고'],
    required: ['모드 버전', 'Minecraft'],
    template: '{{모드 버전표\n|모드 버전=\n|Minecraft=\n|로더=\n|변경점=\n|비고=\n}}'
  },
  develop_status: {
    label: '개발 문서 상태',
    fields: ['대상', '버전', '검증', '출처', '확인일'],
    required: ['대상', '버전', '검증'],
    enums: { 검증: ['필요', '완료', '부분 확인', '오래됨'] },
    template: '{{개발 문서 상태\n|대상=Java Edition\n|버전=1.21.x\n|검증=필요\n|출처=공식 문서, 테스트\n|확인일=2026.05.24. 00:00\n}}'
  },
  api_info: {
    label: 'API 정보',
    fields: ['이름', '대상', '언어', '지원', '버전', '공식 링크', '설명'],
    required: ['이름', '대상', '버전'],
    template: '{{API 정보\n|이름=\n|대상=Plugin\n|언어=Java\n|지원=Paper\n|버전=1.21.x\n|공식 링크=\n|설명=\n}}'
  },
  packet_info: {
    label: '패킷 정보',
    fields: ['이름', '방향', '상태', '버전', 'ID', '필드', '설명'],
    required: ['이름', '방향'],
    enums: { 방향: ['clientbound', 'serverbound'], 상태: ['handshaking', 'status', 'login', 'configuration', 'play'] },
    template: '{{패킷 정보\n|이름=\n|방향=\n|상태=play\n|버전=1.21.x\n|ID=\n|필드=\n|설명=\n}}'
  },
  data_type_info: {
    label: '데이터 타입',
    fields: ['이름', '종류', '크기', '범위', '설명'],
    required: ['이름', '종류'],
    template: '{{데이터 타입\n|이름=\n|종류=\n|크기=\n|범위=\n|설명=\n}}'
  },
  version_support: {
    label: '버전 지원표',
    fields: ['열', '행1', '행2', '행3'],
    required: ['행1'],
    template: '{{버전 지원표\n|열=버전,지원,상태,비고\n|행1=1.21.x,지원,확인 필요,\n|행2=\n|행3=\n}}'
  },
  code_example: {
    label: '코드 예제',
    fields: ['제목', '언어', '코드'],
    required: ['코드'],
    template: '{{코드 예제\n|제목=예제\n|언어=java\n|코드=\n}}\n'
  },
  warning_box: {
    label: '경고 박스',
    fields: ['제목', '내용'],
    required: ['내용'],
    template: '{{경고 박스\n|제목=주의\n|내용=\n}}'
  },
  official_doc_link: {
    label: '공식 문서 링크',
    fields: ['제목', 'URL', '확인일'],
    required: ['URL'],
    template: '{{공식 문서 링크\n|제목=\n|URL=https://\n|확인일=2026.05.24. 00:00\n}}'
  },
  dependency_info: {
    label: '의존성 정보',
    fields: ['열', '행1', '행2', '행3'],
    required: ['행1'],
    template: '{{의존성 정보\n|열=이름,범위,버전,비고\n|행1=\n|행2=\n|행3=\n}}'
  },
  gradle_setup: {
    label: 'Gradle 설정',
    fields: ['내용'],
    required: ['내용'],
    template: '{{Gradle 설정\n|내용=\n}}\n'
  },
  maven_setup: {
    label: 'Maven 설정',
    fields: ['내용'],
    required: ['내용'],
    template: '{{Maven 설정\n|내용=\n}}\n'
  },
  nbt_structure: {
    label: 'NBT 구조',
    fields: ['열', '행1', '행2', '행3'],
    required: ['행1'],
    template: '{{NBT 구조\n|열=태그,타입,설명\n|행1=\n|행2=\n|행3=\n}}'
  },
  protocol_fields: {
    label: '프로토콜 필드 표',
    fields: ['열', '행1', '행2', '행3'],
    required: ['행1'],
    template: '{{프로토콜 필드 표\n|열=필드,타입,설명\n|행1=\n|행2=\n|행3=\n}}'
  }
};

app.get('/api/components', async () => Object.entries(componentSchemas).map(([key, value]) => ({ key, label: value.label })));
app.get('/api/components/:key/schema', async (request, reply) => {
  const schema = componentSchemas[(request.params as any).key];
  if (!schema) return reply.code(404).send({ error: 'not_found' });
  return schema;
});
app.post('/api/components/:key/preview', async (request, reply) => {
  if (!consumeActorRateLimit(request, 'component-preview', 120, 300, 15 * 60 * 1000)) return reply.code(429).send({ error: 'rate_limited' });
  const schema = componentSchemas[(request.params as any).key];
  if (!schema) return reply.code(404).send({ error: 'not_found' });
  const props = normalizeComponentPreviewProps(schema, (request.body as any)?.props ?? {});
  if (!props) return reply.code(413).send({ error: 'component_preview_too_large', maxLength: maxComponentPreviewTotalLength });
  const lines = [`{{${schema.label}`, ...schema.fields.map((field) => `|${field}=${props[field] ?? ''}`), '}}'];
  const parsed = parseMarkup(lines.join('\n'));
  return { html: renderDocument(parsed.ast), diagnostics: [...componentDiagnostics(schema, props), ...parsed.errors], schema };
});

function componentDiagnostics(schema: ComponentSchema, props: Record<string, unknown>) {
  const diagnostics: string[] = [];
  for (const field of schema.required) {
    if (!String(props[field] ?? '').trim()) diagnostics.push(`${field} 필수값이 없습니다.`);
  }
  for (const [field, allowed] of Object.entries(schema.enums ?? {})) {
    const value = String(props[field] ?? '').trim();
    if (value && !allowed.includes(value)) diagnostics.push(`${field} 값은 ${allowed.join(', ')} 중 하나여야 합니다.`);
  }
  const unknownFields = Object.keys(props).filter((field) => !schema.fields.includes(field));
  if (unknownFields.length > 0) diagnostics.push(`정의되지 않은 필드: ${unknownFields.join(', ')}`);
  return diagnostics;
}

function normalizeComponentPreviewProps(schema: ComponentSchema, rawProps: Record<string, unknown>) {
  const props: Record<string, string> = {};
  let totalLength = 0;
  for (const field of schema.fields) {
    const value = boundedText(rawProps[field], maxComponentPreviewFieldLength);
    totalLength += value.length;
    if (totalLength > maxComponentPreviewTotalLength) return null;
    props[field] = value;
  }
  for (const field of Object.keys(rawProps)) {
    if (schema.fields.includes(field)) continue;
    const value = boundedText(rawProps[field], 255);
    totalLength += field.length + value.length;
    if (totalLength > maxComponentPreviewTotalLength) return null;
    props[field] = value;
  }
  return props;
}

async function createDnsServerClaim(pageId: number, userId: number, rawHost: unknown) {
  const host = normalizeServerHost(rawHost);
  if (!host) throw new Error('dns_host_required');
  if (net.isIP(host)) throw new Error('dns_host_required');
  const recordName = `_minewiki.${host}`;
  await exec(`UPDATE server_claims SET status='expired', updated_at=NOW() WHERE page_id=:pageId AND user_id=:userId AND status='pending' AND method='dns_txt'`, {
    pageId,
    userId
  });
  const seed = crypto.randomBytes(16).toString('hex');
  const inserted = await exec(
    `INSERT INTO server_claims (page_id, user_id, method, target_host, record_name, token_hash, token_plain, status, expires_at, created_at, updated_at)
     VALUES (:pageId, :userId, 'dns_txt', :host, :recordName, :tokenHash, :seed, 'pending', DATE_ADD(NOW(), INTERVAL 1 DAY), NOW(), NOW())`,
    { pageId, userId, host, recordName, tokenHash: hashContent(seed), seed }
  );
  const claimId = Number(inserted.insertId);
  const expectedValue = `minewiki-verify=${claimId}.${seed}`;
  await exec(
    `UPDATE server_claims
     SET expected_value=:expectedValue, token_plain=:expectedValue, token_hash=:tokenHash, updated_at=NOW()
     WHERE id=:claimId`,
    { claimId, expectedValue, tokenHash: hashContent(expectedValue) }
  );
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
     VALUES ('server_claim', 'server_claim', :claimId, 'normal', NOW(), NOW())`,
    { claimId }
  );
  return one<any>(`SELECT ${serverClaimPublicFields} FROM server_claims WHERE id=:claimId`, { claimId });
}

async function latestServerClaim(pageId: number, userId?: number) {
  const userFilter = userId ? 'AND user_id=:userId' : '';
  return one<any>(
    `SELECT ${serverClaimPublicFields} FROM server_claims
     WHERE page_id=:pageId ${userFilter}
       AND method='dns_txt'
       AND status IN ('pending','verified','failed','expired','revoked')
     ORDER BY FIELD(status,'pending','verified','failed','expired','revoked'), updated_at DESC, id DESC
     LIMIT 1`,
    { pageId, userId }
  );
}

async function dnsChecksForClaim(claimId: number) {
  return query<any>(`SELECT ${serverDnsCheckFields} FROM server_dns_checks WHERE claim_id=:claimId ORDER BY checked_at DESC, id DESC LIMIT 20`, { claimId });
}

async function verifyDnsServerClaim(claim: any) {
  const recordName = String(claim.record_name ?? '').trim();
  const expectedValue = String(claim.expected_value ?? claim.token_plain ?? '').trim();
  if (!recordName || !expectedValue) return { ok: false, status: 'error', message: '인증 레코드가 없습니다.' };
  let foundValues: string[] = [];
  let status: 'matched' | 'not_found' | 'mismatch' | 'error' = 'not_found';
  let message = '';
  try {
    const records = await dns.resolveTxt(recordName);
    foundValues = records.map((record) => record.join(''));
    status = foundValues.includes(expectedValue) ? 'matched' : foundValues.length ? 'mismatch' : 'not_found';
    if (status === 'mismatch') message = 'TXT 레코드는 있으나 필요한 값과 일치하지 않습니다.';
    if (status === 'not_found') message = 'TXT 레코드를 찾을 수 없습니다.';
  } catch (error: any) {
    status = ['ENODATA', 'ENOTFOUND'].includes(String(error?.code ?? '')) ? 'not_found' : 'error';
    message = status === 'not_found' ? 'TXT 레코드를 찾을 수 없습니다.' : String(error?.message ?? 'DNS 확인 실패');
  }
  await exec(
    `INSERT INTO server_dns_checks (claim_id, record_name, expected_value, found_values_json, status, error_message, checked_at)
     VALUES (:claimId, :recordName, :expectedValue, :foundValues, :status, :message, NOW())`,
    { claimId: claim.id, recordName, expectedValue, foundValues: JSON.stringify(foundValues), status, message: message || null }
  );
  await exec(`UPDATE server_claims SET last_checked_at=NOW(), failure_reason=:message, updated_at=NOW() WHERE id=:claimId`, {
    claimId: claim.id,
    message: message || null
  });
  return { ok: status === 'matched', status, message };
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

function normalizeServerPort(value: unknown) {
  const text = String(value ?? '').trim();
  const rawPort = text.includes(':') ? text.split(':').pop() : text;
  const port = Number(rawPort);
  return Number.isInteger(port) && isAllowedPublicProbePort(port) ? port : null;
}

function isAllowedPublicProbePort(port: number) {
  return Number.isInteger(port) && port >= 1024 && port <= 65535;
}

async function serverClaimTargetForRequest(request: any, pageId: number) {
  if (!Number.isInteger(pageId) || pageId < 1) return null;
  const page = await getPageById(pageId);
  if (!page || String(page.namespace_code ?? '') !== 'server') return null;
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return null;
  const target = await one<any>(
    `SELECT COALESCE(es.host, sw.host, se.host) AS host,
            COALESCE(se.port, sw.port, 25565) AS port,
            COALESCE(es.edition, sw.edition, 'java') AS edition,
            ws.id AS space_id
     FROM pages p
     LEFT JOIN wiki_spaces ws ON ws.root_page_id=p.id
       AND ws.space_type='server_wiki'
       AND ws.status NOT IN ('archived','hidden')
     LEFT JOIN entity_servers es ON es.page_id=p.id
     LEFT JOIN server_wikis sw ON sw.space_id=ws.id
       AND sw.status NOT IN ('archived','hidden')
     LEFT JOIN server_endpoints se ON se.page_id=p.id AND se.enabled=1
     WHERE p.id=:pageId
       AND (es.page_id IS NOT NULL OR sw.id IS NOT NULL)
     LIMIT 1`,
    { pageId }
  );
  return target ? { page, ...target } : null;
}

app.post('/api/servers/:pageId/claim', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).send({ error: 'login_required' });
  const userId = nullablePositiveInt(user.id);
  if (!userId) return reply.code(403).send({ error: 'login_required' });
  const body = request.body as any;
  const method = String(body?.method ?? 'dns_txt');
  const pageId = nullablePositiveInt((request.params as any).pageId);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  if (!['dns_txt', 'motd_token'].includes(method)) return reply.code(400).send({ error: 'unsupported_claim_method' });
  const target = await serverClaimTargetForRequest(request, pageId);
  if (!target) return reply.code(404).send({ error: 'server_not_found' });
  if (method === 'dns_txt') {
    try {
      const host = body?.host ?? target.host;
      const claim = await createDnsServerClaim(pageId, userId, host);
      return { claimId: claim.id, method, token: claim.expected_value, dnsName: claim.record_name, value: claim.expected_value, note: 'DNS TXT 레코드를 추가한 뒤 인증 확인을 누르세요.' };
    } catch (error: any) {
      return reply.code(400).send({ error: error.message });
    }
  }
  const { token, tokenHash } = makeClaimToken();
  const host = normalizeServerHost(target.host);
  if (!host) return reply.code(400).send({ error: 'server_host_required' });
  const result = await exec(
    `INSERT INTO server_claims (page_id, user_id, method, target_host, token_hash, token_plain, status, expires_at, created_at, updated_at)
     VALUES (:pageId, :userId, :method, :host, :tokenHash, :token, 'pending', DATE_ADD(NOW(), INTERVAL 1 DAY), NOW(), NOW())`,
    { pageId, userId, method, host, tokenHash, token }
  );
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
     VALUES ('server_claim', 'server_claim', :claimId, 'normal', NOW(), NOW())`,
    { claimId: result.insertId }
  );
  return method === 'dns_txt'
    ? { claimId: result.insertId, method, token, dnsName: `_minewiki.${body?.host ?? 'example.kr'}`, note: 'DNS TXT 값에 token을 넣고 verify를 호출하세요.' }
    : { claimId: result.insertId, method, token, host, port: Number(target.port ?? 25565), note: '서버 MOTD에 token을 넣고 verify를 호출하세요.' };
});

app.post('/api/servers/:pageId/verify', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).send({ error: 'login_required' });
  const body = request.body as any;
  const pageId = nullablePositiveInt((request.params as any).pageId);
  const claimId = nullablePositiveInt(body.claimId);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  if (!claimId) return reply.code(400).send({ error: 'invalid_claim_id' });
  const target = await serverClaimTargetForRequest(request, pageId);
  if (!target) return reply.code(404).send({ error: 'server_not_found' });
  const claim = await one<any>(
    `SELECT ${serverClaimVerifyFields} FROM server_claims WHERE page_id=:pageId AND id=:claimId AND status='pending'`,
    { pageId, claimId }
  );
  if (!claim) return reply.code(404).send({ error: 'claim_not_found' });
  if (Number(claim.user_id) !== Number(user.id) && !can(user, 'server.official_edit') && !can(user, 'report.handle')) {
    return reply.code(403).send({ error: 'claim_owner_required' });
  }
  let verified = false;
  if (claim.method === 'dns_txt') {
    const result = await verifyDnsServerClaim(claim);
    verified = result.ok;
    if (!verified) return reply.code(400).send({ ok: false, error: 'token_not_found', status: result.status, message: result.message });
  } else if (claim.method === 'motd_token') {
    const host = normalizeServerHost(claim.target_host ?? target.host);
    const port = normalizeServerPort(target.port) ?? 25565;
    if (!host) return reply.code(400).send({ error: 'server_host_required' });
    const status = await minecraftJavaStatus(host, port);
    verified = Boolean(status.online && status.motd?.includes(claim.token_plain));
  } else {
    return reply.code(400).send({ error: 'unsupported_claim_method' });
  }
  if (!verified) return reply.code(400).send({ ok: false, error: 'token_not_found' });
  await exec(
    `UPDATE server_claims
     SET status='verified',
         verified_at=COALESCE(verified_at, NOW()),
         last_verified_at=NOW(),
         renewal_required_at=DATE_ADD(NOW(), INTERVAL 1 YEAR),
         expires_at=DATE_ADD(NOW(), INTERVAL 1 YEAR),
         token_plain=NULL,
         updated_at=NOW()
     WHERE id=:id`,
    { id: claim.id }
  );
  await exec(`UPDATE entity_servers SET verified_status='verified', updated_at=NOW() WHERE page_id=:pageId`, { pageId });
  await syncServerWikiVerifiedStatus(pageId, 'verified');
  await markServerPageVerified(pageId, Number(claim.user_id));
  await grantServerOwner(pageId, Number(claim.user_id), 'owner', 'active', Number(claim.user_id));
  return { ok: true, verification: await serverVerification(pageId) };
});

app.get('/api/servers/:pageId/status', async (request) => {
  const pageId = nullablePositiveInt((request.params as any).pageId);
  if (!pageId) return { status: 'not_found', verification: { status: 'unverified' } };
  const page = await getPageById(pageId);
  if (!page || !(await canReadPageResource(aclActorForRequest(request), page))) {
    return { status: 'not_found', verification: { status: 'unverified' } };
  }
  const verification = await serverVerification(pageId);
  const endpoint = await one<any>(`SELECT ${serverEndpointFields} FROM server_endpoints WHERE page_id=:pageId AND enabled=1 ORDER BY id DESC LIMIT 1`, {
    pageId
  });
  if (!endpoint) return { status: 'not_configured', verification };
  const endpointPort = normalizeServerPort(endpoint.port);
  if (!endpointPort) return { status: 'invalid_endpoint', verification };
  const cached = await one<any>(
    `SELECT checked_at, online, players_online, players_max, version_name, latency_ms
     FROM server_ping_logs
     WHERE endpoint_id=:endpointId AND checked_at >= DATE_SUB(NOW(), INTERVAL 60 SECOND)
     ORDER BY checked_at DESC, id DESC
     LIMIT 1`,
    { endpointId: endpoint.id }
  );
  if (cached) {
    return {
      online: Boolean(cached.online),
      playersOnline: cached.players_online ?? null,
      playersMax: cached.players_max ?? null,
      versionName: cached.version_name ?? null,
      motd: null,
      latencyMs: cached.latency_ms ?? null,
      cached: true,
      checkedAt: cached.checked_at,
      verification
    };
  }
  const started = Date.now();
  const status = endpoint.edition === 'java' ? await minecraftJavaStatus(endpoint.host, endpointPort) : { online: await tcpCheck(endpoint.host, endpointPort) };
  const latency = Date.now() - started;
  await exec(
    `INSERT INTO server_ping_logs (endpoint_id, checked_at, online, players_online, players_max, version_name, motd_hash, latency_ms)
     VALUES (:endpointId, NOW(), :online, :playersOnline, :playersMax, :versionName, :motdHash, :latency)`,
    {
      endpointId: endpoint.id,
      online: status.online ? 1 : 0,
      playersOnline: status.playersOnline ?? null,
      playersMax: status.playersMax ?? null,
      versionName: status.versionName ?? null,
      motdHash: status.motd ? hashContent(status.motd) : null,
      latency
    }
  );
  return {
    online: status.online,
    playersOnline: status.playersOnline ?? null,
    playersMax: status.playersMax ?? null,
    versionName: status.versionName ?? null,
    motd: null,
    latencyMs: latency,
    verification
  };
});

app.get('/api/admin/reports', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(
    `SELECT id, target_type, target_id, page_id, reporter_id, reason, detail, status, resolved_by, handled_by, created_at, resolved_at, handled_at
     FROM reports
     ORDER BY created_at DESC LIMIT 50`
  );
});
app.post('/api/admin/pages/:id/protect', async (request, reply) => {
  const user = (request as any).user;
  try {
    return await protectPageAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
});

app.post('/admin/pages/:id/protect', async (request, reply) => {
  const user = (request as any).user;
  try {
    const result = await protectPageAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
    return reply.redirect(result.href);
  } catch (error: any) {
    return adminError(reply, user, error?.statusCode ?? 400, '문서 보호 오류', String(error?.message ?? '문서 보호 수준을 변경할 수 없습니다.'), '/wiki', '문서로 돌아가기');
  }
});

app.post('/api/admin/pages/:id/delete', async (request, reply) => {
  const user = (request as any).user;
  try {
    return await deletePageAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
});

app.post('/admin/pages/:id/delete', async (request, reply) => {
  const user = (request as any).user;
  try {
    const result = await deletePageAction(user, nullablePositiveInt((request.params as any).id), request.body as any, true);
    return reply.redirect(result.href);
  } catch (error: any) {
    return adminError(reply, user, error?.statusCode ?? 400, '문서 삭제 오류', String(error?.message ?? '문서를 삭제할 수 없습니다.'), '/wiki', '문서로 돌아가기');
  }
});

app.post('/api/admin/revisions/:id/hide', async (request, reply) => {
  const user = (request as any).user;
  const revisionId = nullablePositiveInt((request.params as any).id);
  if (!revisionId) return reply.code(400).send({ error: 'invalid_revision_id' });
  return hideRevisionRequest(reply, user, revisionId, request.body as any);
});
app.post('/admin/revisions/:id/hide', async (request, reply) => {
  const user = (request as any).user;
  const revisionId = nullablePositiveInt((request.params as any).id);
  try {
    const result = await hideRevisionAction(user, revisionId, request.body as any);
    return reply.redirect(result.href);
  } catch (error: any) {
    return adminError(reply, user, error?.statusCode ?? 400, '리비전 숨김 오류', String(error?.message ?? '리비전을 숨길 수 없습니다.'), '/admin/recent', '최근 바뀜');
  }
});
app.post('/api/admin/revisions/:id/unhide', async (request, reply) => {
  const user = (request as any).user;
  const revisionId = nullablePositiveInt((request.params as any).id);
  if (!revisionId) return reply.code(400).send({ error: 'invalid_revision_id' });
  return unhideRevisionRequest(reply, user, revisionId, request.body as any);
});
app.post('/admin/revisions/:id/unhide', async (request, reply) => {
  const user = (request as any).user;
  const revisionId = nullablePositiveInt((request.params as any).id);
  try {
    const result = await unhideRevisionAction(user, revisionId, request.body as any);
    return reply.redirect(result.href);
  } catch (error: any) {
    return adminError(reply, user, error?.statusCode ?? 400, '리비전 숨김 해제 오류', String(error?.message ?? '리비전을 공개할 수 없습니다.'), '/recent', '최근 바뀜');
  }
});
app.post('/api/admin/reports/:id/resolve', async (request, reply) => {
  const user = (request as any).user;
  try {
    const result = await resolveReportAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
    return { ok: true, status: result.status };
  } catch (error: any) {
    return reply.code(error?.statusCode ?? 400).send({ error: error?.errorCode ?? 'report_update_failed' });
  }
});
app.post('/api/reports', async (request, reply) => {
  if (!consumeActorRateLimit(request, 'report-create', 20, 50, 60 * 60 * 1000)) return reply.code(429).send({ error: 'rate_limited' });
  if (!(await requireAnonymousTurnstile(request, reply, 'report_create'))) return reply;
  const body = request.body as any;
  const target = await reportTargetForRequest(request, body);
  if (!target.ok) return reply.code(target.statusCode).send({ error: target.error });
  const sla = await one<any>(
    `SELECT id, reason, priority, target_minutes, enabled FROM report_sla_rules WHERE enabled=1 AND (reason=:reason OR reason='default') ORDER BY reason=:reason DESC LIMIT 1`,
    { reason: boundedText(body.reason, 80) || 'other' }
  );
  const result = await exec(
    `INSERT INTO reports (target_type, target_id, page_id, reporter_id, reason, detail, created_at)
     VALUES (:targetType, :targetId, :pageId, :reporterId, :reason, :detail, NOW())`,
    {
      targetType: target.targetType,
      targetId: target.targetId,
      pageId: target.pageId,
      reporterId: (request as any).user?.id ?? null,
      reason: boundedText(body.reason, 80) || 'other',
      detail: boundedText(body.detail, 4000) || null
    }
  );
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
     VALUES ('report', 'report', :reportId, :priority, NOW(), NOW())`,
    { reportId: result.insertId, priority: sla?.priority ?? 'normal' }
  );
  const pageId = Number(target.pageId ?? 0);
  if (pageId > 0) await maybeEscalatePageProtection(pageId, 'vandalism', (request as any).user?.id ?? null);
  return { id: result.insertId, priority: sla?.priority ?? 'normal', targetMinutes: sla?.target_minutes ?? 1440, ok: true };
});
app.get('/api/admin/search/failed', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return failedSearches();
});
app.post('/api/admin/search/dictionary', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const result = await upsertSearchDictionary(request.body as any, user?.id ?? null);
  if (!result.ok) return reply.code(400).send({ error: result.error });
  return { ok: true };
});
app.post('/api/admin/aliases', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'page.move') && !can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const page = await getPageById(nullablePositiveInt(body.targetPageId) ?? 0);
  if (!page) return reply.code(404).send({ error: 'target_not_found' });
  if (!(await aclDecision(aclActorForRequest(request), 'move', page)).allowed) return reply.code(403).send({ error: 'acl_denied' });
  const namespace = normalizeEditableNamespace(body.namespace ?? page.namespace_code) ?? page.namespace_code;
  const aliasTitle = normalizeTitle(body.aliasTitle);
  if (!aliasTitle) return reply.code(400).send({ error: 'alias_title_required' });
  const aliasType = ['alias', 'redirect', 'typo'].includes(String(body.aliasType ?? '')) ? String(body.aliasType) : 'alias';
  await addPageAlias(namespace, aliasTitle, Number(page.id), aliasType);
  return { ok: true };
});
app.get('/api/admin/quality/:kind', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return qualityList((request.params as any).kind);
});

app.get('/api/pages/:id/discussions', async (request, reply) => {
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'page_not_found' });
  return discussionThreadsForPage(Number(page.id));
});

async function createDiscussionThreadForPage(request: any, reply: any, page: any, options: { htmlRedirect?: string } = {}) {
  const htmlDiscussionError = (status: number, title: string, message: string) => {
    if (!options.htmlRedirect) return null;
    return reply
      .code(status)
      .type('text/html')
      .send(messagePage(title, message, (request as any).user, { tone: 'error', actionHref: options.htmlRedirect, actionLabel: '토론으로 돌아가기' }));
  };
  if (!consumeActorRateLimit(request, 'discussion-create', 20, 50, 60 * 60 * 1000)) {
    return htmlDiscussionError(429, '토론 제한', '짧은 시간 안에 토론 생성 요청이 너무 많습니다. 잠시 후 다시 시도하세요.') ?? reply.code(429).send({ error: 'rate_limited' });
  }
  if (!(await requireAnonymousTurnstile(request, reply, 'discussion_create'))) return reply;
  const body = request.body as any;
  if (!(await canReadPageResource(aclActorForRequest(request), page))) {
    return htmlDiscussionError(404, '문서 없음', '토론을 열 문서를 찾을 수 없습니다.') ?? reply.code(404).send({ error: 'page_not_found' });
  }
  if (!(await aclDecision(aclActorForRequest(request), 'create_thread', page)).allowed) {
    return htmlDiscussionError(403, '권한 없음', '이 문서에는 새 토론을 만들 수 없습니다.') ?? reply.code(403).send({ error: 'acl_denied' });
  }
  const title = boundedText(body.title, 160);
  if (!title) {
    return htmlDiscussionError(400, '입력 오류', '토론 제목을 입력하세요.') ?? reply.code(400).send({ error: 'title_required' });
  }
  const commentBody = boundedText(body.body, 4000);
  const result = await exec(
    `INSERT INTO discussion_threads (page_id, title, created_by, created_at, updated_at)
     VALUES (:pageId, :title, :userId, NOW(), NOW())`,
    { pageId: Number(page.id), title, userId: (request as any).user?.id ?? null }
  );
  if (commentBody) {
    await exec(
      `INSERT INTO discussion_comments (thread_id, parent_id, created_by, body, created_at)
       VALUES (:threadId, NULL, :userId, :body, NOW())`,
      { threadId: result.insertId, userId: (request as any).user?.id ?? null, body: commentBody }
    );
  }
  await logRecentDiscussion(page, (request as any).user?.id ?? null, `토론 생성: ${title}`);
  if (options.htmlRedirect) return reply.redirect(`${options.htmlRedirect}?status=open#discussion-thread-${result.insertId}`);
  return { id: result.insertId, ok: true };
}

async function createDiscussionFromWikiPath(request: any, reply: any, namespace: NamespaceCode, rawTitle: string) {
  const user = request.user ?? (request as any).user;
  const title = normalizeTitle(rawTitle);
  const page = (await getPageByTitle(namespace, title)) ?? (await getPageByAlias(namespace, title));
  if (!page) {
    return reply
      .code(404)
      .type('text/html')
      .send(messagePage('문서 없음', '토론을 열 문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  }
  if (!(await canReadPageResource(aclActorForRequest(request), page))) {
    return reply
      .code(404)
      .type('text/html')
      .send(messagePage('문서 없음', '토론을 열 문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  }
  return createDiscussionThreadForPage(request, reply, page, { htmlRedirect: `${wikiUrl(namespace, page.title)}/discussion` });
}

app.post('/api/pages/:id/discussions', async (request, reply) => {
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  return createDiscussionThreadForPage(request, reply, page);
});
app.get('/api/discussions/:id', async (request, reply) => {
  const threadId = nullablePositiveInt((request.params as any).id);
  if (!threadId) return reply.code(400).send({ error: 'invalid_discussion_id' });
  const thread = await one<any>(`SELECT ${discussionThreadFields} FROM discussion_threads WHERE id=:id AND status!='hidden'`, { id: threadId });
  if (!thread) return reply.code(404).send({ error: 'discussion_not_found' });
  const page = await getPageById(Number(thread.page_id));
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'discussion_not_found' });
  const comments = await query<any>(
    `SELECT id, thread_id, parent_id, created_by, body, visibility, created_at, updated_at
     FROM discussion_comments
     WHERE thread_id=:threadId AND visibility='public'
     ORDER BY COALESCE(parent_id, id), id`,
    { threadId: thread.id }
  );
  return { thread, comments };
});
async function addDiscussionCommentToThread(request: any, reply: any, options: { htmlRedirect?: boolean } = {}) {
  const user = (request as any).user;
  if (!consumeActorRateLimit(request, 'discussion-comment', 60, 180, 60 * 60 * 1000)) return reply.code(429).send({ error: 'rate_limited' });
  if (!(await requireAnonymousTurnstile(request, reply, 'discussion_comment'))) return reply;
  const body = request.body as any;
  const threadId = nullablePositiveInt((request.params as any).id);
  if (!threadId) {
    if (options.htmlRedirect) return htmlError(reply, user, 400, '입력 오류', '토론 번호가 올바르지 않습니다.', '/wiki', '위키 대문');
    return reply.code(400).send({ error: 'invalid_discussion_id' });
  }
  const thread = await one<any>(
    `SELECT dt.id, dt.status, p.id AS page_id, p.title, n.code AS namespace_code
     FROM discussion_threads dt
     JOIN pages p ON p.id=dt.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE dt.id=:threadId AND dt.status!='hidden'`,
    { threadId }
  );
  if (!thread) {
    if (options.htmlRedirect) return htmlError(reply, user, 404, '토론 없음', '토론을 찾을 수 없습니다.', '/wiki', '위키 대문');
    return reply.code(404).send({ error: 'discussion_not_found' });
  }
  const discussionHref = `${wikiUrl(thread.namespace_code, thread.title)}/discussion?status=${discussionStatusHref(thread.status)}#discussion-thread-${thread.id}`;
  if (thread.status === 'locked') {
    if (options.htmlRedirect) return htmlError(reply, user, 409, '잠긴 토론', '잠긴 토론에는 댓글을 남길 수 없습니다.', discussionHref, '토론으로 돌아가기');
    return reply.code(409).send({ error: 'discussion_locked' });
  }
  const page = await getPageById(Number(thread.page_id));
  if (!(await canReadPageResource(aclActorForRequest(request), page))) {
    if (options.htmlRedirect) return htmlError(reply, user, 404, '토론 없음', '토론을 찾을 수 없습니다.', '/wiki', '위키 대문');
    return reply.code(404).send({ error: 'discussion_not_found' });
  }
  if (!(await aclDecision(aclActorForRequest(request), 'write_thread_comment', page)).allowed) {
    if (options.htmlRedirect) return htmlError(reply, user, 403, '권한 없음', '이 토론에 댓글을 남길 권한이 없습니다.', discussionHref, '토론으로 돌아가기');
    return reply.code(403).send({ error: 'acl_denied' });
  }
  const commentBody = boundedText(body.body, 4000);
  if (!commentBody) {
    if (options.htmlRedirect) return htmlError(reply, user, 400, '입력 오류', '댓글 내용을 입력하세요.', discussionHref, '토론으로 돌아가기');
    return reply.code(400).send({ error: 'body_required' });
  }
  const parentId = nullablePositiveInt(body.parentId);
  if (parentId) {
    const parent = await one<any>(`SELECT id FROM discussion_comments WHERE id=:parentId AND thread_id=:threadId AND visibility='public'`, { parentId, threadId });
    if (!parent) {
      if (options.htmlRedirect) return htmlError(reply, user, 400, '입력 오류', '답글을 달 댓글을 찾을 수 없습니다.', discussionHref, '토론으로 돌아가기');
      return reply.code(400).send({ error: 'invalid_parent_comment' });
    }
  }
  const result = await exec(
    `INSERT INTO discussion_comments (thread_id, parent_id, created_by, body, created_at)
     VALUES (:threadId, :parentId, :userId, :body, NOW())`,
    { threadId, parentId, userId: (request as any).user?.id ?? null, body: commentBody }
  );
  await exec(`UPDATE discussion_threads SET updated_at=NOW() WHERE id=:threadId`, { threadId });
  await logRecentDiscussion(thread, (request as any).user?.id ?? null, '토론 댓글');
  if (options.htmlRedirect) return reply.redirect(`${wikiUrl(thread.namespace_code, thread.title)}/discussion?status=${discussionStatusHref(thread.status)}#discussion-comment-${result.insertId}`);
  return { id: result.insertId, ok: true };
}

app.post('/discussion/:id/comments', async (request, reply) => addDiscussionCommentToThread(request, reply, { htmlRedirect: true }));

app.post('/api/discussions/:id/comments', async (request, reply) => {
  return addDiscussionCommentToThread(request, reply);
});
async function changeDiscussionStatus(request: any, reply: any, options: { htmlRedirect?: boolean } = {}) {
  const user = (request as any).user;
  if (!user) {
    if (options.htmlRedirect) return htmlError(reply, user, 403, '로그인 필요', '토론 상태를 바꾸려면 로그인하세요.', '/login', '로그인');
    return reply.code(403).send({ error: 'login_required' });
  }
  const body = request.body as any;
  const status = normalizeDiscussionStatus(body.status);
  if (!status) {
    if (options.htmlRedirect) return htmlError(reply, user, 400, '입력 오류', '토론 상태 값이 올바르지 않습니다.', '/wiki', '위키 대문');
    return reply.code(400).send({ error: 'invalid_discussion_status' });
  }
  const threadId = nullablePositiveInt((request.params as any).id);
  if (!threadId) {
    if (options.htmlRedirect) return htmlError(reply, user, 400, '입력 오류', '토론 번호가 올바르지 않습니다.', '/wiki', '위키 대문');
    return reply.code(400).send({ error: 'invalid_discussion_id' });
  }
  const thread = await one<any>(
    `SELECT dt.id, dt.page_id, dt.created_by, p.title, n.code AS namespace_code
     FROM discussion_threads dt
     JOIN pages p ON p.id=dt.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE dt.id=:id`,
    { id: threadId }
  );
  if (!thread) {
    if (options.htmlRedirect) return htmlError(reply, user, 404, '토론 없음', '토론을 찾을 수 없습니다.', '/wiki', '위키 대문');
    return reply.code(404).send({ error: 'discussion_not_found' });
  }
  const discussionHref = `${wikiUrl(thread.namespace_code, thread.title)}/discussion?status=${discussionStatusHref(status)}#discussion-thread-${thread.id}`;
  const page = await getPageById(Number(thread.page_id));
  if (!(await canReadPageResource(aclActorForRequest(request), page))) {
    if (options.htmlRedirect) return htmlError(reply, user, 404, '토론 없음', '토론을 찾을 수 없습니다.', '/wiki', '위키 대문');
    return reply.code(404).send({ error: 'discussion_not_found' });
  }
  const privileged = can(user, 'report.handle');
  if ((status === 'locked' || status === 'hidden') && !privileged) {
    if (options.htmlRedirect) return htmlError(reply, user, 403, '권한 없음', '토론 잠금은 운영자만 할 수 있습니다.', discussionHref, '토론으로 돌아가기');
    return reply.code(403).send({ error: 'forbidden' });
  }
  if (!privileged && Number(thread.created_by) !== Number(user.id)) {
    if (options.htmlRedirect) return htmlError(reply, user, 403, '권한 없음', '토론 발제자 또는 운영자만 상태를 바꿀 수 있습니다.', discussionHref, '토론으로 돌아가기');
    return reply.code(403).send({ error: 'forbidden' });
  }
  await exec(`UPDATE discussion_threads SET status=:status, updated_at=NOW() WHERE id=:id`, { id: thread.id, status });
  if (options.htmlRedirect) return reply.redirect(discussionHref);
  return { ok: true, status };
}

app.post('/discussion/:id/status', async (request, reply) => changeDiscussionStatus(request, reply, { htmlRedirect: true }));

app.post('/api/discussions/:id/status', async (request, reply) => {
  return changeDiscussionStatus(request, reply);
});
app.post('/api/pages/:id/watch', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).send({ error: 'login_required' });
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  const page = await getPageById(pageId);
  if (!(await canReadPageResource(aclActorForRequest(request), page))) return reply.code(404).send({ error: 'page_not_found' });
  const watchDiscussion = (request.body as any)?.watchDiscussion === false ? 0 : 1;
  await exec(`INSERT INTO watched_pages (user_id, page_id, watch_discussion, created_at) VALUES (:userId, :pageId, :watchDiscussion, NOW()) ON DUPLICATE KEY UPDATE watch_discussion=VALUES(watch_discussion)`, {
    userId: user.id,
    pageId: Number(page.id),
    watchDiscussion
  });
  return { ok: true };
});
app.delete('/api/pages/:id/watch', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).send({ error: 'login_required' });
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) return reply.code(400).send({ error: 'invalid_page_id' });
  await exec(`DELETE FROM watched_pages WHERE user_id=:userId AND page_id=:pageId`, { userId: user.id, pageId });
  return { ok: true };
});
app.get('/api/watchlist', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).send({ error: 'login_required' });
  return watchedPages(user);
});
app.get('/api/watchlist/recent', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).send({ error: 'login_required' });
  return watchedRecentChanges(user, Number((request.query as any).limit || 50));
});
app.post('/api/page-requests', async (request, reply) => {
  try {
    const result = await createPageRequestAction(request, reply);
    return result ?? reply;
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
});
app.post('/page-requests', async (request, reply) => {
  try {
    const result = await createPageRequestAction(request, reply);
    if (!result) return reply;
    const body = request.body as any;
    const redirectTo = safeLocalRedirect(body.redirectTo || '/special/page-requests');
    return reply.type('text/html').send(
      messagePage('문서 작성 요청 완료', '요청이 접수되었습니다. 이미 문서가 있는 경우 해당 문서와 연결됩니다.', (request as any).user, {
        actionHref: redirectTo,
        actionLabel: '검색으로 돌아가기',
        secondaryHref: '/special/page-requests',
        secondaryLabel: '요청 목록'
      })
    );
  } catch (error: any) {
    return htmlError(reply, (request as any).user, error?.statusCode ?? 400, '문서 작성 요청 실패', String(error?.message ?? '문서 작성 요청을 저장할 수 없습니다.'), '/search', '검색으로 돌아가기');
  }
});

app.get('/api/beta/invites', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, invite_code, role_hint, status, expires_at, created_at, used_at FROM beta_invites ORDER BY id DESC LIMIT 100`);
});
app.post('/api/beta/invites', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const code = `beta-${crypto.randomBytes(12).toString('hex')}`;
  const result = await exec(
    `INSERT INTO beta_invites (invite_code, invited_by, role_hint, expires_at, created_at)
     VALUES (:code, :userId, :roleHint, DATE_ADD(NOW(), INTERVAL 30 DAY), NOW())`,
    { code, userId: user?.id ?? null, roleHint: body.roleHint ?? 'contributor' }
  );
  return { id: result.insertId, inviteCode: code };
});
app.post('/api/beta/invites/use', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).send({ error: 'login_required' });
  const body = request.body as any;
  const invite = await betaInviteByCode(body.inviteCode);
  if (!invite) return reply.code(404).send({ error: 'invite_not_found' });
  await exec(`UPDATE beta_invites SET status='used', used_by=:userId, used_at=NOW() WHERE id=:id`, { userId: user.id, id: invite.id });
  const groupCode = betaInviteGroup(invite.role_hint);
  await exec(
    `INSERT IGNORE INTO user_groups (user_id, group_id)
     SELECT :userId, id FROM groups WHERE code=:groupCode`,
    { userId: user.id, groupCode }
  );
  return { ok: true, role: groupCode };
});
app.post('/api/beta/invites/:id/revoke', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const inviteId = nullablePositiveInt((request.params as any).id);
  if (!inviteId) return reply.code(400).send({ error: 'invalid_invite_id' });
  await exec(`UPDATE beta_invites SET status='revoked' WHERE id=:id`, { id: inviteId });
  return { ok: true };
});

app.get('/api/tasks', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return reply.code(403).send({ error: 'forbidden' });
  const rows = await query<any>(
    `SELECT ${contributorTaskSelectFields}
     FROM contributor_tasks ct
     LEFT JOIN pages target_page ON target_page.id=ct.target_id AND ct.target_type IN ('page','server','mod')
     LEFT JOIN namespaces target_namespace ON target_namespace.id=target_page.namespace_id
     WHERE ct.status IN ('open','assigned')
     ORDER BY FIELD(ct.priority,'urgent','high','normal','low'), ct.id DESC LIMIT 100`
  );
  return filterContributorTasksForActor(aclActorForRequest(request), rows);
});
app.post('/api/tasks', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const taskType = normalizeContributorTaskType(body.taskType);
  if (!taskType) return reply.code(400).send({ error: 'invalid_task_type' });
  const target = await contributorTaskTargetForRequest(request, body.targetType ?? 'none', body.targetId);
  if (!target.ok) return reply.code(target.statusCode).send({ error: target.error });
  const title = boundedText(body.title, 255);
  if (!title) return reply.code(400).send({ error: 'title_required' });
  const priority = normalizeTaskPriority(body.priority ?? 'normal');
  if (!priority) return reply.code(400).send({ error: 'invalid_priority' });
  const dueAt = normalizeDateTimeInput(body.dueAt);
  const result = await exec(
    `INSERT INTO contributor_tasks (task_type, target_type, target_id, title, description, priority, created_by, due_at, created_at, updated_at)
     VALUES (:taskType, :targetType, :targetId, :title, :description, :priority, :userId, :dueAt, NOW(), NOW())`,
    {
      taskType,
      targetType: target.targetType,
      targetId: target.targetId,
      title,
      description: boundedText(body.description, 5000) || null,
      priority,
      userId: user?.id ?? null,
      dueAt
    }
  );
  return { id: result.insertId, ok: true };
});
app.patch('/api/tasks/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const taskId = nullablePositiveInt((request.params as any).id);
  if (!taskId) return reply.code(400).send({ error: 'invalid_task_id' });
  const existing = await one<any>(`SELECT id FROM contributor_tasks WHERE id=:taskId`, { taskId });
  if (!existing) return reply.code(404).send({ error: 'task_not_found' });
  const status = body.status === undefined ? null : normalizeContributorTaskStatus(body.status);
  if (body.status !== undefined && !status) return reply.code(400).send({ error: 'invalid_status' });
  const assignedTo = await activeUserIdOrNull(body.assignedTo);
  if (body.assignedTo !== undefined && body.assignedTo !== null && body.assignedTo !== '' && assignedTo === null) {
    return reply.code(400).send({ error: 'invalid_assignee' });
  }
  await exec(
    `UPDATE contributor_tasks SET status=COALESCE(:status,status), assigned_to=COALESCE(:assignedTo,assigned_to),
     completed_at=IF(:status='done', NOW(), completed_at), updated_at=NOW() WHERE id=:id`,
    { id: taskId, status, assignedTo }
  );
  if (status === 'done') await completeContributorTask(taskId, user?.id ?? null);
  return { ok: true };
});

app.get('/api/project-boards', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT ${projectBoardFields} FROM project_boards ORDER BY id DESC LIMIT 50`);
});
app.get('/api/project-boards/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return reply.code(403).send({ error: 'forbidden' });
  const boardId = nullablePositiveInt((request.params as any).id);
  if (!boardId) return reply.code(400).send({ error: 'invalid_board_id' });
  const [board, items] = await Promise.all([
    one<any>(`SELECT ${projectBoardFields} FROM project_boards WHERE id=:boardId`, { boardId }),
    query<any>(
      `SELECT pbi.id, pbi.board_id, pbi.task_id, pbi.page_id, pbi.title, pbi.status, pbi.sort_order, pbi.assigned_to, pbi.created_at, pbi.updated_at,
              ct.task_type, ct.priority, ct.status AS task_status
       FROM project_board_items pbi
       LEFT JOIN contributor_tasks ct ON ct.id=pbi.task_id
       WHERE pbi.board_id=:boardId
       ORDER BY FIELD(pbi.status,'todo','doing','review','blocked','done'), pbi.sort_order, pbi.id`,
      { boardId }
    )
  ]);
  if (!board) return reply.code(404).send({ error: 'board_not_found' });
  return { board, items };
});
app.post('/api/project-boards', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const name = boundedText(body.name, 255);
  if (!name) return reply.code(400).send({ error: 'name_required' });
  const result = await exec(
    `INSERT INTO project_boards (name, description, created_by, created_at, updated_at)
     VALUES (:name, :description, :userId, NOW(), NOW())`,
    { name, description: boundedText(body.description, 5000) || null, userId: user?.id ?? null }
  );
  return { id: result.insertId, ok: true };
});
app.post('/api/project-boards/:id/items', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const boardId = nullablePositiveInt((request.params as any).id);
  if (!boardId) return reply.code(400).send({ error: 'invalid_board_id' });
  if (!(await projectBoardExists(boardId))) return reply.code(404).send({ error: 'board_not_found' });
  const taskId = nullablePositiveInt(body.taskId);
  if (taskId && !(await contributorTaskExists(taskId))) return reply.code(400).send({ error: 'invalid_task_id' });
  const pageId = nullablePositiveInt(body.pageId);
  if (pageId && !(await readablePageByIdForRequest(request, pageId))) return reply.code(404).send({ error: 'page_not_found' });
  const title = boundedText(body.title, 255);
  if (!title) return reply.code(400).send({ error: 'title_required' });
  const assignedTo = await activeUserIdOrNull(body.assignedTo);
  if (body.assignedTo !== undefined && body.assignedTo !== null && body.assignedTo !== '' && assignedTo === null) {
    return reply.code(400).send({ error: 'invalid_assignee' });
  }
  const result = await exec(
    `INSERT INTO project_board_items (board_id, task_id, page_id, title, sort_order, assigned_to, created_at, updated_at)
     VALUES (:boardId, :taskId, :pageId, :title, :sortOrder, :assignedTo, NOW(), NOW())`,
    {
      boardId,
      taskId,
      pageId,
      title,
      sortOrder: boundedUnsignedInt(body.sortOrder, 1_000_000) ?? 0,
      assignedTo
    }
  );
  return { id: result.insertId, ok: true };
});
app.patch('/api/project-boards/:boardId/items/:itemId', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const boardId = nullablePositiveInt((request.params as any).boardId);
  const itemId = nullablePositiveInt((request.params as any).itemId);
  if (!boardId || !itemId) return reply.code(400).send({ error: 'invalid_item_id' });
  const status = body.status === undefined ? null : normalizeBoardItemStatus(body.status);
  if (body.status !== undefined && !status) return reply.code(400).send({ error: 'invalid_status' });
  const sortOrder = body.sortOrder === undefined ? null : boundedUnsignedInt(body.sortOrder, 1_000_000);
  if (body.sortOrder !== undefined && sortOrder === null) return reply.code(400).send({ error: 'invalid_sort_order' });
  const assignedTo = await activeUserIdOrNull(body.assignedTo);
  if (body.assignedTo !== undefined && body.assignedTo !== null && body.assignedTo !== '' && assignedTo === null) {
    return reply.code(400).send({ error: 'invalid_assignee' });
  }
  await exec(
    `UPDATE project_board_items
     SET status=COALESCE(:status,status),
         sort_order=COALESCE(:sortOrder,sort_order),
         assigned_to=COALESCE(:assignedTo,assigned_to),
         updated_at=NOW()
     WHERE id=:itemId AND board_id=:boardId`,
    {
      boardId,
      itemId,
      status,
      sortOrder,
      assignedTo
    }
  );
  return { ok: true };
});

app.get('/admin/project-boards', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return adminAccessDenied(reply, request, '프로젝트 보드 관리 권한이 필요합니다.');
  const [boards, items, tasks] = await Promise.all([
    query<any>(`SELECT ${projectBoardFields} FROM project_boards ORDER BY FIELD(status,'active','paused','done','archived'), id DESC LIMIT 100`),
    query<any>(
      `SELECT pbi.id, pbi.board_id, pbi.task_id, pbi.page_id, pbi.title, pbi.status, pbi.sort_order, pbi.assigned_to, pbi.created_at, pbi.updated_at,
              assignee.username AS assigned_username, assignee.display_name AS assigned_display_name,
              ct.title AS task_title, ct.task_type, ct.priority AS task_priority
       FROM project_board_items pbi
       LEFT JOIN users assignee ON assignee.id=pbi.assigned_to
       LEFT JOIN contributor_tasks ct ON ct.id=pbi.task_id
       ORDER BY pbi.board_id, FIELD(pbi.status,'todo','doing','review','blocked','done'), pbi.sort_order, pbi.id`
    ),
    query<any>(`SELECT id, title, task_type, priority, status FROM contributor_tasks WHERE status IN ('open','assigned') ORDER BY FIELD(priority,'urgent','high','normal','low'), id DESC LIMIT 200`)
  ]);
  return reply.type('text/html').send(projectBoardsPage(boards, items, tasks, user));
});
app.post('/admin/project-boards', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return adminError(reply, user, 403, '권한 없음', '프로젝트 보드 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const name = boundedText(body.name, 255);
  if (!name) return adminError(reply, user, 400, '입력 오류', '보드 이름을 입력하세요.', '/admin/project-boards', '프로젝트 보드');
  await exec(
    `INSERT INTO project_boards (name, description, created_by, created_at, updated_at)
     VALUES (:name, :description, :userId, NOW(), NOW())`,
    { name, description: boundedText(body.description, 5000) || null, userId: user?.id ?? null }
  );
  return reply.redirect('/admin/project-boards');
});
app.post('/admin/project-boards/items', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return adminError(reply, user, 403, '권한 없음', '프로젝트 보드 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const boardId = nullablePositiveInt(body.boardId);
  if (!boardId || !(await projectBoardExists(boardId))) return adminError(reply, user, 400, '입력 오류', '프로젝트 보드를 선택하세요.', '/admin/project-boards', '프로젝트 보드');
  const taskId = nullablePositiveInt(body.taskId);
  if (taskId && !(await contributorTaskExists(taskId))) return adminError(reply, user, 400, '입력 오류', '연결할 작업을 찾을 수 없습니다.', '/admin/project-boards', '프로젝트 보드');
  const title = boundedText(body.title, 255);
  if (!title) return adminError(reply, user, 400, '입력 오류', '보드 항목 제목을 입력하세요.', '/admin/project-boards', '프로젝트 보드');
  await exec(
    `INSERT INTO project_board_items (board_id, task_id, title, sort_order, created_at, updated_at)
     VALUES (:boardId, :taskId, :title, :sortOrder, NOW(), NOW())`,
    {
      boardId,
      taskId,
      title,
      sortOrder: boundedUnsignedInt(body.sortOrder, 1_000_000) ?? 0
    }
  );
  return reply.redirect('/admin/project-boards');
});
app.post('/admin/project-boards/:boardId/items/:itemId', async (request, reply) => {
  const user = (request as any).user;
  if (!(await canManageContributorTasks(user))) return adminError(reply, user, 403, '권한 없음', '프로젝트 보드 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const boardId = nullablePositiveInt((request.params as any).boardId);
  const itemId = nullablePositiveInt((request.params as any).itemId);
  if (!boardId || !itemId) return adminError(reply, user, 400, '입력 오류', '보드 항목을 찾을 수 없습니다.', '/admin/project-boards', '프로젝트 보드');
  const status = body.status === undefined ? null : normalizeBoardItemStatus(body.status);
  if (body.status !== undefined && !status) return adminError(reply, user, 400, '입력 오류', '보드 항목 상태가 올바르지 않습니다.', '/admin/project-boards', '프로젝트 보드');
  const sortOrder = body.sortOrder === undefined ? null : boundedUnsignedInt(body.sortOrder, 1_000_000);
  if (body.sortOrder !== undefined && sortOrder === null) return adminError(reply, user, 400, '입력 오류', '정렬 순서는 0 이상의 숫자여야 합니다.', '/admin/project-boards', '프로젝트 보드');
  await exec(
    `UPDATE project_board_items
     SET status=COALESCE(:status,status), sort_order=COALESCE(:sortOrder,sort_order), updated_at=NOW()
     WHERE id=:itemId AND board_id=:boardId`,
    {
      boardId,
      itemId,
      status,
      sortOrder
    }
  );
  return reply.redirect('/admin/project-boards');
});

app.get('/api/admin/edit-filters', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, name, description, filter_type, pattern, action, enabled, created_by, created_at, updated_at FROM edit_filters ORDER BY enabled DESC, id DESC`);
});
app.post('/api/admin/edit-filters', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const name = boundedText(body.name, 255);
  if (!name) return reply.code(400).send({ error: 'name_required' });
  const filterType = normalizeEditFilterType(body.filterType ?? 'keyword');
  if (!filterType) return reply.code(400).send({ error: 'invalid_filter_type' });
  const action = normalizeEditFilterAction(body.action ?? 'warn');
  if (!action) return reply.code(400).send({ error: 'invalid_action' });
  const result = await exec(
    `INSERT INTO edit_filters (name, description, filter_type, pattern, action, created_by, created_at, updated_at)
     VALUES (:name, :description, :filterType, :pattern, :action, :userId, NOW(), NOW())`,
    {
      name,
      description: boundedText(body.description, 1000) || null,
      filterType,
      pattern: boundedText(body.pattern, 5000) || null,
      action,
      userId: user?.id ?? null
    }
  );
  return { id: result.insertId, ok: true };
});
app.post('/api/admin/reviews/:id/resolve', async (request, reply) => {
  const user = (request as any).user;
  try {
    return await resolvePendingReviewAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
});
app.post('/admin/reviews/:id/resolve', async (request, reply) => {
  const user = (request as any).user;
  try {
    await resolvePendingReviewAction(user, nullablePositiveInt((request.params as any).id), request.body as any);
    return reply.redirect('/admin/work');
  } catch (error: any) {
    const reviewId = nullablePositiveInt((request.params as any).id);
    return adminError(reply, user, error?.statusCode ?? 400, '검토 처리 오류', String(error?.message ?? '검토 항목을 처리할 수 없습니다.'), reviewId ? `/admin/reviews/${reviewId}` : '/admin/work', reviewId ? '검토 화면' : '검토 큐');
  }
});
app.get('/api/admin/reviews', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(
    `SELECT pr.id, pr.review_type, pr.target_id, pr.page_id, pr.submitted_by, pr.status, pr.reason, pr.payload_json, pr.reviewed_by, pr.reviewed_at, pr.created_at,
            prd.namespace_code, prd.title AS draft_title, u.username AS submitted_username
     FROM pending_reviews pr
     LEFT JOIN pending_review_drafts prd ON prd.review_id=pr.id
     LEFT JOIN users u ON u.id=pr.submitted_by
     ORDER BY FIELD(pr.status,'pending','needs_changes','approved','rejected'), pr.created_at DESC LIMIT 100`
  );
});
app.get('/admin/reviews/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  const reviewId = nullablePositiveInt((request.params as any).id);
  if (!reviewId) return reply.code(400).type('text/html').send(messagePage('잘못된 요청', '검토 번호가 올바르지 않습니다.', user, { tone: 'error', actionHref: '/admin/work', actionLabel: '검토 큐', currentSpace: 'admin' }));
  const review = await pendingReviewDetail(reviewId);
  if (!review) return reply.code(404).type('text/html').send(messagePage('검토 없음', '검토 항목을 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/admin/work', actionLabel: '검토 큐', currentSpace: 'admin' }));
  return reply.type('text/html').send(reviewDetailPage(review, user));
});
app.get('/api/admin/work', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return adminWorkItems(100);
});
app.patch('/api/admin/work/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const result = await updateAdminWorkItem(nullablePositiveInt((request.params as any).id) ?? 0, body, user?.id ?? null);
  if (!result.ok) return reply.code(400).send({ error: result.error });
  return { ok: true };
});
app.get('/admin/work', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  const [items, assignees] = await Promise.all([adminWorkItems(200), adminAssignees()]);
  return reply.type('text/html').send(adminWorkPage(items, assignees, user));
});
app.get('/admin/subwiki-requests/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const requestId = nullablePositiveInt((request.params as any).id) ?? 0;
  const [row, workItem] = await Promise.all([adminSubwikiRequest(requestId), adminWorkItemForSubwikiRequest(requestId)]);
  if (!row) return adminError(reply, user, 404, '신청 없음', '위키 신청을 찾을 수 없습니다.', '/admin/work', '업무 큐');
  return reply.type('text/html').send(adminSubwikiRequestPage(row, workItem, user));
});
app.post('/admin/subwiki-requests/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const requestId = nullablePositiveInt((request.params as any).id) ?? 0;
  const row = await adminSubwikiRequest(requestId);
  if (!row) return adminError(reply, user, 404, '신청 없음', '위키 신청을 찾을 수 없습니다.', '/admin/work', '업무 큐');
  const body = request.body as any;
  try {
    const result = await resolveSubwikiRequest(row, body, user?.id ?? null);
    if (!result.ok) return adminError(reply, user, 400, '처리 오류', result.error ?? '위키 신청을 처리할 수 없습니다.', `/admin/subwiki-requests/${requestId}`, '신청으로 돌아가기');
  } catch (error: any) {
    return adminError(reply, user, 400, '처리 오류', String(error?.message ?? error), `/admin/subwiki-requests/${requestId}`, '신청으로 돌아가기');
  }
  return reply.redirect('/admin/work');
});
app.post('/admin/work/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '관리 권한이 필요합니다.', '/login', '로그인');
  const result = await updateAdminWorkItem(nullablePositiveInt((request.params as any).id) ?? 0, request.body as any, user?.id ?? null);
  if (!result.ok) return reply.code(400).type('text/html').send(messagePage('작업 업데이트 오류', String(result.error), user, { tone: 'error', actionHref: '/admin/work', actionLabel: '운영 작업', currentSpace: 'admin' }));
  return reply.redirect('/admin/work');
});

app.get('/admin/release', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  const [status, gates, issues, blockers, contentAudits, searchAudits, securityTests, releaseSecurity, performanceChecks, releaseRehearsals] = await Promise.all([
    openBetaStatus(),
    query<any>(`SELECT id, gate_key, title, description, status, checked_by, checked_at, note FROM release_gates ORDER BY id`),
    query<any>(`SELECT id, issue_type, severity, status, title, body, reported_by, assigned_to, related_page_id, related_revision_id, created_at, updated_at, resolved_at FROM beta_issues ORDER BY FIELD(severity,'critical','high','medium','low'), FIELD(status,'open','triaged','in_progress','fixed','wontfix','duplicate'), id DESC LIMIT 100`),
    query<any>(`SELECT id, source_type, source_id, blocker_type, severity, title, description, status, assigned_to, resolved_at, created_at, updated_at FROM release_blockers ORDER BY FIELD(severity,'critical','high'), FIELD(status,'open','in_progress','resolved','waived'), id DESC LIMIT 100`),
    query<any>(
      `SELECT ca.id, ca.page_id, ca.audit_type, ca.status, ca.note, ca.audited_by, ca.audited_at, ca.created_at, p.title
       FROM content_audits ca
       LEFT JOIN pages p ON p.id=ca.page_id
       ORDER BY FIELD(ca.status,'failed','needs_fix','pending','passed'), ca.id DESC LIMIT 100`
    ),
    query<any>(
      `SELECT sa.id, sa.query, sa.expected_page_id, sa.status, sa.note, sa.audited_by, sa.audited_at, sa.created_at,
              p.title AS expected_title, p.display_title AS expected_display_title, n.code AS expected_namespace_code
       FROM search_audits sa
       LEFT JOIN pages p ON p.id=sa.expected_page_id
       LEFT JOIN namespaces n ON n.id=p.namespace_id
       ORDER BY FIELD(sa.status,'pending','needs_alias','needs_page','bad_ranking','passed'), sa.id DESC LIMIT 100`
    ),
    query<any>(`SELECT test_key, severity, status, note FROM security_test_runs ORDER BY FIELD(severity,'critical','high','medium','low'), id DESC LIMIT 80`),
    query<any>(`SELECT check_key, severity, status, note FROM security_release_checks ORDER BY FIELD(severity,'critical','high','medium','low'), id DESC LIMIT 80`),
    query<any>(`SELECT id, check_key, target_area, status, note, checked_by, checked_at, created_at FROM performance_checks ORDER BY FIELD(status,'failed','needs_work','pending','passed'), id DESC LIMIT 80`),
    query<any>(`SELECT id, run_key, scenario, status, evidence_json, note, run_by, run_at FROM release_rehearsals ORDER BY run_at DESC, id DESC LIMIT 120`)
  ]);
  return reply.type('text/html').send(
    adminReleasePage(
      {
        status,
        gates,
        issues,
        blockers,
        contentAudits,
        searchAudits,
        securityChecks: [...securityTests, ...releaseSecurity],
        performanceChecks,
        releaseRehearsals
      },
      user
    )
  );
});

app.post('/admin/release/gates/:key', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const status = normalizeReleaseGateStatus(body.status);
  if (!status) return adminError(reply, user, 400, '입력 오류', '릴리즈 게이트 상태가 올바르지 않습니다.', '/admin/release', '공개 준비');
  await exec(`UPDATE release_gates SET status=:status, checked_by=:userId, checked_at=NOW(), note=:note WHERE gate_key=:gateKey`, {
    gateKey: boundedKey((request.params as any).key, 64),
    status,
    note: boundedText(body.note, 1000) || null,
    userId: user?.id ?? null
  });
  return reply.redirect('/admin/release');
});

app.post('/admin/release/rebuild-gates', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  await rebuildReleaseGateChecks(user?.id ?? null);
  return reply.redirect('/admin/release');
});
app.post('/admin/release/rehearsal/run', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  await runReleaseRehearsal(user?.id ?? null);
  return reply.redirect('/admin/release');
});

app.post('/admin/release/issues', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  if (!title) return adminError(reply, user, 400, '입력 오류', '이슈 제목을 입력하세요.', '/admin/release', '공개 준비');
  await exec(
    `INSERT INTO beta_issues (issue_type, severity, title, body, reported_by, created_at, updated_at)
     VALUES (:issueType, :severity, :title, :body, :userId, NOW(), NOW())`,
    {
      issueType: normalizeBetaIssueType(body.issueType),
      severity: normalizeIssueSeverity(body.severity),
      title,
      body: boundedText(body.body, 5000) || null,
      userId: user?.id ?? null
    }
  );
  return reply.redirect('/admin/release');
});

app.post('/admin/release/issues/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const issueId = nullablePositiveInt((request.params as any).id);
  const status = normalizeBetaIssueStatus(body.status);
  if (!issueId || !status) return adminError(reply, user, 400, '입력 오류', '이슈 상태 변경 값이 올바르지 않습니다.', '/admin/release', '공개 준비');
  await exec(`UPDATE beta_issues SET status=:status, resolved_at=IF(:status IN ('fixed','wontfix','duplicate'), NOW(), resolved_at), updated_at=NOW() WHERE id=:id`, {
    id: issueId,
    status
  });
  return reply.redirect('/admin/release');
});

app.post('/admin/release/blockers', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  if (!title) return adminError(reply, user, 400, '입력 오류', '블로커 제목을 입력하세요.', '/admin/release', '공개 준비');
  await exec(
    `INSERT INTO release_blockers (source_type, blocker_type, severity, title, description, created_at, updated_at)
     VALUES ('manual', :blockerType, :severity, :title, :description, NOW(), NOW())`,
    {
      blockerType: normalizeReleaseBlockerType(body.blockerType),
      severity: normalizeReleaseBlockerSeverity(body.severity),
      title,
      description: boundedText(body.description, 5000) || null
    }
  );
  return reply.redirect('/admin/release');
});

app.post('/admin/release/blockers/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const blockerId = nullablePositiveInt((request.params as any).id);
  const status = normalizeReleaseBlockerStatus(body.status);
  if (!blockerId || !status) return adminError(reply, user, 400, '입력 오류', '블로커 상태 변경 값이 올바르지 않습니다.', '/admin/release', '공개 준비');
  await exec(`UPDATE release_blockers SET status=:status, resolved_at=IF(:status IN ('resolved','waived'), NOW(), resolved_at), updated_at=NOW() WHERE id=:id`, {
    id: blockerId,
    status
  });
  return reply.redirect('/admin/release');
});

app.post('/admin/release/rebuild-weekly', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  await rebuildOpenBetaWeeklyStats();
  return reply.redirect('/admin/release');
});

app.post('/admin/release/rebuild-daily', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  await rebuildDailyOperationSummary();
  return reply.redirect('/admin/release');
});

app.post('/admin/release/rebuild-stats', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '릴리즈 관리 권한이 필요합니다.', '/login', '로그인');
  await rebuildWikiDailyStats();
  await logAdmin(user?.id ?? null, 'stats.rebuild_daily', 'stats', null, {});
  return reply.redirect('/admin/release');
});

app.get('/admin/mod-verification', async (request, reply) => {
  const user = (request as any).user;
  if (!canModVerify(user)) return adminAccessDenied(reply, request, '모드 검증 권한이 필요합니다.');
  const [tasks, assignees] = await Promise.all([
    modVerificationTasks(),
    query<any>(
      `SELECT DISTINCT u.id, u.username, u.display_name
       FROM users u
       JOIN user_groups ug ON ug.user_id=u.id
       JOIN groups g ON g.id=ug.group_id
       WHERE u.status='active' AND g.code IN ('mod_editor','admin')
       ORDER BY FIELD(g.code,'mod_editor','admin'), u.display_name`
    )
  ]);
  return reply.type('text/html').send(modVerificationPage(tasks, assignees, user));
});

app.post('/admin/mod-verification/generate', async (request, reply) => {
  const user = (request as any).user;
  if (!canModVerify(user)) return adminError(reply, user, 403, '권한 없음', '모드 검증 권한이 필요합니다.', '/login', '로그인');
  await generateModVerificationTasks(user?.id ?? null);
  return reply.redirect('/admin/mod-verification');
});

app.post('/admin/mod-verification/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!canModVerify(user)) return adminError(reply, user, 403, '권한 없음', '모드 검증 권한이 필요합니다.', '/login', '로그인');
  const taskId = nullablePositiveInt((request.params as any).id);
  if (!taskId) return reply.code(400).type('text/html').send(messagePage('모드 검증 오류', '작업 번호가 올바르지 않습니다.', user, { tone: 'error', actionHref: '/admin/mod-verification', actionLabel: '모드 검증', currentSpace: 'admin' }));
  const result = await updateModVerificationTask(taskId, request.body as any, user?.id ?? null);
  if (!result.ok) return reply.code(400).type('text/html').send(messagePage('모드 검증 오류', String(result.error), user, { tone: 'error', actionHref: '/admin/mod-verification', actionLabel: '모드 검증', currentSpace: 'admin' }));
  return reply.redirect('/admin/mod-verification');
});

app.get('/admin/files', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  const [licenseIssues, unusedFiles] = await Promise.all([fileLicenseIssueRows(), unusedFileRows()]);
  return reply.type('text/html').send(adminFilesPage({ licenseIssues, unusedFiles }, user));
});

app.post('/admin/files/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '파일 관리 권한이 필요합니다.', '/login', '로그인');
  const fileId = nullablePositiveInt((request.params as any).id);
  if (!fileId) return reply.code(400).type('text/html').send(messagePage('파일 관리 오류', '파일 번호가 올바르지 않습니다.', user, { tone: 'error', actionHref: '/admin/files', actionLabel: '파일 관리', currentSpace: 'admin' }));
  const result = await updateAdminFileMetadata(fileId, request.body as any, user);
  if (!result.ok) return reply.code(400).type('text/html').send(messagePage('파일 관리 오류', String(result.error), user, { tone: 'error', actionHref: '/admin/files', actionLabel: '파일 관리', currentSpace: 'admin' }));
  return reply.redirect('/admin/files');
});

app.get('/admin/export/backup', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  return sendAdminBackup(reply);
});

app.get('/admin/export/manifest', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  const manifest = await adminExportManifest();
  if ((request.query as any).download) {
    reply.header('Content-Disposition', `attachment; filename="minewiki-backup-manifest.json"`);
    return manifest;
  }
  return reply.type('text/html').send(adminBackupManifestPage(manifest, user));
});

app.get('/api/admin/export/manifest', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  reply.header('Content-Disposition', `attachment; filename="minewiki-backup-manifest.json"`);
  return adminExportManifest();
});

async function adminExportManifest() {
  const [
    pages,
    revisions,
    files,
    spaces,
    sidebar,
    roles,
    aliases,
    claims,
    settings,
    imports
  ] = await Promise.all([
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM pages WHERE status!='deleted'`),
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM page_revisions`),
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM files WHERE status!='deleted'`),
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM wiki_spaces WHERE status!='hidden'`),
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM subwiki_sidebar_items`),
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM subwiki_roles WHERE status!='revoked'`),
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM page_aliases`),
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM server_claims`),
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM subwiki_settings`),
    one<{ count: number }>(`SELECT COUNT(*) AS count FROM gitbook_import_jobs`)
  ]);
  return {
    generatedAt: new Date().toISOString(),
    format: 'minewiki-backup-manifest-v1',
    includes: {
      pageSources: Number(pages?.count ?? 0),
      revisions: Number(revisions?.count ?? 0),
      files: Number(files?.count ?? 0),
      subwikiSettings: Number(settings?.count ?? 0),
      sidebarItems: Number(sidebar?.count ?? 0),
      subwikiRoles: Number(roles?.count ?? 0),
      searchAliases: Number(aliases?.count ?? 0),
      serverClaims: Number(claims?.count ?? 0),
      wikiSpaces: Number(spaces?.count ?? 0),
      gitbookImports: Number(imports?.count ?? 0)
    },
    excludedRegenerable: ['search_index', 'page_render_cache'],
    backupEndpoint: '/admin/export/backup'
  };
}

app.get('/api/admin/export/backup', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return sendAdminBackup(reply);
});

async function sendAdminBackup(reply: any) {
  const [
    pages,
    revisions,
    files,
    fileUsages,
    spaces,
    settings,
    sidebar,
    roles,
    aliases,
    serverClaims,
    serverOwners,
    gitbookImports
  ] = await Promise.all([
    query<any>(
      `SELECT p.id, n.code AS namespace_code, p.space_id, p.local_path, p.slug, p.title, p.display_title, p.current_revision_id, p.page_type, p.protection_level, p.status, p.created_by, p.created_at, p.updated_at,
        r.content_raw AS current_content
       FROM pages p
       JOIN namespaces n ON n.id=p.namespace_id
       LEFT JOIN page_revisions r ON r.id=p.current_revision_id
       WHERE p.status!='deleted'
       ORDER BY p.id`
    ),
    query<any>(
      `SELECT id, page_id, revision_no, parent_revision_id, content_raw, content_ast, content_hash, content_size, syntax_version, edit_summary, is_minor, edit_tags, created_by, created_at, visibility
       FROM page_revisions ORDER BY page_id, revision_no`
    ),
    query<any>(
      `SELECT id, uploader_id, original_name, storage_key, mime_type, size_bytes, width, height, sha256, license, source_url, source_text, status, created_at
       FROM files WHERE status!='deleted' ORDER BY id`
    ),
    query<any>(`SELECT file_id, page_id, usage_context, created_at FROM file_usages ORDER BY file_id, page_id`),
    query<any>(`SELECT ${wikiSpaceBackupFields} FROM wiki_spaces WHERE status!='hidden' ORDER BY id`),
    query<any>(`SELECT ${subwikiSettingsBackupFields} FROM subwiki_settings ORDER BY space_id`),
    query<any>(`SELECT ${subwikiSidebarBackupFields} FROM subwiki_sidebar_items ORDER BY space_id, sort_order, id`),
    query<any>(`SELECT ${subwikiRoleBackupFields} FROM subwiki_roles WHERE status!='revoked' ORDER BY space_id, user_id, role`),
    query<any>(`SELECT ${pageAliasBackupFields} FROM page_aliases ORDER BY namespace_id, alias_slug`),
    query<any>(
      `SELECT id, page_id, user_id, method, status, verified_at, last_verified_at, renewal_required_at, expires_at, created_at, updated_at,
              token_hash IS NOT NULL AS has_token_hash
       FROM server_claims ORDER BY page_id, id`
    ),
    query<any>(`SELECT ${serverOwnerFields} FROM server_owners WHERE status='active' ORDER BY page_id, user_id`),
    query<any>(`SELECT id, space_id, requested_by, source_type, status, imported_pages, source_note, error_message, created_at, updated_at FROM gitbook_import_jobs ORDER BY id`)
  ]);
  reply.header('Content-Disposition', `attachment; filename="minewiki-backup.json"`);
  return {
    generatedAt: new Date().toISOString(),
    format: 'minewiki-backup-v1',
    excludedRegenerable: ['search_index', 'page_render_cache'],
    pages,
    revisions,
    files,
    fileUsages,
    wikiSpaces: spaces,
    subwikiSettings: settings,
    subwikiSidebarItems: sidebar,
    subwikiRoles: roles,
    searchAliases: aliases,
    serverClaims,
    serverOwners,
    gitbookImports
  };
}

app.post('/api/admin/search/pins', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const pageId = nullablePositiveInt(body.pageId);
  const searchQuery = normalizeTitle(body.query ?? '');
  if (!searchQuery || !pageId) return reply.code(400).send({ error: 'query_and_page_required' });
  const page = await getPageById(pageId);
  if (!page || String(page.status ?? '') === 'deleted') return reply.code(404).send({ error: 'page_not_found' });
  await exec(
    `INSERT INTO search_pins (query, page_id, note, created_by, created_at)
     VALUES (:query, :pageId, :note, :userId, NOW())
     ON DUPLICATE KEY UPDATE enabled=1, note=VALUES(note)`,
    { query: searchQuery, pageId, note: body.note ?? null, userId: user?.id ?? null }
  );
  return { ok: true };
});

app.post('/api/admin/search/disambiguations', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const searchQuery = normalizeTitle(body.query ?? '');
  const pageId = nullablePositiveInt(body.pageId);
  if (!searchQuery || !pageId) return reply.code(400).send({ error: 'query_and_page_required' });
  const page = await getPageById(pageId);
  if (!page || String(page.status ?? '') === 'deleted') return reply.code(404).send({ error: 'page_not_found' });
  await exec(
    `INSERT INTO search_disambiguation_candidates (query, normalized_query, page_id, label, note, weight, enabled, created_by, created_at)
     VALUES (:query, :normalized, :pageId, :label, :note, :weight, :enabled, :userId, NOW())
     ON DUPLICATE KEY UPDATE normalized_query=VALUES(normalized_query), label=VALUES(label), note=VALUES(note), weight=VALUES(weight), enabled=VALUES(enabled)`,
    {
      query: searchQuery,
      normalized: normalizeSearch(searchQuery),
      pageId,
      label: body.label || null,
      note: body.note || null,
      weight: nullablePositiveInt(body.weight) ?? 100,
      enabled: body.enabled === false ? 0 : 1,
      userId: user?.id ?? null
    }
  );
  return { ok: true };
});
app.post('/api/admin/consistency/run', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return runConsistencyChecks(Boolean((request.body as any)?.autoFix));
});
app.get('/admin/jobs', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  return reply.type('text/html').send(adminJobsPage(await adminJobRows(200), user));
});
app.post('/admin/jobs', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '작업 큐 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const jobType = normalizeJobType(body.jobType);
  if (!jobType) return adminError(reply, user, 400, '작업 추가 오류', '작업 종류를 확인해 주세요.', '/admin/jobs', '작업 큐');
  const payload = normalizeJobPayload(jobType, {
    pageId: body.pageId,
    limit: body.limit,
    autoFix: Boolean(body.autoFix)
  });
  if (['render_page', 'reindex_page', 'rebuild_links', 'rebuild_categories'].includes(jobType)) {
    const page = await getPageById(Number((payload as any).pageId));
    if (!page) return adminError(reply, user, 400, '작업 추가 오류', '대상 문서를 번호로 입력해 주세요.', '/admin/jobs', '작업 큐');
  }
  const runAfter = normalizeRunAfter(body.runAfter);
  const jobId = await enqueueJob(jobType, payload, runAfter);
  await logAdmin(user?.id ?? null, 'job.enqueue', 'job', jobId, { jobType });
  return reply.redirect('/admin/jobs');
});
app.post('/admin/jobs/run-next', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '작업 큐 관리 권한이 필요합니다.', '/login', '로그인');
  await runNextJob();
  await logAdmin(user?.id ?? null, 'job.run_next', 'job', null, {});
  return reply.redirect('/admin/jobs');
});

app.post('/admin/jobs/sync-spaces', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '작업 큐 관리 권한이 필요합니다.', '/login', '로그인');
  await syncPageSpaces();
  await logAdmin(user?.id ?? null, 'spaces.sync_pages', 'wiki_space', null, {});
  return reply.redirect('/admin/jobs');
});

app.get('/admin/imports', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  return reply.type('text/html').send(adminImportsPage(await adminImportDashboardData(), user));
});

app.get('/admin/subwikis', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request);
  return reply.type('text/html').send(adminSubwikisPage(await adminSubwikiDashboardData(), user));
});

app.post('/admin/subwikis/server', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle') && !can(user, 'server.official_edit')) return adminError(reply, user, 403, '권한 없음', '서버 위키 생성 권한이 필요합니다.', '/login', '로그인');
  try {
    await createServerSubwiki(request.body as any, user?.id ?? null);
    await logAdmin(user?.id ?? null, 'subwiki.server.create', 'wiki_space', null, {});
  } catch (error: any) {
    return adminError(reply, user, 400, '서버 위키 생성 오류', subwikiErrorLabel(error.message), '/admin/subwikis', '서브위키 관리');
  }
  return reply.redirect('/admin/subwikis');
});

app.post('/admin/subwikis/mod', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '모드 위키 생성 권한이 필요합니다.', '/login', '로그인');
  try {
    await createModSubwiki(request.body as any, user?.id ?? null);
    await logAdmin(user?.id ?? null, 'subwiki.mod.create', 'wiki_space', null, {});
  } catch (error: any) {
    return adminError(reply, user, 400, '모드 위키 생성 오류', subwikiErrorLabel(error.message), '/admin/subwikis', '서브위키 관리');
  }
  return reply.redirect('/admin/subwikis');
});

app.post('/admin/subwikis/:code/status', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '서브위키 상태 관리 권한이 필요합니다.', '/login', '로그인');
  const result = await updateSubwikiStatus(String((request.params as any).code ?? ''), request.body as any, user?.id ?? null);
  if (!result.ok) return adminError(reply, user, result.status, '상태 변경 오류', subwikiErrorLabel(result.error), '/admin/subwikis', '서브위키 관리');
  await logAdmin(user?.id ?? null, 'subwiki.status.update', 'wiki_space', result.spaceId, { status: result.statusValue });
  return reply.redirect('/admin/subwikis');
});

app.post('/admin/subwikis/:code/sidebar', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '사이드바 관리 권한이 필요합니다.', '/login', '로그인');
  const result = await addSubwikiSidebarItem(String((request.params as any).code ?? ''), request.body as any);
  if (!result.ok) return adminError(reply, user, result.status, '사이드바 추가 오류', subwikiErrorLabel(result.error), '/admin/subwikis', '서브위키 관리');
  await logAdmin(user?.id ?? null, 'subwiki.sidebar.create', 'wiki_space', result.spaceId, {});
  return reply.redirect('/admin/subwikis');
});

app.post('/admin/mod-wikis/:slug/creator-verification', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '모드 제작자 확인 권한이 필요합니다.', '/login', '로그인');
  const result = await updateModCreatorVerification(String((request.params as any).slug ?? ''), request.body as any, user?.id ?? null);
  if (!result.ok) return adminError(reply, user, result.status, '제작자 확인 오류', subwikiErrorLabel(result.error), '/admin/subwikis', '서브위키 관리');
  await logAdmin(user?.id ?? null, 'mod.creator_verification.update', 'mod_wiki', null, { slug: result.slug, creatorVerified: result.creatorVerified });
  return reply.redirect('/admin/subwikis');
});

app.post('/admin/servers/:pageId/status', async (request, reply) => {
  const user = (request as any).user;
  try {
    await updateServerStatusAction(user, nullablePositiveInt((request.params as any).pageId), request.body as any);
    return reply.redirect('/admin/subwikis');
  } catch (error: any) {
    return adminError(reply, user, error?.statusCode ?? 400, '서버 상태 오류', String(error?.message ?? '서버 상태를 변경할 수 없습니다.'), '/admin/subwikis', '서브위키 관리');
  }
});

app.post('/admin/imports/markdown', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '이전 작업 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const spaceId = nullablePositiveInt(body.spaceId);
  if (body.spaceId && (!spaceId || !(await wikiSpaceExists(spaceId)))) return adminError(reply, user, 400, 'Markdown 작업 오류', '연결할 위키 공간을 확인해 주세요.', '/admin/imports', '이전 작업');
  const sourceType = normalizeMarkdownImportSourceType(body.sourceType ?? 'markdown');
  if (!sourceType) return adminError(reply, user, 400, 'Markdown 작업 오류', '소스 유형을 확인해 주세요.', '/admin/imports', '이전 작업');
  const sourceName = boundedText(body.sourceName, 255);
  if (!sourceName) return adminError(reply, user, 400, 'Markdown 작업 오류', '소스 이름을 입력해 주세요.', '/admin/imports', '이전 작업');
  await exec(
    `INSERT INTO markdown_import_jobs (space_id, source_type, source_name, checklist_json, created_by, created_at, updated_at)
     VALUES (:spaceId, :sourceType, :sourceName, :checklist, :userId, NOW(), NOW())`,
    { spaceId: spaceId ?? null, sourceType, sourceName, checklist: markdownChecklistJson(checklistLines(body.checklist)), userId: user?.id ?? null }
  );
  await logAdmin(user?.id ?? null, 'markdown_import.create', 'markdown_import', null, { sourceType });
  return reply.redirect('/admin/imports');
});

app.post('/admin/imports/gitbook', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '이전 작업 관리 권한이 필요합니다.', '/login', '로그인');
  const body = request.body as any;
  const spaceId = nullablePositiveInt(body.spaceId);
  if (!spaceId || !(await wikiSpaceExists(spaceId))) return adminError(reply, user, 400, 'GitBook 작업 오류', '대상 위키 공간을 선택해 주세요.', '/admin/imports', '이전 작업');
  const sourceType = normalizeGitbookImportSourceType(body.sourceType ?? 'manual');
  if (!sourceType) return adminError(reply, user, 400, 'GitBook 작업 오류', '소스 유형을 확인해 주세요.', '/admin/imports', '이전 작업');
  const checklist = checklistLines(body.checklist);
  const mapping = boundedJsonString({ checklist: checklist.length ? checklist : ['접속 문서', '규칙 문서', '공지 문서', '사이드바 매핑'] }, 25_000);
  if (!mapping) return adminError(reply, user, 400, 'GitBook 작업 오류', '체크리스트가 너무 깁니다.', '/admin/imports', '이전 작업');
  const result = await exec(
    `INSERT INTO gitbook_import_jobs (space_id, requested_by, source_type, source_note, mapping_json, created_at, updated_at)
     VALUES (:spaceId, :userId, :sourceType, :sourceNote, :mapping, NOW(), NOW())`,
    { spaceId, userId: user?.id ?? 0, sourceType, sourceNote: boundedText(body.sourceNote, 5000) || null, mapping }
  );
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
     VALUES ('gitbook_import', 'gitbook_import', :id, 'normal', NOW(), NOW())`,
    { id: result.insertId }
  );
  await logAdmin(user?.id ?? null, 'gitbook_import.create', 'gitbook_import', result.insertId, { sourceType });
  return reply.redirect('/admin/imports');
});

app.post('/admin/imports/gitbook/:id/run', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return adminError(reply, user, 403, '권한 없음', '이전 작업 관리 권한이 필요합니다.', '/login', '로그인');
  const jobId = nullablePositiveInt((request.params as any).id);
  if (!jobId) return adminError(reply, user, 400, '이전 실행 오류', '작업 번호가 올바르지 않습니다.', '/admin/imports', '이전 작업');
  const job = await gitbookImportJob(jobId);
  if (!job) return adminError(reply, user, 404, '이전 실행 오류', '이전 작업을 찾을 수 없습니다.', '/admin/imports', '이전 작업');
  const body = request.body as any;
  const payload = normalizeGitbookImportPayload({ markdown: body.markdown, summary: body.summary });
  if (!payload) return adminError(reply, user, 400, '이전 실행 오류', 'Markdown 본문이나 SUMMARY.md 내용이 너무 큽니다.', '/admin/imports', '이전 작업');
  try {
    await runGitbookImport(job, payload, user?.id ?? null);
    await logAdmin(user?.id ?? null, 'gitbook_import.run', 'gitbook_import', job.id, {});
  } catch (error: any) {
    await exec(`UPDATE gitbook_import_jobs SET status='failed', error_message=:message, updated_at=NOW() WHERE id=:id`, {
      id: job.id,
      message: error.message
    });
    return adminError(reply, user, 400, '이전 실행 오류', importErrorLabel(error.message), '/admin/imports', '이전 작업');
  }
  return reply.redirect('/admin/imports');
});

app.get('/api/admin/jobs', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return adminJobRows(200);
});
app.post('/api/admin/jobs', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const jobType = normalizeJobType(body.jobType);
  if (!jobType) return reply.code(400).send({ error: 'invalid_job_type' });
  const payload = normalizeJobPayload(jobType, body.payload ?? {});
  if (['render_page', 'reindex_page', 'rebuild_links', 'rebuild_categories'].includes(jobType)) {
    const page = await getPageById(Number((payload as any).pageId));
    if (!page) return reply.code(404).send({ error: 'page_not_found' });
  }
  return { id: await enqueueJob(jobType, payload, normalizeRunAfter(body.runAfter)), ok: true };
});
app.post('/api/admin/jobs/run-next', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return (await runNextJob()) ?? { ok: true, empty: true };
});
app.post('/api/beta/feedback', async (request, reply) => {
  return createBetaFeedback(request, reply, false);
});

async function createBetaFeedback(request: any, reply: any, htmlRedirect: boolean) {
  const user = request.user;
  if (!consumeActorRateLimit(request, 'beta-feedback', 10, 30, 60 * 60 * 1000)) {
    if (htmlRedirect) return htmlError(reply, user, 429, '피드백 제한', '짧은 시간 안에 피드백 요청이 너무 많습니다. 잠시 후 다시 시도하세요.', '/beta', '가입 안내');
    return reply.code(429).send({ error: 'rate_limited' });
  }
  if (!(await requireAnonymousTurnstile(request, reply, 'beta_feedback'))) return reply;
  const body = (request.body ?? {}) as any;
  const title = normalizeTitle(body.title ?? '');
  const feedbackBody = boundedText(body.body, 4000);
  if (!title || !feedbackBody) {
    if (htmlRedirect) return htmlError(reply, user, 400, '피드백 입력 오류', '제목과 내용을 모두 입력해 주세요.', '/beta', '가입 안내');
    return reply.code(400).send({ ok: false, error: 'title_and_body_required' });
  }
  const result = await exec(
    `INSERT INTO beta_feedback (user_id, feedback_type, page_id, title, body, created_at)
     VALUES (:userId, :feedbackType, :pageId, :title, :body, NOW())`,
    {
      userId: (request as any).user?.id ?? null,
      feedbackType: normalizeFeedbackType(body.feedbackType),
      pageId: nullablePositiveInt(body.pageId),
      title: title.slice(0, 255),
      body: feedbackBody
    }
  );
  if (htmlRedirect || body.redirectTo) return reply.redirect(safeLocalRedirect(body.redirectTo || '/beta?feedback=sent'));
  return { id: result.insertId, ok: true };
}
app.post('/api/admin/stats/rebuild', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  await rebuildWikiDailyStats();
  return { ok: true };
});

async function rebuildWikiDailyStats() {
  await exec(
    `REPLACE INTO wiki_daily_stats
     (stat_date, page_creates, edits, rollbacks, reports, pending_reviews, search_queries, zero_result_searches, new_users, active_users, mod_verifications, server_claims, created_at, updated_at)
     SELECT CURDATE(),
       (SELECT COUNT(*) FROM recent_changes WHERE change_type='create' AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM recent_changes WHERE change_type='edit' AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM page_revision_actions WHERE action='rollback' AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM reports WHERE created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM pending_reviews WHERE status='pending'),
       (SELECT COUNT(*) FROM search_query_logs WHERE created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM search_query_logs WHERE result_count=0 AND created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM users WHERE created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(DISTINCT created_by) FROM page_revisions WHERE created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM mod_verification_tasks WHERE status='done' AND updated_at >= CURDATE() AND updated_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       (SELECT COUNT(*) FROM server_claims WHERE created_at >= CURDATE() AND created_at < DATE_ADD(CURDATE(), INTERVAL 1 DAY)),
       NOW(), NOW()`
  );
}

app.get('/api/beta/issues', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, issue_type, severity, status, title, body, reported_by, assigned_to, related_page_id, related_revision_id, created_at, updated_at, resolved_at FROM beta_issues ORDER BY FIELD(severity,'critical','high','medium','low'), id DESC LIMIT 100`);
});
app.post('/api/beta/issues', async (request, reply) => {
  return createBetaIssue(request, reply, false);
});

async function createBetaIssue(request: any, reply: any, htmlRedirect: boolean) {
  const user = request.user;
  if (!consumeActorRateLimit(request, 'beta-issue', 10, 30, 60 * 60 * 1000)) {
    if (htmlRedirect) return htmlError(reply, user, 429, '문제 신고 제한', '짧은 시간 안에 문제 신고가 너무 많습니다. 잠시 후 다시 시도하세요.', '/beta', '가입 안내');
    return reply.code(429).send({ error: 'rate_limited' });
  }
  if (!(await requireAnonymousTurnstile(request, reply, 'beta_issue'))) return reply;
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  const issueBody = boundedText(body.body, 4000);
  if (htmlRedirect && (!title || !issueBody)) {
    return htmlError(reply, user, 400, '문제 신고 입력 오류', '제목과 재현 내용을 모두 입력해 주세요.', '/beta', '가입 안내');
  }
  const result = await exec(
    `INSERT INTO beta_issues (issue_type, severity, title, body, reported_by, related_page_id, related_revision_id, created_at, updated_at)
     VALUES (:issueType, :severity, :title, :body, :userId, :pageId, :revisionId, NOW(), NOW())`,
    {
      issueType: normalizeBetaIssueType(body.issueType),
      severity: normalizeIssueSeverity(body.severity),
      title: title || '제목 없음',
      body: issueBody || null,
      userId: user?.id ?? null,
      pageId: nullablePositiveInt(body.pageId),
      revisionId: nullablePositiveInt(body.revisionId)
    }
  );
  if (htmlRedirect || body.redirectTo) return reply.redirect(safeLocalRedirect(body.redirectTo || '/beta?issue=sent'));
  return { id: result.insertId, ok: true };
}
app.patch('/api/beta/issues/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const issueId = nullablePositiveInt((request.params as any).id);
  const status = body.status === undefined ? null : normalizeBetaIssueStatus(body.status);
  if (!issueId || (body.status !== undefined && !status)) return reply.code(400).send({ error: 'invalid_issue_update' });
  const assignedTo = await activeUserIdOrNull(body.assignedTo);
  if (body.assignedTo !== undefined && body.assignedTo !== null && body.assignedTo !== '' && assignedTo === null) return reply.code(400).send({ error: 'invalid_assignee' });
  await exec(
    `UPDATE beta_issues SET status=COALESCE(:status,status), assigned_to=COALESCE(:assignedTo,assigned_to),
     resolved_at=IF(:status IN ('fixed','wontfix','duplicate'), NOW(), resolved_at), updated_at=NOW() WHERE id=:id`,
    { id: issueId, status, assignedTo }
  );
  return { ok: true };
});

app.get('/api/admin/release-gates', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, gate_key, title, description, status, checked_by, checked_at, note FROM release_gates ORDER BY id`);
});
app.patch('/api/admin/release-gates/:key', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const status = normalizeReleaseGateStatus(body.status);
  if (!status) return reply.code(400).send({ error: 'invalid_status' });
  await exec(
    `UPDATE release_gates SET status=:status, checked_by=:userId, checked_at=NOW(), note=:note WHERE gate_key=:gateKey`,
    { gateKey: boundedKey((request.params as any).key, 64), status, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  return { ok: true };
});
app.get('/api/admin/release-rehearsals', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, run_key, scenario, status, evidence_json, note, run_by, run_at FROM release_rehearsals ORDER BY run_at DESC, id DESC LIMIT 200`);
});
app.post('/api/admin/release-rehearsals/run', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return runReleaseRehearsal(user?.id ?? null);
});
app.get('/api/open-beta/status', async () => publicOpenBetaStatus());

async function openBetaStatus() {
  const [gates, issues, audits, security, blockers, permissions, releaseSecurity, performance, settings, fileLicenses, rehearsalRun, rehearsals] = await Promise.all([
    query<any>(`SELECT status, COUNT(*) count FROM release_gates GROUP BY status`),
    query<any>(`SELECT severity, status, COUNT(*) count FROM beta_issues GROUP BY severity, status`),
    query<any>(`SELECT status, COUNT(*) count FROM content_audits GROUP BY status`),
    query<any>(`SELECT status, severity, COUNT(*) count FROM security_test_runs GROUP BY status, severity`),
    query<any>(`SELECT severity, status, COUNT(*) count FROM release_blockers GROUP BY severity, status`),
    query<any>(`SELECT status, COUNT(*) count FROM permission_audits GROUP BY status`),
    query<any>(`SELECT status, severity, COUNT(*) count FROM security_release_checks GROUP BY status, severity`),
    query<any>(`SELECT status, COUNT(*) count FROM performance_checks GROUP BY status`),
    one<any>(`SELECT ${openBetaSettingsFields} FROM open_beta_settings WHERE id=1`),
    releaseFileLicenseStats(),
    one<any>(`SELECT run_key, MAX(run_at) AS run_at FROM release_rehearsals GROUP BY run_key ORDER BY run_at DESC LIMIT 1`),
    query<any>(
      `SELECT rr.status, COUNT(*) count
       FROM release_rehearsals rr
       JOIN (SELECT run_key FROM release_rehearsals ORDER BY run_at DESC, id DESC LIMIT 1) latest ON latest.run_key=rr.run_key
       GROUP BY rr.status`
    )
  ]);
  const blockingIssues = issues
    .filter((row) => ['critical', 'high'].includes(row.severity) && !['fixed', 'wontfix', 'duplicate'].includes(row.status))
    .reduce((sum, row) => sum + Number(row.count), 0);
  const failedGates = gates.filter((row) => row.status === 'failed').reduce((sum, row) => sum + Number(row.count), 0);
  const incompleteGates = gates.filter((row) => !['passed', 'waived'].includes(row.status)).reduce((sum, row) => sum + Number(row.count), 0);
  const openBlockers = blockers.filter((row) => ['open', 'in_progress'].includes(row.status)).reduce((sum, row) => sum + Number(row.count), 0);
  const failedPermissions = permissions.filter((row) => row.status === 'failed').reduce((sum, row) => sum + Number(row.count), 0);
  const failedReleaseSecurity = releaseSecurity
    .filter((row) => ['failed', 'pending'].includes(row.status) && ['critical', 'high'].includes(row.severity))
    .reduce((sum, row) => sum + Number(row.count), 0);
  const failedPerformance = performance.filter((row) => row.status === 'failed').reduce((sum, row) => sum + Number(row.count), 0);
  const licenseBlockers = Number(fileLicenses?.license_needed ?? 0);
  const incompleteRehearsals =
    !rehearsalRun ||
    rehearsals
      .filter((row) => !['passed', 'waived'].includes(row.status))
      .reduce((sum, row) => sum + Number(row.count), 0) > 0;
  return {
    ready:
      blockingIssues === 0 &&
      failedGates === 0 &&
      incompleteGates === 0 &&
      openBlockers === 0 &&
      failedPermissions === 0 &&
      failedReleaseSecurity === 0 &&
      failedPerformance === 0 &&
      licenseBlockers === 0 &&
      !incompleteRehearsals,
    settings,
    gates,
    issues,
    audits,
    security,
    blockers,
    permissions,
    releaseSecurity,
    performance,
    fileLicenses,
    rehearsalRun,
    rehearsals
  };
}

async function publicOpenBetaStatus() {
  const status = await openBetaStatus();
  return {
    ready: Boolean(status.ready),
    settings: publicOpenBetaSettings(status.settings),
    fileLicenses: {
      used_files: Number(status.fileLicenses?.used_files ?? 0),
      license_needed: Number(status.fileLicenses?.license_needed ?? 0)
    }
  };
}

function publicOpenBetaSettings(settings: any) {
  return {
    signup_mode: settings?.signup_mode ?? 'closed',
    new_user_review_required: Boolean(settings?.new_user_review_required),
    server_listing_mode: settings?.server_listing_mode ?? 'verified_or_owner',
    updated_at: settings?.updated_at ?? null
  };
}

async function releaseFileLicenseStats() {
  const row = await one<any>(
    `SELECT
       COUNT(*) AS used_files,
       SUM(CASE WHEN f.license IS NULL OR f.license='' OR f.license='license_needed' THEN 1 ELSE 0 END) AS license_needed
     FROM files f
     JOIN file_usages fu ON fu.file_id=f.id
     JOIN pages p ON p.id=fu.page_id
     WHERE f.status='normal' AND p.status!='deleted'`
  );
  return { used_files: Number(row?.used_files ?? 0), license_needed: Number(row?.license_needed ?? 0) };
}

async function runReleaseRehearsal(userId: number | null) {
  const runKey = `rehearsal-${new Date().toISOString().replace(/[-:.TZ]/g, '').slice(0, 14)}`;
  const scenarios = [
    {
      scenario: 'signup',
      test: async () => {
        const [settings, users] = await Promise.all([
          one<any>(`SELECT signup_mode, new_user_review_required FROM open_beta_settings WHERE id=1`),
          one<any>(`SELECT COUNT(*) count FROM users`)
        ]);
        return {
          status: settings ? 'passed' : 'failed',
          note: settings ? `가입 설정 확인: ${settings.signup_mode}` : 'open_beta_settings 설정 없음',
          evidence: { settings, users: Number(users?.count ?? 0) }
        };
      }
    },
    {
      scenario: 'edit',
      test: async () => {
        const revisions = await one<any>(`SELECT COUNT(*) count FROM page_revisions`);
        const count = Number(revisions?.count ?? 0);
        return { status: count > 0 ? 'passed' : 'failed', note: `저장된 리비전 ${count}건`, evidence: { revisions: count } };
      }
    },
    {
      scenario: 'edit_filter',
      test: async () => {
        const [filters, hits] = await Promise.all([
          one<any>(`SELECT COUNT(*) count FROM edit_filters WHERE enabled=1 AND action IN ('block_save','require_review')`),
          one<any>(`SELECT COUNT(*) count FROM edit_filter_hits`)
        ]);
        const count = Number(filters?.count ?? 0);
        return { status: count > 0 ? 'passed' : 'failed', note: `차단/검토 필터 ${count}개`, evidence: { filters: count, hits: Number(hits?.count ?? 0) } };
      }
    },
    {
      scenario: 'pending_review',
      test: async () => {
        const [pending, reviewFilters] = await Promise.all([
          one<any>(`SELECT COUNT(*) count FROM pending_reviews WHERE status='pending'`),
          one<any>(`SELECT COUNT(*) count FROM edit_filters WHERE enabled=1 AND action='require_review'`)
        ]);
        const filterCount = Number(reviewFilters?.count ?? 0);
        return { status: filterCount > 0 ? 'passed' : 'failed', note: `검토 큐 연결 필터 ${filterCount}개`, evidence: { pending: Number(pending?.count ?? 0), review_filters: filterCount } };
      }
    },
    {
      scenario: 'server_claim',
      test: async () => {
        const [claims, serverPages] = await Promise.all([
          one<any>(`SELECT COUNT(*) count FROM server_claims`),
          one<any>(`SELECT COUNT(*) count FROM pages WHERE space_id=(SELECT id FROM wiki_spaces WHERE code='server' LIMIT 1)`)
        ]);
        const pageCount = Number(serverPages?.count ?? 0);
        return { status: pageCount > 0 ? 'passed' : 'failed', note: `서버 문서 ${pageCount}건, 인증 요청 ${Number(claims?.count ?? 0)}건`, evidence: { claims: Number(claims?.count ?? 0), server_pages: pageCount } };
      }
    },
    {
      scenario: 'permission_denial',
      test: async () => {
        const [total, failed] = await Promise.all([
          one<any>(`SELECT COUNT(*) count FROM permission_audits`),
          one<any>(`SELECT COUNT(*) count FROM permission_audits WHERE status='failed'`)
        ]);
        const auditCount = Number(total?.count ?? 0);
        const failedCount = Number(failed?.count ?? 0);
        return { status: auditCount > 0 && failedCount === 0 ? 'passed' : 'failed', note: `권한 감사 ${auditCount}건, 실패 ${failedCount}건`, evidence: { audits: auditCount, failed: failedCount } };
      }
    },
    {
      scenario: 'mod_link_review',
      test: async () => {
        const [tasks, reviews] = await Promise.all([
          one<any>(`SELECT COUNT(*) count FROM mod_verification_tasks`),
          one<any>(`SELECT COUNT(*) count FROM pending_reviews WHERE review_type='mod_link'`)
        ]);
        const taskCount = Number(tasks?.count ?? 0);
        return { status: taskCount > 0 ? 'passed' : 'failed', note: `모드 검증 작업 ${taskCount}건`, evidence: { tasks: taskCount, mod_link_reviews: Number(reviews?.count ?? 0) } };
      }
    },
    {
      scenario: 'file_license',
      test: async () => {
        const stats = await releaseFileLicenseStats();
        return { status: stats.license_needed === 0 ? 'passed' : 'failed', note: `사용 파일 ${stats.used_files}건, 라이선스 누락 ${stats.license_needed}건`, evidence: stats };
      }
    },
    {
      scenario: 'report',
      test: async () => {
        const [openReports, workItems] = await Promise.all([
          one<any>(`SELECT COUNT(*) count FROM reports WHERE status IN ('open','reviewing')`),
          one<any>(`SELECT COUNT(*) count FROM admin_work_items WHERE work_type='report'`)
        ]);
        return { status: 'passed', note: `열린 신고 ${Number(openReports?.count ?? 0)}건`, evidence: { open_reports: Number(openReports?.count ?? 0), report_work_items: Number(workItems?.count ?? 0) } };
      }
    },
    {
      scenario: 'revision_visibility',
      test: async () => {
        const [logs, hidden] = await Promise.all([
          one<any>(`SELECT COUNT(*) count FROM revision_visibility_logs`),
          one<any>(`SELECT COUNT(*) count FROM page_revisions WHERE visibility IN ('hidden','admin_only')`)
        ]);
        return { status: 'passed', note: `숨김 로그 ${Number(logs?.count ?? 0)}건`, evidence: { logs: Number(logs?.count ?? 0), hidden_revisions: Number(hidden?.count ?? 0) } };
      }
    },
    {
      scenario: 'search_alias',
      test: async () => {
        const [dictionary, pins, zeroResults] = await Promise.all([
          one<any>(`SELECT COUNT(*) count FROM search_dictionary WHERE enabled=1`),
          one<any>(`SELECT COUNT(*) count FROM search_pins`),
          one<any>(`SELECT COUNT(*) count FROM search_query_logs WHERE result_count=0`)
        ]);
        const dictionaryCount = Number(dictionary?.count ?? 0);
        const pinCount = Number(pins?.count ?? 0);
        return { status: dictionaryCount + pinCount > 0 ? 'passed' : 'failed', note: `검색 사전 ${dictionaryCount}건, 고정 ${pinCount}건`, evidence: { dictionary: dictionaryCount, pins: pinCount, zero_results: Number(zeroResults?.count ?? 0) } };
      }
    },
    {
      scenario: 'job_retry',
      test: async () => {
        const [failed, retryable] = await Promise.all([
          one<any>(`SELECT COUNT(*) count FROM job_queue WHERE status='failed'`),
          one<any>(`SELECT COUNT(*) count FROM job_queue WHERE status='failed' AND attempts < max_attempts`)
        ]);
        return { status: 'passed', note: `실패 작업 ${Number(failed?.count ?? 0)}건, 재시도 가능 ${Number(retryable?.count ?? 0)}건`, evidence: { failed_jobs: Number(failed?.count ?? 0), retryable_jobs: Number(retryable?.count ?? 0) } };
      }
    }
  ];
  const results = [];
  for (const item of scenarios) {
    const result = await item.test();
    results.push({ scenario: item.scenario, ...result });
    await exec(
      `INSERT INTO release_rehearsals (run_key, scenario, status, evidence_json, note, run_by, run_at)
       VALUES (:runKey, :scenario, :status, :evidenceJson, :note, :userId, NOW())`,
      {
        runKey,
        scenario: item.scenario,
        status: result.status,
        evidenceJson: JSON.stringify(result.evidence),
        note: result.note,
        userId
      }
    );
  }
  const failed = results.filter((row) => !['passed', 'waived'].includes(row.status));
  await exec(
    `INSERT INTO release_gates (gate_key, title, description, status, checked_by, checked_at, note)
     VALUES ('auto_final_rehearsal_clear', '자동 점검: 최종 리허설 통과', '정식 공개 전 운영 시나리오 리허설', :status, :userId, NOW(), :note)
     ON DUPLICATE KEY UPDATE status=VALUES(status), checked_by=VALUES(checked_by), checked_at=NOW(), note=VALUES(note)`,
    {
      status: failed.length > 0 ? 'failed' : 'passed',
      userId,
      note: JSON.stringify({ run_key: runKey, failed: failed.map((row) => row.scenario) })
    }
  );
  return { ok: true, runKey, passed: failed.length === 0, results };
}

async function rebuildReleaseGateChecks(userId: number | null) {
  const status = await openBetaStatus();
  const checks = [
    {
      key: 'auto_beta_issue_clear',
      title: '자동 점검: 고위험 베타 이슈 없음',
      failed: status.issues.some((row: any) => ['critical', 'high'].includes(row.severity) && !['fixed', 'wontfix', 'duplicate'].includes(row.status)),
      note: JSON.stringify(status.issues)
    },
    {
      key: 'auto_release_blocker_clear',
      title: '자동 점검: 열린 릴리즈 블로커 없음',
      failed: status.blockers.some((row: any) => ['open', 'in_progress'].includes(row.status)),
      note: JSON.stringify(status.blockers)
    },
    {
      key: 'auto_permission_audit_clear',
      title: '자동 점검: 권한 감사 실패 없음',
      failed: status.permissions.some((row: any) => row.status === 'failed'),
      note: JSON.stringify(status.permissions)
    },
    {
      key: 'auto_security_release_clear',
      title: '자동 점검: 고위험 보안 최종 점검 통과',
      failed: status.releaseSecurity.some((row: any) => ['failed', 'pending'].includes(row.status) && ['critical', 'high'].includes(row.severity)),
      note: JSON.stringify(status.releaseSecurity)
    },
    {
      key: 'auto_performance_clear',
      title: '자동 점검: 성능 점검 실패 없음',
      failed: status.performance.some((row: any) => row.status === 'failed'),
      note: JSON.stringify(status.performance)
    },
    {
      key: 'auto_file_license_clear',
      title: '자동 점검: 사용 파일 라이선스 누락 없음',
      failed: Number(status.fileLicenses?.license_needed ?? 0) > 0,
      note: JSON.stringify(status.fileLicenses)
    },
    {
      key: 'auto_final_rehearsal_clear',
      title: '자동 점검: 최종 리허설 통과',
      failed: !status.rehearsalRun || status.rehearsals.some((row: any) => !['passed', 'waived'].includes(row.status)),
      note: JSON.stringify({ run: status.rehearsalRun, status: status.rehearsals })
    }
  ];
  for (const check of checks) {
    await exec(
      `INSERT INTO release_gates (gate_key, title, description, status, checked_by, checked_at, note)
       VALUES (:gateKey, :title, '자동 릴리즈 게이트', :status, :userId, NOW(), :note)
       ON DUPLICATE KEY UPDATE title=VALUES(title), status=VALUES(status), checked_by=VALUES(checked_by), checked_at=NOW(), note=VALUES(note)`,
      { gateKey: check.key, title: check.title, status: check.failed ? 'failed' : 'passed', userId, note: check.note }
    );
  }
  return checks;
}

app.get('/api/admin/content-audits', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, page_id, audit_type, status, note, audited_by, audited_at, created_at FROM content_audits ORDER BY FIELD(status,'failed','needs_fix','pending','passed'), id DESC LIMIT 200`);
});
app.post('/api/admin/content-audits', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const pageId = nullablePositiveInt(body.pageId);
  if (!pageId) return reply.code(400).send({ error: 'page_required' });
  const page = await getPageById(pageId);
  if (!page || String(page.status ?? '') === 'deleted') return reply.code(404).send({ error: 'page_not_found' });
  const auditType = normalizeContentAuditType(body.auditType);
  const status = normalizeContentAuditStatus(body.status ?? 'pending');
  if (!auditType || !status) return reply.code(400).send({ error: 'invalid_audit' });
  const result = await exec(
    `INSERT INTO content_audits (page_id, audit_type, status, note, audited_by, audited_at, created_at)
     VALUES (:pageId, :auditType, :status, :note, :userId, IF(:status='pending', NULL, NOW()), NOW())`,
    { pageId, auditType, status, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  return { id: result.insertId, ok: true };
});

app.get('/api/admin/search-audits', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, query, expected_page_id, status, note, audited_by, audited_at, created_at FROM search_audits ORDER BY FIELD(status,'pending','needs_alias','needs_page','bad_ranking','passed'), id DESC LIMIT 200`);
});
app.post('/api/admin/search-audits', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const searchQuery = boundedText(body.query, 255);
  if (!searchQuery) return reply.code(400).send({ error: 'query_required' });
  const expectedPageId = nullablePositiveInt(body.expectedPageId);
  if (expectedPageId) {
    const expectedPage = await getPageById(expectedPageId);
    if (!expectedPage || String(expectedPage.status ?? '') === 'deleted') return reply.code(404).send({ error: 'expected_page_not_found' });
  }
  const results = await searchPages(searchQuery, 5);
  const passed = expectedPageId ? results[0]?.page_id === expectedPageId : results.length > 0;
  const status = passed ? 'passed' : results.length === 0 ? 'needs_alias' : 'bad_ranking';
  const result = await exec(
    `INSERT INTO search_audits (query, expected_page_id, status, note, audited_by, audited_at, created_at)
     VALUES (:query, :expectedPageId, :status, :note, :userId, NOW(), NOW())`,
    { query: searchQuery, expectedPageId: expectedPageId ?? null, status, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  if (status !== 'passed') {
    await exec(
      `INSERT INTO contributor_tasks (task_type, target_type, title, description, priority, created_by, created_at, updated_at)
       VALUES ('fix_search_alias', 'search_term', :title, :description, 'high', :userId, NOW(), NOW())`,
      { title: `"${searchQuery}" 검색 감사 처리`, description: `검색 감사 상태: ${status}`, userId: user?.id ?? null }
    );
  }
  return { id: result.insertId, status, ok: true };
});

app.get('/api/admin/security-tests', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, test_key, status, severity, note, tested_by, tested_at, created_at FROM security_test_runs ORDER BY FIELD(severity,'critical','high','medium','low'), id DESC LIMIT 100`);
});
app.post('/api/admin/security-tests', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const testKey = boundedKey(body.testKey, 128);
  if (!testKey) return reply.code(400).send({ error: 'test_key_required' });
  const status = normalizeSecurityTestStatus(body.status ?? 'pending');
  const severity = normalizeIssueSeverity(body.severity);
  if (!status) return reply.code(400).send({ error: 'invalid_status' });
  const result = await exec(
    `INSERT INTO security_test_runs (test_key, status, severity, note, tested_by, tested_at, created_at)
     VALUES (:testKey, :status, :severity, :note, :userId, IF(:status='pending', NULL, NOW()), NOW())`,
    { testKey, status, severity, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  return { id: result.insertId, ok: true };
});

app.get('/api/open-beta/settings', async () => publicOpenBetaSettings(await one(`SELECT signup_mode, new_user_review_required, server_listing_mode, updated_at FROM open_beta_settings WHERE id=1`)));
app.patch('/api/admin/open-beta/settings', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  if (!(await saveOpenBetaSettings(body, user?.id ?? null))) return reply.code(400).send({ error: 'invalid_settings' });
  return { ok: true };
});

async function saveOpenBetaSettings(body: any, userId: number | null) {
  const signupMode = normalizeSignupMode(body.signupMode ?? 'open');
  const serverListingMode = normalizeServerListingMode(body.serverListingMode ?? 'verified_or_owner');
  if (!signupMode || !serverListingMode) return false;
  await exec(
    `INSERT INTO open_beta_settings
     (id, signup_mode, new_user_edit_limit, new_user_external_link_limit, new_user_review_required, server_listing_mode, updated_by, updated_at)
     VALUES (1, :signupMode, :editLimit, :linkLimit, :reviewRequired, :serverListingMode, :userId, NOW())
     ON DUPLICATE KEY UPDATE signup_mode=VALUES(signup_mode), new_user_edit_limit=VALUES(new_user_edit_limit),
       new_user_external_link_limit=VALUES(new_user_external_link_limit), new_user_review_required=VALUES(new_user_review_required),
       server_listing_mode=VALUES(server_listing_mode), updated_by=VALUES(updated_by), updated_at=NOW()`,
    {
      signupMode,
      editLimit: boundedUnsignedInt(body.newUserEditLimit ?? 10, 1000) ?? 10,
      linkLimit: boundedUnsignedInt(body.newUserExternalLinkLimit ?? 2, 100) ?? 2,
      reviewRequired: body.newUserReviewRequired ? 1 : 0,
      serverListingMode,
      userId
    }
  );
  return true;
}

app.get('/api/admin/user-trust', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(
    `SELECT u.id, u.username, u.display_name, COALESCE(ut.trust_level,'new') trust_level, ut.good_edits, ut.reports_received, ut.filter_hits, ut.last_evaluated_at
     FROM users u LEFT JOIN user_trust ut ON ut.user_id=u.id ORDER BY FIELD(COALESCE(ut.trust_level,'new'),'restricted','new','normal','autoconfirmed','trusted'), u.id DESC LIMIT 200`
  );
});
app.post('/api/admin/user-trust/:id/evaluate', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const userId = nullablePositiveInt((request.params as any).id);
  if (!userId) return reply.code(400).send({ error: 'invalid_user_id' });
  return evaluateUserTrust(userId);
});
app.patch('/api/admin/user-trust/:id', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const trustLevel = normalizeTrustLevel((request.body as any).trustLevel) ?? 'normal';
  const userId = nullablePositiveInt((request.params as any).id);
  if (!userId) return reply.code(400).send({ error: 'invalid_user_id' });
  await exec(
    `INSERT INTO user_trust (user_id, trust_level, updated_at)
     VALUES (:userId, :trustLevel, NOW())
     ON DUPLICATE KEY UPDATE trust_level=VALUES(trust_level), updated_at=NOW()`,
    { userId, trustLevel }
  );
  await syncManualTrustGroups(userId, trustLevel);
  return { ok: true, userId, trustLevel };
});

app.get('/api/announcements', async (request) => publicAnnouncements((request as any).user));
app.get('/api/admin/announcements', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT ${announcementFields} FROM announcements ORDER BY id DESC LIMIT 100`);
});
app.post('/api/admin/announcements', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  const content = boundedText(body.body, 20_000);
  if (!title || !content) return reply.code(400).send({ error: 'title_body_required' });
  const type = normalizeAnnouncementType(body.type);
  const visibility = normalizeAnnouncementVisibility(body.visibility);
  const result = await exec(
    `INSERT INTO announcements (title, body, type, visibility, starts_at, ends_at, created_by, created_at, updated_at)
     VALUES (:title, :body, :type, :visibility, :startsAt, :endsAt, :userId, NOW(), NOW())`,
    { title, body: content, type, visibility, startsAt: normalizeDateTimeInput(body.startsAt), endsAt: normalizeDateTimeInput(body.endsAt), userId: user?.id ?? null }
  );
  return { id: result.insertId, ok: true };
});
app.patch('/api/admin/announcements/:id', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const id = nullablePositiveInt((request.params as any).id);
  if (!id) return reply.code(400).send({ error: 'invalid_announcement_id' });
  const title = body.title === undefined ? null : boundedText(body.title, 255);
  const content = body.body === undefined ? null : boundedText(body.body, 20_000);
  if ((body.title !== undefined && !title) || (body.body !== undefined && !content)) return reply.code(400).send({ error: 'invalid_announcement' });
  const type = body.type === undefined ? null : normalizeAnnouncementType(body.type);
  const visibility = body.visibility === undefined ? null : normalizeAnnouncementVisibility(body.visibility);
  if ((body.type !== undefined && !type) || (body.visibility !== undefined && !visibility)) return reply.code(400).send({ error: 'invalid_announcement' });
  await exec(
    `UPDATE announcements SET title=COALESCE(:title,title), body=COALESCE(:body,body), type=COALESCE(:type,type),
     visibility=COALESCE(:visibility,visibility), starts_at=:startsAt, ends_at=:endsAt, updated_at=NOW() WHERE id=:id`,
    { id, title, body: content, type, visibility, startsAt: normalizeDateTimeInput(body.startsAt), endsAt: normalizeDateTimeInput(body.endsAt) }
  );
  return { ok: true };
});

app.get('/api/release-notes', async () =>
  query(`SELECT id, version, title, body, release_type, published_at FROM release_notes WHERE published_at IS NOT NULL ORDER BY published_at DESC, id DESC LIMIT 100`)
);
app.post('/api/admin/release-notes', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const version = boundedReleaseVersion(body.version);
  const title = boundedText(body.title, 255);
  const content = boundedText(body.body, 20_000);
  if (!version || !title || !content) return reply.code(400).send({ error: 'invalid_release_note' });
  const releaseType = normalizeReleaseNoteType(body.releaseType);
  await exec(
    `INSERT INTO release_notes (version, title, body, release_type, published_by, published_at, created_at)
     VALUES (:version, :title, :body, :releaseType, :userId, :publishedAt, NOW())
     ON DUPLICATE KEY UPDATE title=VALUES(title), body=VALUES(body), release_type=VALUES(release_type), published_by=VALUES(published_by), published_at=VALUES(published_at)`,
    { version, title, body: content, releaseType, userId: user?.id ?? null, publishedAt: normalizeDateTimeInput(body.publishedAt) ?? currentSqlDateTime() }
  );
  return { ok: true };
});

app.get('/api/incidents', async () =>
  query(`SELECT id, title, incident_type, severity, status, started_at, resolved_at, summary FROM incidents ORDER BY started_at DESC LIMIT 100`)
);
app.post('/api/admin/incidents', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  if (!title) return reply.code(400).send({ error: 'title_required' });
  const incidentType = normalizeIncidentType(body.incidentType);
  const severity = normalizeIncidentSeverity(body.severity);
  const status = normalizeIncidentStatus(body.status);
  const result = await exec(
    `INSERT INTO incidents (title, incident_type, severity, status, started_at, summary, created_by, created_at, updated_at)
     VALUES (:title, :incidentType, :severity, :status, :startedAt, :summary, :userId, NOW(), NOW())`,
    { title, incidentType, severity, status, startedAt: normalizeDateTimeInput(body.startedAt) ?? currentSqlDateTime(), summary: boundedText(body.summary, 5000) || null, userId: user?.id ?? null }
  );
  return { id: result.insertId, ok: true };
});
app.patch('/api/admin/incidents/:id', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const id = nullablePositiveInt((request.params as any).id);
  if (!id) return reply.code(400).send({ error: 'invalid_incident_id' });
  const status = body.status === undefined ? null : normalizeIncidentStatus(body.status);
  const severity = body.severity === undefined ? null : normalizeIncidentSeverity(body.severity);
  if ((body.status !== undefined && !status) || (body.severity !== undefined && !severity)) return reply.code(400).send({ error: 'invalid_incident' });
  await exec(
    `UPDATE incidents SET status=COALESCE(:status,status), severity=COALESCE(:severity,severity), summary=COALESCE(:summary,summary),
     resolved_at=IF(:status IN ('resolved','postmortem'), NOW(), resolved_at), updated_at=NOW() WHERE id=:id`,
    { id, status, severity, summary: boundedText(body.summary, 5000) || null }
  );
  return { ok: true };
});

app.get('/api/admin/report-sla-rules', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, reason, priority, target_minutes, enabled, created_at, updated_at FROM report_sla_rules ORDER BY FIELD(priority,'urgent','high','normal','low'), reason`);
});
app.post('/api/admin/report-sla-rules', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const reason = boundedText(body.reason, 255);
  if (!reason) return reply.code(400).send({ error: 'reason_required' });
  const priority = normalizeTaskPriority(body.priority ?? 'normal');
  if (!priority) return reply.code(400).send({ error: 'invalid_priority' });
  await exec(
    `INSERT INTO report_sla_rules (reason, priority, target_minutes, enabled, created_at, updated_at)
     VALUES (:reason, :priority, :targetMinutes, :enabled, NOW(), NOW())
     ON DUPLICATE KEY UPDATE priority=VALUES(priority), target_minutes=VALUES(target_minutes), enabled=VALUES(enabled), updated_at=NOW()`,
    { reason, priority, targetMinutes: boundedUnsignedInt(body.targetMinutes ?? 1440, 60 * 24 * 30) ?? 1440, enabled: body.enabled === undefined ? 1 : parseBoolean(body.enabled) ? 1 : 0 }
  );
  return { ok: true };
});

app.get('/api/campaigns', async () =>
  query(`SELECT id, title, description, campaign_type, status, starts_at, ends_at FROM writing_campaigns WHERE status IN ('active','paused') ORDER BY id DESC LIMIT 50`)
);
app.post('/api/admin/campaigns', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  if (!title) return reply.code(400).send({ error: 'title_required' });
  const result = await exec(
    `INSERT INTO writing_campaigns (title, description, campaign_type, status, starts_at, ends_at, created_by, created_at, updated_at)
     VALUES (:title, :description, :campaignType, :status, :startsAt, :endsAt, :userId, NOW(), NOW())`,
    {
      title,
      description: boundedText(body.description, 4000) || null,
      campaignType: normalizeCampaignType(body.campaignType),
      status: normalizeCampaignStatus(body.status),
      startsAt: normalizeDateTimeInput(body.startsAt),
      endsAt: normalizeDateTimeInput(body.endsAt),
      userId: user?.id ?? null
    }
  );
  return { id: result.insertId, ok: true };
});
app.get('/api/campaigns/:id/pages', async (request) => {
  const aclActor = aclActorForRequest(request);
  const campaignId = nullablePositiveInt((request.params as any).id);
  if (!campaignId) return [];
  const campaign = await one<any>(`SELECT id FROM writing_campaigns WHERE id=:id AND status IN ('active','paused')`, { id: campaignId });
  if (!campaign) return [];
  const rows = await query<any>(
    `SELECT cp.id, cp.campaign_id, cp.page_id, n.code AS namespace_code, cp.title, cp.status,
            p.space_id, p.protection_level, p.status AS page_status
     FROM campaign_pages cp
     LEFT JOIN namespaces n ON n.id=cp.namespace_id
     LEFT JOIN pages p ON p.id=cp.page_id
     WHERE cp.campaign_id=:id
     ORDER BY FIELD(cp.status,'needed','drafting','review','done','skipped'), cp.id`,
    { id: campaignId }
  );
  const visibleRows = [];
  for (const row of rows) {
    if (row.page_id && !row.page_status) continue;
    if (!row.page_id || (await canReadPageResource(aclActor, {
      id: row.page_id,
      space_id: row.space_id,
      protection_level: row.protection_level,
      status: row.page_status,
      namespace_code: row.namespace_code,
      title: row.title
    }))) {
      visibleRows.push(row);
    }
  }
  return visibleRows.map(({ space_id, protection_level, page_status, ...row }) => row);
});
app.post('/api/admin/campaigns/:id/pages', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const campaignId = nullablePositiveInt((request.params as any).id);
  const campaign = campaignId ? await one<any>(`SELECT id FROM writing_campaigns WHERE id=:id`, { id: campaignId }) : null;
  if (!campaign) return reply.code(404).send({ error: 'campaign_not_found' });
  const namespace = body.namespace ? normalizeEditableNamespace(body.namespace) : null;
  if (body.namespace && !namespace) return reply.code(400).send({ error: 'invalid_namespace' });
  const ns = namespace ? await one<any>(`SELECT id FROM namespaces WHERE code=:code`, { code: namespace }) : null;
  const pageId = nullablePositiveInt(body.pageId);
  if (pageId) {
    const page = await getPageById(pageId);
    if (!page || String(page.status ?? '') === 'deleted') return reply.code(404).send({ error: 'page_not_found' });
  }
  const title = boundedText(body.title, 255);
  if (!title && !pageId) return reply.code(400).send({ error: 'title_or_page_required' });
  const pageStatus = normalizeCampaignPageStatus(body.status);
  if (!pageStatus) return reply.code(400).send({ error: 'invalid_status' });
  const result = await exec(
    `INSERT INTO campaign_pages (campaign_id, page_id, namespace_id, title, status, assigned_to, note, created_at, updated_at)
     VALUES (:campaignId, :pageId, :namespaceId, :title, :status, :assignedTo, :note, NOW(), NOW())`,
    {
      campaignId,
      pageId: pageId ?? null,
      namespaceId: ns?.id ?? null,
      title,
      status: pageStatus,
      assignedTo: nullablePositiveInt(body.assignedTo) ?? null,
      note: boundedText(body.note, 1000) || null
    }
  );
  return { id: result.insertId, ok: true };
});
app.patch('/api/admin/campaign-pages/:id', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const campaignPageId = nullablePositiveInt((request.params as any).id);
  if (!campaignPageId) return reply.code(400).send({ error: 'invalid_campaign_page_id' });
  const status = body.status === undefined ? null : normalizeCampaignPageStatus(body.status);
  if (body.status !== undefined && !status) return reply.code(400).send({ error: 'invalid_status' });
  await exec(
    `UPDATE campaign_pages SET status=COALESCE(:status,status), assigned_to=COALESCE(:assignedTo,assigned_to), note=COALESCE(:note,note), updated_at=NOW() WHERE id=:id`,
    { id: campaignPageId, status, assignedTo: nullablePositiveInt(body.assignedTo) ?? null, note: boundedText(body.note, 1000) || null }
  );
  return { ok: true };
});

app.post('/api/admin/open-beta/weekly-stats/rebuild', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return rebuildOpenBetaWeeklyStats();
});
app.get('/api/open-beta/weekly-stats', async () =>
  query(
    `SELECT week_start, new_users, active_users, page_views, searches, zero_result_searches, edits, page_creates,
            rollbacks, reports, pending_reviews, approved_reviews, rejected_reviews, server_claims,
            mod_verifications, file_license_issues
     FROM open_beta_weekly_stats
     ORDER BY week_start DESC
     LIMIT 12`
  )
);

app.get('/api/admin/release-blockers', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT id, source_type, source_id, blocker_type, severity, title, description, status, assigned_to, resolved_at, created_at, updated_at FROM release_blockers ORDER BY FIELD(severity,'critical','high'), FIELD(status,'open','in_progress','resolved','waived'), id DESC`);
});
app.post('/api/admin/release-blockers', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const title = boundedText(body.title, 255);
  if (!title) return reply.code(400).send({ error: 'title_required' });
  const assignedTo = await activeUserIdOrNull(body.assignedTo);
  if (body.assignedTo !== undefined && body.assignedTo !== null && body.assignedTo !== '' && assignedTo === null) return reply.code(400).send({ error: 'invalid_assignee' });
  const result = await exec(
    `INSERT INTO release_blockers (source_type, source_id, blocker_type, severity, title, description, assigned_to, created_at, updated_at)
     VALUES (:sourceType, :sourceId, :blockerType, :severity, :title, :description, :assignedTo, NOW(), NOW())`,
    {
      sourceType: normalizeReleaseBlockerSourceType(body.sourceType),
      sourceId: nullablePositiveInt(body.sourceId),
      blockerType: normalizeReleaseBlockerType(body.blockerType),
      severity: normalizeReleaseBlockerSeverity(body.severity),
      title,
      description: boundedText(body.description, 5000) || null,
      assignedTo
    }
  );
  return { id: result.insertId, ok: true };
});
app.patch('/api/admin/release-blockers/:id', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const blockerId = nullablePositiveInt((request.params as any).id);
  const status = body.status === undefined ? null : normalizeReleaseBlockerStatus(body.status);
  if (!blockerId || (body.status !== undefined && !status)) return reply.code(400).send({ error: 'invalid_blocker_update' });
  const assignedTo = await activeUserIdOrNull(body.assignedTo);
  if (body.assignedTo !== undefined && body.assignedTo !== null && body.assignedTo !== '' && assignedTo === null) return reply.code(400).send({ error: 'invalid_assignee' });
  await exec(
    `UPDATE release_blockers SET status=COALESCE(:status,status), assigned_to=COALESCE(:assignedTo,assigned_to),
     resolved_at=IF(:status IN ('resolved','waived'), NOW(), resolved_at), updated_at=NOW() WHERE id=:id`,
    { id: blockerId, status, assignedTo }
  );
  return { ok: true };
});

app.get('/api/admin/policy-versions', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(
    `SELECT pv.id, pv.page_id, pv.policy_key, pv.version, pv.status, pv.effective_at, pv.created_by, pv.created_at, p.title
     FROM policy_versions pv
     JOIN pages p ON p.id=pv.page_id
     ORDER BY pv.policy_key, pv.created_at DESC`
  );
});
app.post('/api/admin/policy-versions', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const pageId = nullablePositiveInt(body.pageId);
  const page = pageId ? await getPageById(pageId) : null;
  if (!page || String(page.status ?? '') === 'deleted') return reply.code(404).send({ error: 'page_not_found' });
  const policyKey = boundedKey(body.policyKey, 64);
  const version = boundedReleaseVersion(body.version ?? '1.0');
  const status = normalizePolicyVersionStatus(body.status ?? 'draft');
  if (!policyKey || !version || !status) return reply.code(400).send({ error: 'invalid_policy_version' });
  await exec(
    `INSERT INTO policy_versions (page_id, policy_key, version, status, effective_at, created_by, created_at)
     VALUES (:pageId, :policyKey, :version, :status, :effectiveAt, :userId, NOW())
     ON DUPLICATE KEY UPDATE status=VALUES(status), effective_at=VALUES(effective_at)`,
    { pageId, policyKey, version, status, effectiveAt: normalizeDateTimeInput(body.effectiveAt), userId: user?.id ?? null }
  );
  return { ok: true };
});

for (const spec of [
  { path: 'permission-audits', table: 'permission_audits', fields: permissionAuditFields, order: `FIELD(status,'failed','pending','passed')` },
  { path: 'security-release-checks', table: 'security_release_checks', fields: securityReleaseCheckFields, order: `FIELD(severity,'critical','high','medium','low')` },
  { path: 'performance-checks', table: 'performance_checks', fields: performanceCheckFields, order: `FIELD(status,'failed','needs_work','pending','passed')` }
]) {
  app.get(`/api/admin/${spec.path}`, async (request, reply) => {
    if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
    return query(`SELECT ${spec.fields} FROM ${spec.table} ORDER BY ${spec.order}, id DESC LIMIT 200`);
  });
}

app.post('/api/admin/permission-audits', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const auditKey = boundedKey(body.auditKey, 128);
  const actorRole = boundedKey(body.actorRole, 64);
  const targetType = boundedKey(body.targetType, 64);
  const action = normalizeAclAction(body.action) ?? boundedKey(body.action, 64);
  const expectedResult = normalizeAllowDeny(body.expectedResult);
  const actualResult = body.actualResult === undefined || body.actualResult === null || body.actualResult === '' ? null : normalizeAllowDeny(body.actualResult);
  const status = normalizePermissionAuditStatus(body.status ?? 'pending');
  if (!auditKey || !actorRole || !targetType || !action || !expectedResult || !status || (body.actualResult && !actualResult)) return reply.code(400).send({ error: 'invalid_permission_audit' });
  const result = await exec(
    `INSERT INTO permission_audits (audit_key, actor_role, target_type, action, expected_result, actual_result, status, tested_by, tested_at, note, created_at)
     VALUES (:auditKey, :actorRole, :targetType, :action, :expectedResult, :actualResult, :status, :userId, IF(:status='pending', NULL, NOW()), :note, NOW())`,
    { auditKey, actorRole, targetType, action, expectedResult, actualResult, status, userId: user?.id ?? null, note: boundedText(body.note, 1000) || null }
  );
  return { id: result.insertId, ok: true };
});
app.post('/api/admin/security-release-checks', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const checkKey = boundedKey(body.checkKey, 128);
  const category = normalizeSecurityReleaseCategory(body.category ?? 'other');
  const severity = normalizeIssueSeverity(body.severity);
  const status = normalizeSecurityReleaseStatus(body.status ?? 'pending');
  if (!checkKey || !category || !status) return reply.code(400).send({ error: 'invalid_security_check' });
  const result = await exec(
    `INSERT INTO security_release_checks (check_key, category, severity, status, note, checked_by, checked_at, created_at)
     VALUES (:checkKey, :category, :severity, :status, :note, :userId, IF(:status='pending', NULL, NOW()), NOW())`,
    { checkKey, category, severity, status, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  return { id: result.insertId, ok: true };
});
app.post('/api/admin/performance-checks', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const checkKey = boundedKey(body.checkKey, 128);
  const targetArea = normalizePerformanceTargetArea(body.targetArea ?? 'page');
  const status = normalizePerformanceCheckStatus(body.status ?? 'pending');
  if (!checkKey || !targetArea || !status) return reply.code(400).send({ error: 'invalid_performance_check' });
  const result = await exec(
    `INSERT INTO performance_checks (check_key, target_area, status, note, checked_by, checked_at, created_at)
     VALUES (:checkKey, :targetArea, :status, :note, :userId, IF(:status='pending', NULL, NOW()), NOW())`,
    { checkKey, targetArea, status, note: boundedText(body.note, 1000) || null, userId: user?.id ?? null }
  );
  return { id: result.insertId, ok: true };
});

app.post('/api/admin/daily-summary/rebuild', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return rebuildDailyOperationSummary();
});
app.get('/api/admin/daily-summary', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(
    `SELECT summary_date, edits, page_creates, pending_reviews, open_reports, urgent_reports, rollbacks,
            zero_result_searches, server_claims_pending, server_disputes, outdated_mod_pages, file_license_issues,
            failed_jobs, created_at, updated_at
     FROM daily_operation_summary
     ORDER BY summary_date DESC LIMIT 31`
  );
});

app.get('/api/spaces', async (request) => {
  const aclActor = aclActorForRequest(request);
  const rows = await query<any>(
    `SELECT ws.id, ws.code, ws.space_key, ws.name, ws.title, ws.slug, ws.space_type, ws.parent_space_id,
            ws.root_page_id, ws.root_namespace_code, ws.root_path, ws.description, ws.status, ws.updated_at,
            p.id AS page_id, p.space_id AS page_space_id, p.protection_level, p.status AS page_status, n.code AS page_namespace_code, p.title AS page_title
     FROM wiki_spaces ws
     LEFT JOIN pages p ON p.id=ws.root_page_id
     LEFT JOIN namespaces n ON n.id=p.namespace_id
     WHERE ws.status='active'
     ORDER BY FIELD(ws.space_type,'basic','mod_category','mod_wiki','server_category','server_wiki','developer'), ws.id`
  );
  const visibleRows = [];
  for (const row of rows) {
    if (row.root_page_id && !(await canReadPageResource(aclActor, {
      id: row.page_id,
      space_id: row.page_space_id,
      protection_level: row.protection_level,
      status: row.page_status,
      namespace_code: row.page_namespace_code,
      title: row.page_title
    }))) continue;
    const { page_id, page_space_id, protection_level, page_status, page_namespace_code, page_title, ...space } = row;
    visibleRows.push(space);
  }
  return visibleRows;
});
app.get('/api/spaces/:code/pages', async (request, reply) => {
  const aclActor = aclActorForRequest(request);
  const space = await one<any>(`SELECT id FROM wiki_spaces WHERE (code=:code OR space_key=:code) AND status='active'`, { code: (request.params as any).code });
  if (!space) return reply.code(404).send({ error: 'space_not_found' });
  const rows = await query<any>(
    `SELECT p.id, p.space_id, p.protection_level, n.code AS namespace_code, p.title, p.display_title, p.local_path, p.page_type, p.status, p.updated_at
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE p.space_id=:spaceId AND p.status NOT IN ('deleted','hidden')
     ORDER BY p.local_path='대문' DESC, p.local_path`,
    { spaceId: space.id }
  );
  const visibleRows = [];
  for (const row of rows) {
    if (await canReadPageResource(aclActor, row)) visibleRows.push(row);
  }
  return visibleRows.map((row) => ({
    ...row,
    url: wikiUrl(row.namespace_code, row.title)
  }));
});
app.get('/api/spaces/:code/sidebar', async (request) => {
  const rows = await query<any>(
    `SELECT si.id, si.parent_id, si.page_id, si.label, si.target_title, si.target_url, si.sort_order,
            p.id AS resolved_page_id, p.space_id, p.protection_level, p.status, n.code AS namespace_code, p.title, p.display_title
     FROM subwiki_sidebar_items si
     JOIN wiki_spaces ws ON ws.id=si.space_id
     LEFT JOIN namespaces root_n ON root_n.code=ws.root_namespace_code
     LEFT JOIN pages p ON p.id=si.page_id OR (si.page_id IS NULL AND p.namespace_id=root_n.id AND p.title=si.target_title)
     LEFT JOIN namespaces n ON n.id=p.namespace_id
     WHERE (ws.code=:code OR ws.space_key=:code) AND ws.status='active'
     ORDER BY si.sort_order, si.id`,
    { code: (request.params as any).code }
  );
  return filterSidebarItemsForAcl(rows, aclActorForRequest(request));
});
app.post('/api/admin/spaces/sync-pages', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  await syncPageSpaces();
  return { ok: true };
});
app.post('/api/admin/spaces/:code/sidebar', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const result = await addSubwikiSidebarItem(String((request.params as any).code ?? ''), request.body as any);
  if (!result.ok) return reply.code(result.status).send({ error: result.error });
  return { id: result.id, ok: true };
});
app.post('/api/subwiki-requests', async (request, reply) => {
  const user = (request as any).user;
  if (!user) return reply.code(403).send({ error: 'login_required' });
  const body = request.body as any;
  const targetPageId = nullablePositiveInt(body.targetPageId);
  if (targetPageId) {
    const targetPage = await getPageById(targetPageId);
    if (!(await canReadPageResource(aclActorForRequest(request), targetPage))) return reply.code(404).send({ error: 'target_not_found' });
  }
  const requestType = ['server', 'mod'].includes(String(body.requestType ?? '')) ? String(body.requestType) : 'server';
  const result = await exec(
    `INSERT INTO subwiki_requests (request_type, title, target_page_id, requested_by, note, created_at, updated_at)
     VALUES (:requestType, :title, :targetPageId, :userId, :note, NOW(), NOW())`,
    {
      requestType,
      title: boundedText(body.title, 255) || '제목 없음',
      targetPageId: targetPageId ?? null,
      userId: user.id,
      note: boundedText(body.note, 4000) || null
    }
  );
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
     VALUES ('subwiki_request', 'subwiki_request', :id, 'normal', NOW(), NOW())`,
    { id: result.insertId }
  );
  return { id: result.insertId, ok: true };
});
app.get('/api/admin/subwiki-requests', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(`SELECT ${subwikiRequestFields} FROM subwiki_requests ORDER BY FIELD(status,'pending','approved','created','rejected'), id DESC LIMIT 100`);
});
app.post('/api/admin/subwikis/server', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'server.official_edit') && !can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return createServerSubwiki(request.body as any, user?.id ?? null);
});
app.post('/api/admin/subwikis/mod', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return createModSubwiki(request.body as any, user?.id ?? null);
});
app.post('/api/admin/mod-wikis/:slug/creator-verification', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const result = await updateModCreatorVerification(String((request.params as any).slug ?? ''), request.body as any, user?.id ?? null);
  if (!result.ok) return reply.code(result.status).send({ error: result.error });
  return { ok: true, creatorVerified: result.creatorVerified };
});
app.patch('/api/admin/subwikis/:code/status', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const result = await updateSubwikiStatus(String((request.params as any).code ?? ''), request.body as any, user?.id ?? null);
  if (!result.ok) return reply.code(result.status).send({ error: result.error });
  return { ok: true };
});
app.get('/api/server-subwikis/:slug/export', async (request, reply) => {
  return sendServerSubwikiExport(request, reply, (request.params as any).slug, false);
});

async function sendServerSubwikiExport(request: any, reply: any, slugInput: unknown, htmlErrors: boolean) {
  const user = request.user;
  const slug = normalizeTitle(String(slugInput ?? ''));
  const space = await one<any>(`SELECT ${wikiSpaceFields} FROM wiki_spaces WHERE code=:code AND space_type='server_wiki'`, { code: `server-${slug}` });
  if (!space) {
    if (htmlErrors) return reply.code(404).type('text/html').send(messagePage('서버 위키 없음', '서버 위키를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/servers', actionLabel: '서버 허브', currentSpace: 'server' }));
    return reply.code(404).send({ error: 'not_found' });
  }
  if (!(await canManageSubwiki(user, Number(space.id)))) {
    if (htmlErrors) return reply.code(403).type('text/html').send(messagePage('권한 없음', '이 서버 위키를 내보낼 권한이 없습니다.', user, { tone: 'error', ...accessActionOptions(request, user, `/server/${encodeURIComponent(slug)}`, '서버 위키'), currentSpace: 'server' }));
    return reply.code(403).send({ error: 'forbidden' });
  }
  if (!(await serverFeature(Number(space.id), 'markdownExport'))) {
    if (htmlErrors) return reply.code(402).type('text/html').send(messagePage('내보내기 제한', 'Plus 이상에서 Export를 사용할 수 있습니다.', user, { tone: 'error', actionHref: `/server/${encodeURIComponent(slug)}/manage`, actionLabel: '관리 화면', currentSpace: 'server' }));
    return reply.code(402).send({ error: 'plan_required', message: 'Plus 이상에서 Export를 사용할 수 있습니다.' });
  }
  const bundle = await exportSubwiki(Number(space.id), 'server', `${slug}/%`, aclActorForRequest(request));
  const format = String((request.query as any).format ?? 'bundle');
  const safeSlug = slug.replace(/[^a-zA-Z0-9가-힣._-]+/g, '_');
  if (format === 'markdown') {
    reply.type('text/markdown; charset=utf-8');
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeSlug)}-markdown.md"`);
    return bundle.markdown.map((page: any) => `# ${page.title}\n\n${page.body}`).join('\n\n---\n\n');
  }
  if (format === 'tree') {
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeSlug)}-tree.json"`);
    return { format: 'document_tree_json', generatedAt: bundle.generatedAt, space: bundle.space, tree: bundle.tree };
  }
  if (format === 'sidebar') {
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeSlug)}-sidebar.json"`);
    return { format: 'sidebar_json', generatedAt: bundle.generatedAt, space: bundle.space, sidebar: bundle.sidebar };
  }
  if (format === 'files') {
    reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeSlug)}-files.json"`);
    return { format: 'file_list', generatedAt: bundle.generatedAt, space: bundle.space, files: bundle.files };
  }
  reply.header('Content-Disposition', `attachment; filename="${encodeURIComponent(safeSlug)}-wiki-export.json"`);
  return bundle;
}
app.get('/api/server-subwikis/:slug/tree', async (request, reply) => {
  const aclActor = aclActorForRequest(request);
  const slug = normalizeTitle((request.params as any).slug);
  const space = await serverSubwikiSpace(slug);
  if (!space || String(space.status ?? '') !== 'active') return reply.code(404).send({ error: 'not_found' });
  const [docs, sidebar] = await Promise.all([
    query<any>(
      `SELECT p.id, p.space_id, p.protection_level, p.status, p.title, p.updated_at, n.code AS namespace_code
       FROM pages p
       JOIN namespaces n ON n.id=p.namespace_id
       WHERE n.code='server' AND p.title LIKE :prefix AND p.status NOT IN ('deleted','hidden')
       ORDER BY p.title`,
      { prefix: `${slug}/%` }
    ),
    query<any>(
      `SELECT si.id, si.parent_id, si.page_id, si.label, si.target_title, si.sort_order,
              p.id AS resolved_page_id, p.space_id, p.protection_level, p.status, n.code AS namespace_code, p.title
       FROM subwiki_sidebar_items si
       LEFT JOIN namespaces root_n ON root_n.code='server'
       LEFT JOIN pages p ON p.id=si.page_id OR (si.page_id IS NULL AND p.namespace_id=root_n.id AND p.title=si.target_title)
       LEFT JOIN namespaces n ON n.id=p.namespace_id
       WHERE si.space_id=:spaceId
       ORDER BY si.sort_order, si.id`,
      { spaceId: space.id }
    )
  ]);
  const visibleDocs = [];
  for (const doc of docs) {
    if (await canReadPageResource(aclActor, doc)) visibleDocs.push(doc);
  }
  return {
    space: publicSpacePayload(space),
    docs: visibleDocs.map(({ space_id, protection_level, status, namespace_code, ...doc }) => doc),
    sidebar: await filterSidebarItemsForAcl(sidebar, aclActor)
  };
});
app.post('/api/admin/markdown-imports', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const spaceId = nullablePositiveInt(body.spaceId);
  if (body.spaceId !== undefined && body.spaceId !== null && body.spaceId !== '' && (!spaceId || !(await wikiSpaceExists(spaceId)))) {
    return reply.code(400).send({ error: 'invalid_space' });
  }
  const sourceType = normalizeMarkdownImportSourceType(body.sourceType ?? 'markdown');
  if (!sourceType) return reply.code(400).send({ error: 'invalid_source_type' });
  const sourceName = boundedText(body.sourceName, 255);
  if (!sourceName) return reply.code(400).send({ error: 'source_name_required' });
  const checklist = markdownChecklistJson(body.checklist);
  const result = await exec(
    `INSERT INTO markdown_import_jobs (space_id, source_type, source_name, checklist_json, created_by, created_at, updated_at)
     VALUES (:spaceId, :sourceType, :sourceName, :checklist, :userId, NOW(), NOW())`,
    { spaceId: spaceId ?? null, sourceType, sourceName, checklist, userId: user?.id ?? null }
  );
  return { id: result.insertId, ok: true };
});
app.get('/api/admin/gitbook-imports', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(
    `SELECT gij.id, gij.space_id, gij.requested_by, gij.source_type, gij.status, gij.imported_pages, gij.source_note,
            gij.error_message, gij.created_at, gij.updated_at, ws.code AS space_code, ws.title AS space_title
     FROM gitbook_import_jobs gij
     JOIN wiki_spaces ws ON ws.id=gij.space_id
     ORDER BY gij.id DESC LIMIT 100`
  );
});
app.post('/api/admin/gitbook-imports', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const spaceId = nullablePositiveInt(body.spaceId);
  if (!spaceId || !(await wikiSpaceExists(spaceId))) return reply.code(400).send({ error: 'invalid_space' });
  const sourceType = normalizeGitbookImportSourceType(body.sourceType ?? 'manual');
  if (!sourceType) return reply.code(400).send({ error: 'invalid_source_type' });
  const mapping = boundedJsonString(body.mapping ?? { checklist: ['접속 문서', '규칙 문서', '공지 문서', '사이드바 매핑'] }, 25_000);
  if (!mapping) return reply.code(400).send({ error: 'mapping_too_large' });
  const result = await exec(
    `INSERT INTO gitbook_import_jobs (space_id, requested_by, source_type, source_note, mapping_json, created_at, updated_at)
     VALUES (:spaceId, :userId, :sourceType, :sourceNote, :mapping, NOW(), NOW())`,
    {
      spaceId,
      userId: user?.id ?? 0,
      sourceType,
      sourceNote: boundedText(body.sourceNote, 5000) || null,
      mapping
    }
  );
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
     VALUES ('gitbook_import', 'gitbook_import', :id, 'normal', NOW(), NOW())`,
    { id: result.insertId }
  );
  return { id: result.insertId, ok: true };
});
app.post('/api/admin/gitbook-imports/:id/run', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const jobId = nullablePositiveInt((request.params as any).id);
  if (!jobId) return reply.code(400).send({ error: 'invalid_import_id' });
  const job = await gitbookImportJob(jobId);
  if (!job) return reply.code(404).send({ error: 'not_found' });
  const payload = normalizeGitbookImportPayload(request.body as any);
  if (!payload) return reply.code(400).send({ error: 'invalid_import_payload' });
  try {
    const result = await runGitbookImport(job, payload, user?.id ?? null);
    return { ok: true, ...result };
  } catch (error: any) {
    await exec(`UPDATE gitbook_import_jobs SET status='failed', error_message=:message, updated_at=NOW() WHERE id=:id`, {
      id: job.id,
      message: error.message
    });
    return reply.code(400).send({ error: 'import_failed', message: error.message });
  }
});

app.post('/server/:slug/manage/import', async (request, reply) => {
  const user = (request as any).user;
  const slug = String((request.params as any).slug ?? '');
  const manageHref = `/server/${encodeURIComponent(slug)}/manage`;
  const space = await serverSubwikiSpace(slug);
  if (!space) return subwikiManageError(reply, user, 404, '서버 공식 위키를 찾을 수 없습니다.', '/servers');
  if (!(await canManageSubwiki(user, Number(space.id)))) return subwikiManageError(reply, user, 403, '서버 위키를 관리할 권한이 없습니다.', `/server/${encodeURIComponent(slug)}`);
  if (!(await serverFeature(Number(space.id), 'markdownImport'))) return subwikiManageError(reply, user, 402, 'Pro 이상에서 Markdown/GitBook 이전을 사용할 수 있습니다.', manageHref);
  const body = await gitbookImportRequestBody(request);
  const payload = normalizeGitbookImportPayload({ markdown: body.markdown, summary: body.summary, documents: body.documents ?? [] });
  if (!payload) return reply.code(400).type('text/html').send(messagePage('Markdown 이전 오류', '가져오기 데이터가 너무 크거나 올바르지 않습니다.', user, { tone: 'error', actionHref: `/server/${encodeURIComponent(slug)}/manage`, actionLabel: '운영자 대시보드' }));
  const mapping = boundedJsonString({ ...payload, checklist: ['Markdown import', 'ZIP/Markdown 파일 import', 'SUMMARY.md 문서 트리 import', '이미지 링크 확인', '외부 링크 확인', '공식 영역 확인', '사이드바 생성'] }, importLimits.maxTotalMarkdownBytes + 50_000);
  if (!mapping) return reply.code(400).type('text/html').send(messagePage('Markdown 이전 오류', '가져오기 데이터가 너무 큽니다.', user, { tone: 'error', actionHref: `/server/${encodeURIComponent(slug)}/manage`, actionLabel: '운영자 대시보드' }));
  const result = await exec(
    `INSERT INTO gitbook_import_jobs (space_id, requested_by, source_type, source_note, mapping_json, created_at, updated_at)
     VALUES (:spaceId, :userId, 'markdown_zip', :sourceNote, :mapping, NOW(), NOW())`,
    {
      spaceId: space.id,
      userId: user?.id ?? 0,
      sourceNote: boundedText(body.sourceNote, 5000) || 'Markdown 직접 이전',
      mapping
    }
  );
  const job = await gitbookImportJob(Number(result.insertId));
  try {
    if (job) await runGitbookImport(job, payload, user?.id ?? null);
  } catch (error: any) {
    await exec(`UPDATE gitbook_import_jobs SET status='failed', error_message=:message, updated_at=NOW() WHERE id=:id`, {
      id: result.insertId,
      message: error.message
    });
    return reply
      .code(400)
      .type('text/html')
      .send(messagePage('Markdown 이전 오류', error.message, user, { tone: 'error', actionHref: `/server/${encodeURIComponent(slug)}/manage`, actionLabel: '운영자 대시보드' }));
  }
  return reply.redirect(`/server/${encodeURIComponent(slug)}/manage`);
});

app.get('/api/admin/mod-verification-tasks', async (request, reply) => {
  if (!canModVerify((request as any).user)) return reply.code(403).send({ error: 'forbidden' });
  return modVerificationTasks();
});
app.post('/api/admin/mod-verification-tasks/generate', async (request, reply) => {
  const user = (request as any).user;
  if (!canModVerify(user)) return reply.code(403).send({ error: 'forbidden' });
  return generateModVerificationTasks(user?.id ?? null);
});
app.patch('/api/admin/mod-verification-tasks/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!canModVerify(user)) return reply.code(403).send({ error: 'forbidden' });
  const result = await updateModVerificationTask(nullablePositiveInt((request.params as any).id) ?? 0, request.body as any, user?.id ?? null);
  if (!result.ok) return reply.code(400).send({ error: result.error });
  return result;
});
app.get('/api/admin/file-license-issues', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return fileLicenseIssueRows();
});
app.get('/api/admin/files/unused', async (request, reply) => {
  if (!can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return unusedFileRows();
});
app.patch('/api/admin/files/:id', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  const fileId = nullablePositiveInt((request.params as any).id);
  if (!fileId) return reply.code(400).send({ error: 'invalid_file_id' });
  const result = await updateAdminFileMetadata(fileId, request.body as any, user);
  if (!result.ok) return reply.code(400).send({ error: result.error });
  return result;
});
app.post('/api/files/:id/report', async (request, reply) => {
  const result = await createFileReport(request, reply);
  if (!result) return reply;
  if (!result.ok) return reply.code(result.status ?? 400).send({ error: result.error ?? 'file_report_failed' });
  return { ok: true, reportId: result.reportId };
});

async function createFileReport(request: any, reply: any) {
  if (!consumeActorRateLimit(request, 'file-report', 20, 50, 60 * 60 * 1000)) return { ok: false, status: 429, error: 'rate_limited', message: '잠시 후 다시 시도하세요.' };
  if (!(await requireAnonymousTurnstile(request, reply, 'file_report'))) return null;
  const body = request.body as any;
  const fileId = nullablePositiveInt((request.params as any).id);
  if (!fileId) return { ok: false, status: 400, error: 'invalid_file_id', message: '파일 번호가 올바르지 않습니다.' };
  const file = await one<any>(`SELECT id FROM files WHERE id=:id AND status IN ('normal','license_needed')`, { id: fileId });
  if (!file) return { ok: false, status: 404, error: 'file_not_found', message: '신고할 수 있는 파일을 찾을 수 없습니다.' };
  const result = await exec(
    `INSERT INTO reports (target_type, target_id, reporter_id, reason, detail, created_at)
     VALUES ('file', :fileId, :reporterId, :reason, :detail, NOW())`,
    {
      fileId: Number(file.id),
      reporterId: (request as any).user?.id ?? null,
      reason: boundedText(body.reason, 80) || 'file_issue',
      detail: boundedText(body.detail, 4000) || null
    }
  );
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, created_at, updated_at)
     VALUES ('file_license', 'report', :reportId, 'normal', NOW(), NOW())`,
    { reportId: result.insertId }
  );
  return { ok: true, reportId: result.insertId };
}
app.get('/api/admin/server-owners', async (request, reply) => {
  if (!can((request as any).user, 'server.official_edit') && !can((request as any).user, 'report.handle')) return reply.code(403).send({ error: 'forbidden' });
  return query(
    `SELECT so.id, so.page_id, so.user_id, so.role, so.status, so.granted_by, so.granted_at, so.revoked_at, so.revoked_by,
            p.title AS server_title, u.username, u.display_name
     FROM server_owners so
     JOIN pages p ON p.id=so.page_id
     JOIN users u ON u.id=so.user_id
     ORDER BY FIELD(so.status,'pending','active','revoked'), p.title, FIELD(so.role,'owner','manager','editor')`
  );
});
app.post('/api/admin/server-owners', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'server.official_edit')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const pageId = nullablePositiveInt(body.pageId);
  const userId = nullablePositiveInt(body.userId);
  if (!pageId || !userId) return reply.code(400).send({ error: 'invalid_owner_target' });
  const [page, ownerUser] = await Promise.all([
    getPageById(pageId),
    one<any>(`SELECT id FROM users WHERE id=:userId AND status='active'`, { userId })
  ]);
  if (!page || String(page.namespace_code ?? '') !== 'server' || String(page.status ?? '') === 'deleted') return reply.code(404).send({ error: 'server_not_found' });
  if (!ownerUser) return reply.code(404).send({ error: 'user_not_found' });
  const role = normalizeServerOwnerRole(body.role) ?? 'owner';
  const status = normalizeServerOwnerStatus(body.status) ?? 'active';
  await grantServerOwner(pageId, userId, role, status, user?.id ?? null);
  await logAdmin(user?.id ?? null, 'server_owner.grant', 'server', pageId, { userId, role, status });
  return { ok: true };
});
app.post('/api/admin/server-owners/:id/revoke', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'server.official_edit')) return reply.code(403).send({ error: 'forbidden' });
  const ownerId = nullablePositiveInt((request.params as any).id);
  if (!ownerId) return reply.code(400).send({ error: 'invalid_owner_id' });
  const owner = await one<any>(`SELECT ${serverOwnerFields} FROM server_owners WHERE id=:id`, { id: ownerId });
  if (!owner) return reply.code(404).send({ error: 'not_found' });
  await exec(`UPDATE server_owners SET status='revoked', revoked_at=NOW(), revoked_by=:userId WHERE id=:id`, {
    id: owner.id,
    userId: user?.id ?? null
  });
  await syncServerOwnerSubwikiRole(Number(owner.page_id), Number(owner.user_id), owner.role, 'revoked', user?.id ?? null);
  await logAdmin(user?.id ?? null, 'server_owner.revoke', 'server', Number(owner.page_id), { userId: owner.user_id });
  return { ok: true };
});
app.patch('/api/admin/servers/:pageId/status', async (request, reply) => {
  const user = (request as any).user;
  try {
    return await updateServerStatusAction(user, nullablePositiveInt((request.params as any).pageId), request.body as any);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
});
app.post('/api/admin/users/:id/block', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'user.block')) return reply.code(403).send({ error: 'forbidden' });
  const targetId = nullablePositiveInt((request.params as any).id);
  if (!targetId) return reply.code(400).send({ error: 'invalid_user_id' });
  if (user?.id === targetId) return reply.code(400).send({ error: 'cannot_block_self' });
  const body = request.body as any;
  await blockUser(targetId, user?.id ?? null, body?.reason ?? '관리자 차단', body?.expiresAt ?? null);
  return { ok: true };
});
app.post('/api/admin/users/:id/unblock', async (request, reply) => {
  const user = (request as any).user;
  if (!can(user, 'user.block')) return reply.code(403).send({ error: 'forbidden' });
  const body = request.body as any;
  const targetId = nullablePositiveInt((request.params as any).id);
  if (!targetId) return reply.code(400).send({ error: 'invalid_user_id' });
  await unblockUser(targetId, user?.id ?? null, body?.reason ?? '관리자 차단 해제');
  return { ok: true };
});
app.get('/api/admin/acl-groups', async (request, reply) => {
  const user = (request as any).user;
  if (!canManageAclGroups(user)) return reply.code(403).send({ error: 'forbidden' });
  return query<any>(
    `SELECT g.id, g.group_key, g.title, g.description, g.status, g.created_at, g.updated_at,
            COUNT(m.id) AS active_member_count
     FROM acl_groups g
     LEFT JOIN acl_group_members m ON m.group_id=g.id
       AND m.removed_at IS NULL
       AND (m.expires_at IS NULL OR m.expires_at > NOW())
     GROUP BY g.id
     ORDER BY g.group_key`
  );
});
app.post('/api/admin/acl-groups/:key/members', async (request, reply) => {
  const user = (request as any).user;
  if (!canManageAclGroups(user)) return reply.code(403).send({ error: 'forbidden' });
  const groupKey = String((request.params as any).key ?? '').trim();
  if (!/^[a-z0-9_-]{1,64}$/.test(groupKey)) return reply.code(400).send({ error: 'invalid_group' });
  const group = await one<any>(`SELECT id, group_key FROM acl_groups WHERE group_key=:groupKey AND status!='archived'`, { groupKey });
  if (!group) return reply.code(404).send({ error: 'group_not_found' });
  const body = request.body as any;
  const memberType = String(body.memberType ?? '').trim();
  const reason = boundedText(body.reason, 500);
  const expiresAt = aclExpiresAt(body.expiresIn);
  if (memberType === 'user') {
    const userId = nullablePositiveInt(body.userId ?? body.value);
    if (!userId) return reply.code(400).send({ error: 'invalid_user' });
    await exec(
      `INSERT INTO acl_group_members (group_id, member_type, user_id, reason, expires_at, added_by, added_at)
       VALUES (:groupId, 'user', :userId, :reason, :expiresAt, :addedBy, NOW())`,
      { groupId: group.id, userId, reason, expiresAt, addedBy: user?.id ?? null }
    );
    return { ok: true };
  }
  if (memberType === 'ip') {
    const ip = String(body.ip ?? body.value ?? '').trim();
    if (!net.isIP(ip)) return reply.code(400).send({ error: 'invalid_ip' });
    await exec(
      `INSERT INTO acl_group_members (group_id, member_type, ip, reason, expires_at, added_by, added_at)
       VALUES (:groupId, 'ip', INET6_ATON(:ip), :reason, :expiresAt, :addedBy, NOW())`,
      { groupId: group.id, ip, reason, expiresAt, addedBy: user?.id ?? null }
    );
    return { ok: true };
  }
  if (memberType === 'cidr') {
    const cidr = normalizeAclSubjectValue('cidr', body.cidr ?? body.value);
    if (!cidr) return reply.code(400).send({ error: 'invalid_cidr' });
    await exec(
      `INSERT INTO acl_group_members (group_id, member_type, cidr, reason, expires_at, added_by, added_at)
       VALUES (:groupId, 'cidr', :cidr, :reason, :expiresAt, :addedBy, NOW())`,
      { groupId: group.id, cidr, reason, expiresAt, addedBy: user?.id ?? null }
    );
    return { ok: true };
  }
  return reply.code(400).send({ error: 'invalid_member_type' });
});
app.delete('/api/admin/acl-groups/:key/members/:memberId', async (request, reply) => {
  const user = (request as any).user;
  if (!canManageAclGroups(user)) return reply.code(403).send({ error: 'forbidden' });
  const groupKey = String((request.params as any).key ?? '').trim();
  const memberId = nullablePositiveInt((request.params as any).memberId);
  if (!memberId || !/^[a-z0-9_-]{1,64}$/.test(groupKey)) return reply.code(400).send({ error: 'invalid_request' });
  const result = await exec(
    `UPDATE acl_group_members m
     JOIN acl_groups g ON g.id=m.group_id
     SET m.removed_at=NOW()
     WHERE m.id=:memberId AND g.group_key=:groupKey AND m.removed_at IS NULL`,
    { memberId, groupKey }
  );
  return { ok: Number(result.affectedRows ?? 0) > 0 };
});
app.post('/api/admin/pages/:id/hide-revision', async (request, reply) => {
  const user = (request as any).user;
  return hideRevisionRequest(reply, user, nullablePositiveInt((request.body as any).revisionId), request.body as any);
});
app.post('/api/admin/pages/:id/unhide-revision', async (request, reply) => {
  const user = (request as any).user;
  return unhideRevisionRequest(reply, user, nullablePositiveInt((request.body as any).revisionId), request.body as any);
});
app.post('/admin/pages/:id/unhide-revision', async (request, reply) => {
  const user = (request as any).user;
  try {
    const result = await unhideRevisionAction(user, nullablePositiveInt((request.body as any).revisionId), request.body as any);
    return reply.redirect(result.href);
  } catch (error: any) {
    return adminError(reply, user, error?.statusCode ?? 400, '리비전 숨김 해제 오류', String(error?.message ?? '리비전을 공개할 수 없습니다.'), '/recent', '최근 바뀜');
  }
});

app.post('/api/files', async (request, reply) => {
  const result = await uploadFileAction(request);
  if (!result.ok) return reply.code(result.status).send({ error: result.code, fileName: result.fileName });
  return { id: result.id, fileName: result.fileName, storageKey: result.storageKey, url: result.url };
});

function defaultMarkup(title: string, namespace: NamespaceCode = 'main', documentType = documentTypeForNamespace(namespace)) {
  const safeTitle = title || '새 문서';
  const type = normalizeDocumentType(documentType);
  const templates: Record<string, string> = {
    vanilla: `{{문서 상태\n|기준=Java Edition 1.21\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n'''${safeTitle}''' 문서의 첫 문장을 작성합니다.\n\n== 개요 ==\n\n== 관련 문서 ==\n* [[Minecraft]]\n\n[[분류:검증 필요 문서]]\n`,
    mob: `{{문서 상태\n|기준=Java Edition 1.21\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n{{몹 정보\n|이름=${safeTitle}\n|영문=\n|이미지=\n|분류=\n|체력=\n|공격력=\n|스폰=\n|드롭=\n|경험치=\n|에디션=\n}}\n\n'''${safeTitle}'''은 Minecraft의 몹이다.\n\n== 개요 ==\n\n== 생성 ==\n\n== 행동 ==\n\n== 전투 ==\n\n== 드롭 ==\n\n== Java Edition과 Bedrock Edition의 차이 ==\n\n== 역사 ==\n\n== 관련 문서 ==\n\n[[분류:몹]]\n[[분류:검증 필요 문서]]\n`,
    block: `{{문서 상태\n|기준=Java Edition 1.21\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n{{블록 정보\n|이름=${safeTitle}\n|영문=\n|이미지=\n|종류=\n|투명=\n|밝기=\n|경도=\n|폭발 저항=\n|도구=\n|중첩=\n|획득=\n}}\n\n'''${safeTitle}'''은 Minecraft의 블록이다.\n\n== 개요 ==\n\n== 획득 ==\n\n== 사용 ==\n\n== 역사 ==\n\n== 관련 문서 ==\n\n[[분류:블록]]\n[[분류:검증 필요 문서]]\n`,
    item: `{{문서 상태\n|기준=Java Edition 1.21\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n{{아이템 정보\n|이름=${safeTitle}\n|영문=\n|이미지=\n|종류=\n|중첩=\n|내구도=\n|희귀도=\n|획득=\n|사용처=\n}}\n\n'''${safeTitle}'''은 Minecraft의 아이템이다.\n\n== 개요 ==\n\n== 획득 ==\n\n== 사용 ==\n\n== 역사 ==\n\n== 관련 문서 ==\n\n[[분류:아이템]]\n[[분류:검증 필요 문서]]\n`,
    guide: `{{문서 상태\n|기준=Java Edition 1.21\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n'''${safeTitle}'''는 Minecraft 플레이 흐름을 설명하는 가이드입니다.\n\n== 준비물 ==\n\n== 절차 ==\n\n== 관련 문서 ==\n* [[Minecraft]]\n\n[[분류:가이드]]\n[[분류:검증 필요 문서]]\n`,
    mod: `{{문서 상태\n|기준=문서 내 버전표\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n{{모드 정보\n|이름=${safeTitle}\n|영문=\n|분류=\n|로더=\n|지원 버전=\n|클라이언트 필요=\n|서버 필요=\n|의존성=\n|공식 링크=\n|소스 코드=\n|라이선스=\n|한국어=\n|마지막 확인=2026.05.23. 16:04\n}}\n\n'''${safeTitle}'''은 Minecraft 관련 모드입니다.\n\n== 개요 ==\n\n== 설치 ==\n\n[[분류:모드]]\n[[분류:검증 필요 문서]]\n`,
    mod_wiki: `{{문서 상태\n|기준=모드 위키\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n'''${safeTitle}''' 문서입니다.\n\n== 개요 ==\n\n== 사용법 ==\n\n[[분류:모드 위키]]\n[[분류:검증 필요 문서]]\n`,
    server: `{{문서 상태\n|기준=서버 문서 정책\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n{{서버 정보\n|이름=${safeTitle}\n|주소=\n|에디션=Java Edition\n|지원 버전=\n|장르=\n|인증=미인증\n|운영 상태=인증 없음\n|화이트리스트=\n|디스코드=\n|공식 사이트=\n|상태 확인=미사용\n|마지막 확인=2026.05.23. 16:04\n}}\n\n'''${safeTitle}'''는 Minecraft 서버 문서입니다.\n\n== 접속 ==\n\n== 규칙 ==\n\n[[분류:서버]]\n`,
    server_wiki: `{{문서 상태\n|기준=서버 공식 위키\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n{{공식 영역\n|문서=서버:${safeTitle}\n}}\n\n'''${safeTitle}''' 문서는 서버 운영자가 관리하는 공식 문서입니다.\n\n== 안내 ==\n\n[[분류:서버]]\n[[분류:공식 영역]]\n`,
    dev: `{{개발 문서 상태\n|대상=Java Edition\n|버전=1.21.x\n|검증=필요\n|출처=공식 문서, 테스트\n|확인일=2026.05.23. 16:04\n}}\n\n{{API 정보\n|이름=${safeTitle}\n|대상=Plugin\n|언어=Java\n|지원=Paper\n|버전=1.21.x\n|공식 링크=\n}}\n\n'''${safeTitle}'''는 Minecraft 개발 문서입니다.\n\n== 개요 ==\n\n== 예제 ==\n{{코드 예제\n|제목=예제\n|언어=text\n|코드=\n}}\n\n[[분류:개발]]\n[[분류:검증 필요 문서]]\n`,
    data: `{{문서 상태\n|기준=데이터 문서\n|상태=검증 필요\n|확인일=2026.05.23. 16:04\n}}\n\n'''${safeTitle}''' 데이터 문서입니다.\n\n== 표 ==\n{| class=\"wikitable\"\n! 항목 !! 값 !! 기준\n|-\n|  ||  || \n|}\n\n[[분류:데이터]]\n[[분류:검증 필요 문서]]\n`
  };
  return templates[type] ?? templates.vanilla;
}

function normalizeDocumentType(type: string) {
  const allowed = new Set(['vanilla', 'mob', 'block', 'item', 'guide', 'mod', 'mod_wiki', 'server', 'server_wiki', 'dev', 'data']);
  return allowed.has(type) ? type : 'vanilla';
}

function documentTypeForNamespace(namespace: NamespaceCode) {
  const map: Partial<Record<NamespaceCode, string>> = {
    guide: 'guide',
    mod: 'mod',
    modpack: 'mod',
    server: 'server',
    dev: 'dev',
    data: 'data',
    project: 'vanilla',
    help: 'guide'
  };
  return map[namespace] ?? 'vanilla';
}

function documentTypeConfig(type: string): { namespace: NamespaceCode } {
  const map: Record<string, NamespaceCode> = {
    vanilla: 'main',
    mob: 'main',
    block: 'main',
    item: 'main',
    guide: 'guide',
    mod: 'mod',
    mod_wiki: 'mod',
    server: 'server',
    server_wiki: 'server',
    dev: 'dev',
    data: 'data'
  };
  return { namespace: map[normalizeDocumentType(type)] ?? 'main' };
}

function pageTypeForDocumentType(type: string) {
  const map: Record<string, string> = {
    vanilla: 'article',
    mob: 'mob',
    block: 'block',
    item: 'item',
    guide: 'guide',
    mod: 'mod',
    mod_wiki: 'mod',
    server: 'server',
    server_wiki: 'server',
    dev: 'dev',
    data: 'data'
  };
  return map[normalizeDocumentType(type)] ?? 'article';
}

function normalizeSavedPageType(value: unknown) {
  const type = String(value ?? '');
  if (!type || type === 'general') return undefined;
  return type;
}

async function splitSectionAction(user: any, pageId: number | null, body: any) {
  if (!can(user, 'page.move')) throw actionError(403, 'forbidden', '문서 이동 권한이 필요합니다.');
  if (!pageId) throw actionError(400, 'invalid_page_id', '문서 번호가 올바르지 않습니다.');
  const page = await getPageById(pageId);
  if (!page) throw actionError(404, 'page_not_found', '문서를 찾을 수 없습니다.');
  const section = await getSection(Number(page.id), String(body.anchor ?? ''));
  if (!section) throw actionError(404, 'section_not_found', '분리할 문단을 찾을 수 없습니다.');
  const targetNamespace = normalizeEditableNamespace(body.targetNamespace ?? body.namespace ?? page.namespace_code);
  if (!targetNamespace) throw actionError(400, 'invalid_namespace', '대상 이름공간이 올바르지 않습니다.');
  const targetTitle = normalizeTitle(body.targetTitle ?? body.title ?? section.title);
  if (!targetTitle) throw actionError(400, 'target_title_required', '분리할 문서명을 입력하세요.');
  const saved = await savePage({
    namespace: targetNamespace,
    title: targetTitle,
    content: section.content,
    summary: `문단 분리: ${page.display_title ?? page.title}#${section.title}`,
    userId: user?.id ?? null,
    pageType: body.pageType ?? page.page_type ?? undefined,
    skipReview: true
  });
  if (saved.pending) throw actionError(409, 'page_requires_review', '분리 대상 문서가 검토 대기 상태로 생성되었습니다.');
  const removeOriginal = body.removeOriginal === true || body.removeOriginal === 'true' || body.removeOriginal === '1';
  if (removeOriginal) {
    const nextContent = removeSectionFromContent(String(page.content_raw ?? ''), Number(section.startLine), Number(section.endLine));
    await assertLockedSectionsUnchanged(page, nextContent, user);
    await savePage({
      namespace: page.namespace_code,
      title: page.title,
      content: nextContent,
      summary: `문단 분리: ${section.title} -> ${targetTitle}`,
      userId: user?.id ?? null,
      pageType: page.page_type ?? undefined,
      skipReview: true
    });
  }
  await logAdmin(user?.id ?? null, 'page.split_section', 'page', Number(page.id), {
    anchor: section.anchor,
    sectionTitle: section.title,
    targetNamespace,
    targetTitle,
    targetPageId: saved.pageId,
    removeOriginal
  });
  return { ok: true, pageId: saved.pageId, revisionId: saved.revisionId, href: wikiUrl(targetNamespace, targetTitle) };
}

async function mergePageAction(user: any, targetPageId: number | null, body: any) {
  if (!can(user, 'page.move')) throw actionError(403, 'forbidden', '문서 이동 권한이 필요합니다.');
  if (!targetPageId) throw actionError(400, 'invalid_page_id', '대상 문서 번호가 올바르지 않습니다.');
  const sourcePage = await searchTargetPageFromBody(body, ['sourcePageRef', 'sourcePageId', 'source_page_id']);
  if (!sourcePage) throw actionError(400, 'invalid_source_page_id', '병합할 원본 문서를 제목 또는 번호로 입력하세요.');
  const target = await getPageById(targetPageId);
  if (!target) throw actionError(404, 'target_page_not_found', '대상 문서를 찾을 수 없습니다.');
  if (Number(sourcePage.id) === Number(target.id)) throw actionError(400, 'same_page_merge', '같은 문서는 병합할 수 없습니다.');
  const source = await getPageById(Number(sourcePage.id));
  if (!source) throw actionError(404, 'source_page_not_found', '병합할 원본 문서를 찾을 수 없습니다.');
  const sectionTitle = normalizeTitle(body.sectionTitle ?? body.heading ?? source.display_title ?? source.title);
  const deleteSource = body.deleteSource === true || body.deleteSource === 'true' || body.deleteSource === '1';
  if (deleteSource && !can(user, 'page.delete')) throw actionError(403, 'delete_forbidden', '원본 삭제 권한이 필요합니다.');
  const targetContent = String(target.content_raw ?? '').trimEnd();
  const sourceContent = String(source.content_raw ?? '').trim();
  const mergedContent = `${targetContent}${targetContent ? '\n\n' : ''}== ${sectionTitle} ==\n\n${sourceContent}`.trimEnd();
  await assertLockedSectionsUnchanged(target, mergedContent, user);
  const saved = await savePage({
    namespace: target.namespace_code,
    title: target.title,
    content: mergedContent,
    summary: `문서 병합: ${source.display_title ?? source.title}`,
    userId: user?.id ?? null,
    pageType: target.page_type ?? undefined,
    skipReview: true
  });
  if (saved.pending) throw actionError(409, 'page_requires_review', '병합 편집이 검토 대기 상태로 저장되었습니다.');
  await addPageAlias(target.namespace_code, source.display_title ?? source.title, Number(target.id), 'redirect');
  if (deleteSource) await deletePage(Number(source.id), user?.id ?? null);
  await logAdmin(user?.id ?? null, 'page.merge', 'page', Number(target.id), {
    sourcePageId: Number(source.id),
    sourceTitle: source.display_title ?? source.title,
    sectionTitle,
    deleteSource
  });
  return { ok: true, pageId: saved.pageId, revisionId: saved.revisionId, href: wikiUrl(target.namespace_code, target.title) };
}

async function resolvePendingReviewAction(user: any, reviewId: number | null, body: any) {
  if (!can(user, 'report.handle')) throw actionError(403, 'forbidden', '관리 권한이 필요합니다.');
  if (!reviewId) throw actionError(400, 'invalid_review_id', '검토 번호가 올바르지 않습니다.');
  const status = normalizeReviewStatus(body.status ?? 'approved');
  if (!status) throw actionError(400, 'invalid_status', '검토 상태가 올바르지 않습니다.');
  const review = await pendingReviewDetail(reviewId);
  if (!review) throw actionError(404, 'review_not_found', '검토 항목을 찾을 수 없습니다.');
  let saved: any = null;
  if (status === 'approved') {
    if (review.review_type === 'mod_link') {
      await approveModLinkReview(review, user?.id ?? null);
    } else {
      if (!review.draft) throw actionError(400, 'draft_not_found', '검토할 초안을 찾을 수 없습니다.');
      saved = appliedPage(await savePage({
        namespace: review.draft.namespace_code as NamespaceCode,
        title: review.draft.title,
        content: review.draft.content_raw,
        summary: review.draft.edit_summary ?? '검토 승인',
        userId: review.submitted_by ?? user?.id ?? null,
        pageType: review.draft.page_type ?? undefined,
        baseRevisionId: review.draft.base_revision_id ? Number(review.draft.base_revision_id) : null,
        isMinor: parseBoolean(review.draft.is_minor),
        editTags: parseJsonArray(review.draft.edit_tags),
        skipReview: true
      }));
      await exec(`UPDATE pending_reviews SET target_id=:revisionId, page_id=:pageId WHERE id=:id`, {
        id: reviewId,
        revisionId: saved.revisionId,
        pageId: saved.pageId
      });
    }
  }
  const reason = body.reason ? `${review.reason ?? ''}${review.reason ? ' / ' : ''}검토: ${String(body.reason).slice(0, 120)}` : review.reason;
  await exec(`UPDATE pending_reviews SET status=:status, reason=:reason, reviewed_by=:userId, reviewed_at=NOW() WHERE id=:id`, {
    id: reviewId,
    status,
    reason,
    userId: user?.id ?? null
  });
  const isFinal = status === 'approved' || status === 'rejected';
  await exec(
    `UPDATE admin_work_items
     SET status=IF(:isFinal, 'done', 'in_progress'), assigned_to=COALESCE(assigned_to, :userId), updated_at=NOW()
     WHERE work_type='pending_review' AND target_type='pending_review' AND target_id=:id`,
    { id: reviewId, userId: user?.id ?? null, isFinal }
  );
  await exec(
    `UPDATE admin_work_items
     SET status=IF(:isFinal, 'done', 'in_progress'), assigned_to=COALESCE(assigned_to, :userId), updated_at=NOW()
     WHERE work_type='mod_link_review' AND target_type='pending_review' AND target_id=:id`,
    { id: reviewId, userId: user?.id ?? null, isFinal }
  );
  await logAdmin(user?.id ?? null, `review.${status}`, 'revision', reviewId, { savedPageId: saved?.pageId ?? null, reason: body.reason ?? null });
  return { ok: true, status, savedPageId: saved?.pageId ?? null };
}

async function createPageRequestAction(request: any, reply: any) {
  if (!consumeActorRateLimit(request, 'page-request', 10, 30, 60 * 60 * 1000)) throw actionError(429, 'rate_limited', '짧은 시간 안에 요청이 너무 많습니다. 잠시 후 다시 시도하세요.');
  if (!(await requireAnonymousTurnstile(request, reply, 'page_request'))) return null;
  const body = request.body as any;
  const namespace = String(body.namespace ?? 'main') as NamespaceCode;
  const title = normalizeTitle(body.title ?? body.requestedTitle ?? '');
  if (!title) throw actionError(400, 'title_required', '요청할 문서명을 입력하세요.');
  const ns = await one<any>(`SELECT id FROM namespaces WHERE code=:namespace`, { namespace });
  if (!ns) throw actionError(400, 'namespace_not_found', '이름공간을 찾을 수 없습니다.');
  const existingPage = await getPageByTitle(namespace, title);
  const readableExistingPage = existingPage && await canReadPageResource(aclActorForRequest(request), existingPage) ? existingPage : null;
  const result = await exec(
    `INSERT INTO page_requests (namespace_id, requested_title, reason, requested_by, status, target_page_id, created_at, updated_at)
     VALUES (:namespaceId, :title, :reason, :userId, :status, :targetPageId, NOW(), NOW())`,
    {
      namespaceId: ns.id,
      title,
      reason: boundedText(body.reason, 1000) || null,
      userId: request.user?.id ?? null,
      status: readableExistingPage ? 'created' : 'open',
      targetPageId: readableExistingPage?.id ?? null
    }
  );
  return { id: result.insertId, status: readableExistingPage ? 'created' : 'open', ok: true };
}

async function betaInviteByCode(inviteCode: unknown) {
  const code = String(inviteCode ?? '').trim();
  if (!code) return null;
  return one<any>(
    `SELECT ${betaInviteFields} FROM beta_invites WHERE invite_code=:code AND status='unused' AND (expires_at IS NULL OR expires_at > NOW())`,
    { code }
  );
}

function betaInviteGroup(roleHint: unknown) {
  const role = String(roleHint ?? '').trim();
  if (role === 'mod_editor') return 'mod_editor';
  if (role === 'server_owner') return 'server_owner';
  return 'user';
}

function decodePathPart(value: string) {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}

async function hideRevisionRequest(reply: any, user: any, revisionId: number | null, body: any = {}) {
  try {
    return await hideRevisionAction(user, revisionId, body);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
}

async function unhideRevisionRequest(reply: any, user: any, revisionId: number | null, body: any = {}) {
  try {
    return await unhideRevisionAction(user, revisionId, body);
  } catch (error: any) {
    return jsonActionError(reply, error);
  }
}

async function hideRevisionAction(user: any, revisionId: number | null, body: any = {}) {
  if (!can(user, 'revision.hide') && !can(user, 'page.delete')) throw actionError(403, 'forbidden', '리비전 숨김 권한이 필요합니다.');
  if (!revisionId) throw actionError(400, 'revision_required', '리비전 번호가 필요합니다.');
  const revision = await one<{ id: number }>(
    `SELECT pr.id
     FROM page_revisions pr
     JOIN pages p ON p.id=pr.page_id
     WHERE pr.id=:revisionId`,
    { revisionId }
  );
  if (!revision) throw actionError(404, 'revision_not_found', '리비전을 찾을 수 없습니다.');
  const visibility = normalizeRevisionVisibility(body.visibility) ?? 'admin_only';
  if (visibility === 'suppressed' && !canViewSuppressedRevisions(user)) throw actionError(403, 'suppress_forbidden', '숨김 권한이 부족합니다.');
  await hideRevision(revisionId, user?.id ?? null, body.reason ?? '관리자 리비전 숨김', visibility);
  return { ok: true, href: '/admin/recent' };
}

async function unhideRevisionAction(user: any, revisionId: number | null, body: any = {}) {
  if (!can(user, 'revision.hide') && !can(user, 'page.delete')) throw actionError(403, 'forbidden', '리비전 숨김 권한이 필요합니다.');
  if (!revisionId) throw actionError(400, 'revision_required', '리비전 번호가 필요합니다.');
  const revision = await one<{ id: number; visibility: string; namespace_code: NamespaceCode; title: string }>(
    `SELECT pr.id, pr.visibility, p.namespace_code, p.title
     FROM page_revisions pr
     JOIN pages p ON p.id=pr.page_id
     WHERE pr.id=:revisionId`,
    { revisionId }
  );
  if (!revision) throw actionError(404, 'revision_not_found', '리비전을 찾을 수 없습니다.');
  if (revision.visibility === 'suppressed' && !canViewSuppressedRevisions(user)) throw actionError(403, 'suppress_forbidden', '숨김 해제 권한이 부족합니다.');
  await unhideRevision(revisionId, user?.id ?? null, body.reason ?? '관리자 리비전 숨김 해제');
  return { ok: true, href: `${wikiUrl(revision.namespace_code, revision.title)}/history` };
}

function normalizeRevisionVisibility(value: unknown) {
  const visibility = String(value ?? '').trim();
  return ['hidden', 'admin_only', 'suppressed'].includes(visibility) ? (visibility as 'hidden' | 'admin_only' | 'suppressed') : null;
}

function parseBoolean(value: unknown) {
  return value === true || value === 1 || value === '1' || value === 'true' || value === 'on';
}

function parseJsonArray(value: unknown) {
  if (Array.isArray(value)) return value.map(String);
  if (!value) return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value: unknown) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, any>;
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, any> : {};
  } catch {
    return {};
  }
}

async function fileRenderMap(ast: any[]) {
  const fileNames = [...new Set(ast.filter((node) => node.type === 'file').map((node) => node.fileName))];
  if (fileNames.length === 0) return {};
  const rows = await query<any>(
    `SELECT file_name, original_name, storage_key, mime_type, source_text
     FROM files
     WHERE file_name IN (:fileNames) AND status='normal'`,
    { fileNames }
  );
  return Object.fromEntries(
    rows.map((file) => [
      file.file_name,
      {
        url: `${config.cdnPublicUrl}/${file.storage_key}`,
        mimeType: file.mime_type,
        originalName: file.original_name,
        sourceText: file.source_text
      }
    ])
  );
}

async function fileDetail(fileName: string, user: any) {
  const includeRestricted = can(user, 'report.handle');
  const file = await one<any>(
    `SELECT f.id, f.uploader_id, f.original_name, f.file_name, f.storage_key, f.mime_type, f.size_bytes, f.width, f.height, f.sha256, f.license, f.source_url, f.source_text, f.status, f.created_at,
            u.username AS uploader_username,
            u.display_name AS uploader_display_name
     FROM files f
     LEFT JOIN users u ON u.id=f.uploader_id
     WHERE f.file_name=:fileName
       AND (f.status IN ('normal','license_needed') OR (:includeRestricted=1 AND f.status!='deleted'))`,
    { fileName, includeRestricted: includeRestricted ? 1 : 0 }
  );
  if (!file) return null;
  const usages = await query<any>(
    `SELECT fu.usage_context, fu.created_at, p.id AS page_id, p.id, p.space_id, p.protection_level, p.status, p.title, p.display_title, n.code AS namespace_code
     FROM file_usages fu
     JOIN pages p ON p.id=fu.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE fu.file_id=:fileId AND p.status NOT IN ('deleted','hidden')
     ORDER BY p.updated_at DESC, p.title`,
    { fileId: file.id }
  );
  const visibleUsages = [];
  for (const usage of usages) {
    if (await canReadPageResource(user, usage)) visibleUsages.push(usage);
  }
  const reports = includeRestricted
    ? await query<any>(
        `SELECT id, reason, status, created_at
         FROM reports
         WHERE target_type='file' AND target_id=:fileId
         ORDER BY created_at DESC LIMIT 10`,
        { fileId: file.id }
      )
    : [];
  return {
    ...file,
    url: `${config.cdnPublicUrl}/${file.storage_key}`,
    usages: visibleUsages,
    reports
  };
}

async function fileLicenseIssueRows() {
  return query<any>(
    `SELECT id, file_name, original_name, storage_key, mime_type, size_bytes, license, source_url, source_text, status, created_at
     FROM files
     WHERE status IN ('normal','license_needed') AND (license IS NULL OR license='' OR source_url IS NULL OR source_url='' OR source_text IS NULL OR source_text='')
     ORDER BY FIELD(status,'license_needed','normal'), created_at DESC LIMIT 200`
  );
}

async function unusedFileRows() {
  return query<any>(
    `SELECT f.id, f.file_name, f.original_name, f.storage_key, f.mime_type, f.size_bytes, f.license, f.source_url, f.source_text, f.status, f.created_at
     FROM files f
     LEFT JOIN file_usages fu ON fu.file_id=f.id
     WHERE f.status IN ('normal','license_needed')
     GROUP BY f.id, f.file_name, f.original_name, f.storage_key, f.mime_type, f.size_bytes, f.license, f.source_url, f.source_text, f.status, f.created_at
     HAVING COUNT(fu.page_id)=0
     ORDER BY f.created_at DESC LIMIT 200`
  );
}

async function updateAdminFileMetadata(fileId: number, body: any, user: any) {
  const status = body.status === undefined || body.status === '' ? null : normalizeFileStatus(body.status);
  if (body.status && !status) return { ok: false, error: 'invalid_file_status' };
  const license = body.license === undefined ? null : boundedOptionalText(body.license, 128);
  const sourceText = body.sourceText === undefined ? null : boundedOptionalText(body.sourceText, 500);
  const sourceUrl = body.sourceUrl === undefined ? null : normalizeOptionalHttpUrl(body.sourceUrl);
  if (body.sourceUrl && !sourceUrl) return { ok: false, error: 'invalid_source_url' };
  await exec(
    `UPDATE files
     SET license=COALESCE(:license, license),
         source_url=COALESCE(:sourceUrl, source_url),
         source_text=COALESCE(:sourceText, source_text),
         status=COALESCE(:status, status)
     WHERE id=:id`,
    {
      id: fileId,
      license,
      sourceUrl,
      sourceText,
      status
    }
  );
  await logAdmin(user?.id ?? null, status === 'hidden' ? 'file.hide' : status === 'deleted' ? 'file.delete' : 'file.update', 'file', fileId, {
    status,
    license
  });
  return { ok: true };
}

function normalizeFileStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['normal', 'license_needed', 'hidden', 'deleted'].includes(status) ? status : null;
}

async function adminSubwikiRequest(id: number) {
  if (!id) return null;
  return one<any>(
    `SELECT sr.id, sr.request_type, sr.title, sr.target_page_id, sr.requested_by, sr.status, sr.note, sr.created_at, sr.updated_at,
       requester.username AS requester_username, requester.display_name AS requester_display_name
     FROM subwiki_requests sr
     LEFT JOIN users requester ON requester.id=sr.requested_by
     WHERE sr.id=:id`,
    { id }
  );
}

async function adminWorkItemForSubwikiRequest(requestId: number) {
  if (!requestId) return null;
  return one<any>(
    `SELECT ${adminWorkItemSelectFields}
     FROM admin_work_items awi
     WHERE awi.work_type='subwiki_request' AND awi.target_id=:requestId
     ORDER BY awi.id DESC LIMIT 1`,
    { requestId }
  );
}

function parseSubwikiRequestNote(note: unknown) {
  const meta: Record<string, string> = {};
  for (const line of String(note ?? '').split(/\r?\n/)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_]*):\s*(.*)$/);
    if (match) meta[match[1]] = match[2].trim();
  }
  return meta;
}

async function resolveSubwikiRequest(row: any, body: any, actorId: number | null) {
  const action = String(body.action ?? '').trim();
  const id = Number(row.id ?? 0);
  if (!id) return { ok: false, error: 'invalid_request_id' };
  if (!['pending', 'approved'].includes(String(row.status ?? 'pending'))) return { ok: false, error: 'already_processed' };
  const note = boundedText(body.note, 1000) || null;
  if (action === 'reject') {
    await exec(`UPDATE subwiki_requests SET status='rejected', updated_at=NOW() WHERE id=:id`, { id });
    await exec(`UPDATE admin_work_items SET status='done', updated_at=NOW() WHERE work_type='subwiki_request' AND target_id=:id`, { id });
    await logAdmin(actorId, 'subwiki_request.reject', 'subwiki_request', id, { note });
    return { ok: true };
  }
  if (action !== 'approve') return { ok: false, error: 'invalid_action' };
  const meta = parseSubwikiRequestNote(row.note);
  const requestType = String(row.request_type ?? 'server');
  const requestBody = {
    title: row.title,
    slug: meta.slug || row.title,
    host: meta.host ?? '',
    edition: meta.edition ?? '',
    supportedVersions: meta.supportedVersions ?? '',
    genres: meta.genres ?? '',
    starterSet: meta.starterSet ?? undefined
  };
  const created = requestType === 'mod'
    ? await createModSubwiki(requestBody, actorId)
    : requestType === 'server'
      ? await createServerSubwiki(requestBody, actorId)
      : null;
  if (!created) return { ok: false, error: 'unsupported_request_type' };
  await exec(
    `UPDATE subwiki_requests
     SET status='created', target_page_id=:targetPageId, updated_at=NOW()
     WHERE id=:id`,
    { id, targetPageId: created.rootPageId ?? null }
  );
  await exec(`UPDATE admin_work_items SET status='done', updated_at=NOW() WHERE work_type='subwiki_request' AND target_id=:id`, { id });
  await logAdmin(actorId, 'subwiki_request.approve', 'subwiki_request', id, {
    requestType,
    slug: created.slug ?? requestBody.slug,
    rootPageId: created.rootPageId ?? null,
    note
  });
  return { ok: true };
}

async function adminWorkItems(limit = 100) {
  return query<any>(
    `SELECT ${adminWorkItemSelectFields}, assignee.username AS assigned_username, assignee.display_name AS assigned_display_name,
       reporter.username AS reporter_username,
       report.reason AS report_reason, report.status AS report_status,
       pr.status AS review_status, pr.reason AS review_reason, prd.namespace_code AS review_namespace, prd.title AS review_title,
       sc.status AS claim_status, sc.method AS claim_method, sc.page_id AS claim_page_id, claim_page.title AS claim_page_title,
       dispute_page.title AS dispute_page_title,
       subwiki.title AS subwiki_title, subwiki.status AS subwiki_status,
       gitbook.status AS gitbook_status, gitbook.source_note AS gitbook_source_note,
       task.title AS task_title, task.status AS task_status
     FROM admin_work_items awi
     LEFT JOIN users assignee ON assignee.id=awi.assigned_to
     LEFT JOIN reports report ON report.id=awi.target_id AND awi.work_type IN ('report','file_license')
     LEFT JOIN users reporter ON reporter.id=report.reporter_id
     LEFT JOIN pending_reviews pr ON pr.id=awi.target_id AND awi.work_type IN ('pending_review','mod_link_review')
     LEFT JOIN pending_review_drafts prd ON prd.review_id=pr.id
     LEFT JOIN server_claims sc ON sc.id=awi.target_id AND awi.work_type='server_claim'
     LEFT JOIN pages claim_page ON claim_page.id=sc.page_id
     LEFT JOIN pages dispute_page ON dispute_page.id=awi.target_id AND awi.work_type='server_dispute'
     LEFT JOIN subwiki_requests subwiki ON subwiki.id=awi.target_id AND awi.work_type='subwiki_request'
     LEFT JOIN gitbook_import_jobs gitbook ON gitbook.id=awi.target_id AND awi.work_type='gitbook_import'
     LEFT JOIN contributor_tasks task ON task.id=awi.target_id AND awi.target_type='contributor_task'
     WHERE awi.status IN ('open','in_progress')
     ORDER BY FIELD(awi.priority,'urgent','high','normal','low'), awi.id DESC
     LIMIT :limit`,
    { limit }
  );
}

async function adminAssignees() {
  return query<any>(
    `SELECT DISTINCT u.id, u.username, u.display_name
     FROM users u
     JOIN user_groups ug ON ug.user_id=u.id
     JOIN groups g ON g.id=ug.group_id
     WHERE u.status='active' AND g.code IN ('admin','moderator','developer','server_owner','mod_editor')
     ORDER BY FIELD(g.code,'admin','moderator','developer','server_owner','mod_editor'), u.username`
  );
}

async function adminReportRows(limit = 100) {
  return query<any>(
    `SELECT r.id, r.target_type, r.target_id, r.page_id, r.reporter_id, r.reason, r.detail, r.status,
            r.resolved_by, r.handled_by, r.created_at, r.resolved_at, r.handled_at,
            n.code AS namespace_code, p.title AS page_title, p.display_title AS page_display_title,
            reporter.username AS reporter_username, reporter.display_name AS reporter_display_name,
            handler.username AS handler_username, handler.display_name AS handler_display_name
     FROM reports r
     LEFT JOIN pages p ON p.id=r.page_id
     LEFT JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN users reporter ON reporter.id=r.reporter_id
     LEFT JOIN users handler ON handler.id=COALESCE(r.handled_by, r.resolved_by)
     ORDER BY FIELD(r.status,'open','reviewing','resolved','rejected'), r.created_at DESC
     LIMIT :limit`,
    { limit }
  );
}

async function adminJobRows(limit = 100) {
  return query<any>(
    `SELECT id, job_type, payload_json, status, attempts, max_attempts, run_after, started_at, finished_at, error_message, created_at
     FROM job_queue
     ORDER BY FIELD(status,'failed','running','pending','done','cancelled'), COALESCE(run_after, created_at), id DESC
     LIMIT :limit`,
    { limit }
  );
}

async function adminImportDashboardData() {
  const [spaces, gitbookJobs, markdownJobs] = await Promise.all([
    query<any>(
      `SELECT id, code, title, name, slug, space_type, status
       FROM wiki_spaces
       WHERE space_type IN ('server_wiki','mod_wiki') AND status!='hidden'
       ORDER BY FIELD(space_type,'server_wiki','mod_wiki'), title, id
       LIMIT 200`
    ),
    query<any>(
      `SELECT gij.id, gij.space_id, gij.requested_by, gij.source_type, gij.status, gij.imported_pages, gij.source_note,
              gij.error_message, gij.created_at, gij.updated_at, ws.code AS space_code, ws.title AS space_title
       FROM gitbook_import_jobs gij
       JOIN wiki_spaces ws ON ws.id=gij.space_id
       ORDER BY gij.id DESC LIMIT 100`
    ),
    query<any>(
      `SELECT mij.id, mij.space_id, mij.source_type, mij.source_name, mij.status, mij.imported_pages, mij.checklist_json,
              mij.created_by, mij.created_at, mij.updated_at, ws.code AS space_code, ws.title AS space_title
       FROM markdown_import_jobs mij
       LEFT JOIN wiki_spaces ws ON ws.id=mij.space_id
       ORDER BY mij.id DESC LIMIT 100`
    )
  ]);
  return { spaces, gitbookJobs, markdownJobs };
}

async function adminSubwikiDashboardData() {
  const [spaces, requests] = await Promise.all([
    query<any>(
      `SELECT ws.id, ws.code, ws.space_key, ws.title, ws.name, ws.slug, ws.space_type, ws.status, ws.root_path, ws.root_namespace_code, ws.root_page_id, ws.updated_at,
              COALESCE(es.host, sw.host) AS host, COALESCE(es.edition, sw.edition) AS edition,
              COALESCE(es.verified_status, sw.verified_status) AS verified_status, es.operational_status, es.status_enabled,
              mw.mod_name, mw.creator_verified, mw.status AS mod_status, mw.category, mw.loaders, mw.supported_versions,
              (SELECT COUNT(*) FROM pages p WHERE p.space_id=ws.id AND p.status!='deleted') AS doc_count,
              (SELECT COUNT(*) FROM subwiki_sidebar_items si WHERE si.space_id=ws.id) AS sidebar_count,
              (SELECT COUNT(*) FROM subwiki_roles sr WHERE sr.space_id=ws.id AND sr.status!='revoked') AS role_count
       FROM wiki_spaces ws
       LEFT JOIN entity_servers es ON es.page_id=ws.root_page_id
       LEFT JOIN server_wikis sw ON sw.space_id=ws.id
       LEFT JOIN mod_wikis mw ON mw.space_id=ws.id
       WHERE ws.space_type IN ('server_wiki','mod_wiki')
       ORDER BY FIELD(ws.status,'pending','active','readonly','needs_maintainer','outdated','inactive','closed','archived','hidden'), FIELD(ws.space_type,'server_wiki','mod_wiki'), ws.title, ws.id
       LIMIT 200`
    ),
    query<any>(
      `SELECT ${subwikiRequestFields}
       FROM subwiki_requests
       ORDER BY FIELD(status,'pending','approved','created','rejected'), id DESC LIMIT 25`
    )
  ]);
  return { spaces, requests };
}

async function modWikiCards(filters: Record<string, string>) {
  const where = [`ws.space_type='mod_wiki'`, `ws.status NOT IN ('archived','hidden')`];
  const params: Record<string, unknown> = {};
  if (filters.q) {
    where.push(`(ws.title LIKE :q OR ws.name LIKE :q OR ws.slug LIKE :q OR mw.mod_name LIKE :q OR ws.description LIKE :q)`);
    params.q = `%${filters.q}%`;
  }
  if (filters.loader) {
    where.push(`mw.loaders LIKE :loader`);
    params.loader = `%${filters.loader}%`;
  }
  if (filters.category) {
    where.push(`mw.category LIKE :category`);
    params.category = `%${filters.category}%`;
  }
  if (filters.version) {
    where.push(`mw.supported_versions LIKE :version`);
    params.version = `%${filters.version}%`;
  }
  return query<any>(
    `SELECT 'mod_wiki' AS card_type, ws.id AS space_id, ws.root_page_id AS id, COALESCE(mw.mod_name, ws.title, ws.name) AS title,
       ws.slug AS wiki_slug, ws.description, ws.updated_at, mw.category, mw.loaders, mw.supported_versions, mw.license,
       mw.creator_verified, mw.last_checked, COALESCE(mw.status, ws.status) AS wiki_status,
       COUNT(p.id) AS doc_count
     FROM wiki_spaces ws
     LEFT JOIN mod_wikis mw ON mw.space_id=ws.id
     LEFT JOIN pages p ON p.space_id=ws.id AND p.status!='deleted'
     WHERE ${where.join(' AND ')}
     GROUP BY ws.id, ws.root_page_id, ws.title, ws.name, ws.slug, ws.description, ws.updated_at,
       mw.mod_name, mw.category, mw.loaders, mw.supported_versions, mw.license, mw.creator_verified, mw.last_checked, mw.status, ws.status
     ORDER BY COALESCE(mw.mod_name, ws.title, ws.name)
     LIMIT 40`,
    params
  );
}

async function serverWikiCards(filters: Record<string, string>) {
  const where = [`ws.space_type='server_wiki'`, `ws.status NOT IN ('archived','hidden')`];
  const params: Record<string, unknown> = {};
  if (filters.q) {
    where.push(`(ws.title LIKE :q OR ws.name LIKE :q OR ws.slug LIKE :q OR sw.server_name LIKE :q OR sw.host LIKE :q OR sw.genres LIKE :q)`);
    params.q = `%${filters.q}%`;
  }
  if (filters.edition) {
    where.push(`sw.edition=:edition`);
    params.edition = filters.edition;
  }
  if (filters.genre) {
    where.push(`sw.genres LIKE :genre`);
    params.genre = `%${filters.genre}%`;
  }
  if (filters.version) {
    where.push(`sw.supported_versions LIKE :version`);
    params.version = `%${filters.version}%`;
  }
  if (filters.verified === '1') where.push(`sw.verified_status='verified'`);
  return query<any>(
    `SELECT 'server_wiki' AS card_type, ws.id AS space_id, ws.root_page_id AS id, COALESCE(sw.server_name, ws.title, ws.name) AS title,
       ws.slug AS wiki_slug, ws.description, ws.updated_at, sw.host, sw.edition, sw.supported_versions, sw.genres,
       COALESCE(sw.verified_status, 'none') AS verified_status, COALESCE(sw.status, ws.status) AS wiki_status,
       COUNT(DISTINCT p.id) AS doc_count, COUNT(DISTINCT sr.user_id) AS owner_count
     FROM wiki_spaces ws
     LEFT JOIN server_wikis sw ON sw.space_id=ws.id
     LEFT JOIN pages p ON p.space_id=ws.id AND p.status!='deleted'
     LEFT JOIN subwiki_roles sr ON sr.space_id=ws.id AND sr.status='active' AND sr.role IN ('owner','manager','editor')
     WHERE ${where.join(' AND ')}
     GROUP BY ws.id, ws.root_page_id, ws.title, ws.name, ws.slug, ws.description, ws.updated_at,
       sw.server_name, sw.host, sw.edition, sw.supported_versions, sw.genres, sw.verified_status, sw.status, ws.status
     ORDER BY COALESCE(sw.server_name, ws.title, ws.name)
     LIMIT 40`,
    params
  );
}

async function renderOperatorHome(request: any, reply: any) {
  const user = request.user;
  if (!can(user, 'report.handle')) return adminAccessDenied(reply, request, '운영자 홈 접근 권한이 필요합니다.');
  const [summary, work] = await Promise.all([operatorHomeSummary(), adminWorkItems(40)]);
  return reply.type('text/html').send(operatorHomePage(summary, work, user));
}

async function operatorHomeSummary() {
  return query<any>(
    `SELECT 'report' AS work_type, '신고 대기' AS label, COUNT(*) AS count, '/admin' AS href, '열린 신고와 검토 중인 신고' AS detail
     FROM reports WHERE status IN ('open','reviewing')
     UNION ALL
     SELECT 'pending_review', '검토 큐', COUNT(*), '/admin/work', '승인 대기 중인 문서 검토'
     FROM pending_reviews WHERE status='pending'
     UNION ALL
     SELECT 'server_claim', '서버 인증 대기', COUNT(*), '/admin/work', '처리할 서버 소유자 인증'
     FROM server_claims WHERE status='pending'
     UNION ALL
     SELECT 'subwiki_request', '위키 신청', COUNT(*), '/admin/work', '처리할 서버/모드 위키 신청'
     FROM subwiki_requests WHERE status='pending'
     UNION ALL
     SELECT 'gitbook_import', 'GitBook 이전 요청', COUNT(*), '/admin/work', '검토 또는 재실행이 필요한 이전 작업'
     FROM gitbook_import_jobs WHERE status IN ('pending','mapping','review','failed')
     UNION ALL
     SELECT 'file_license', '파일 라이선스 문제', COUNT(*), '/admin/files', '라이선스 또는 출처 확인 필요'
     FROM files WHERE status='normal' AND (license IS NULL OR license='' OR source_text IS NULL OR source_text='')
     UNION ALL
     SELECT 'mod_link_review', '모드 링크 검토', COUNT(*), '/admin/mod-verification', '열린 모드 링크 검증 작업'
     FROM mod_verification_tasks WHERE task_type='link_check' AND status IN ('open','in_progress')
     UNION ALL
     SELECT 'search_alias', '검색 실패어', COUNT(DISTINCT query), '/admin/search', '결과가 없는 검색어'
     FROM search_query_logs WHERE result_count=0
     UNION ALL
     SELECT 'develop_review', '개발 위키 검증 필요 문서', COUNT(DISTINCT p.id), '/dev', '품질 상태 확인 필요'
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id AND n.code='dev'
     LEFT JOIN page_quality_status qs ON qs.page_id=p.id
     WHERE p.status!='deleted' AND COALESCE(qs.status, 'needs_check')!='normal'
     UNION ALL
     SELECT 'server_dispute', '서버 분쟁 문서', COUNT(*), '/servers', '운영 상태 분쟁 표시'
     FROM entity_servers WHERE operational_status='disputed'
     UNION ALL
     SELECT 'job_failed', '작업 큐 실패', COUNT(*), '/admin/jobs', '실패한 자동 작업'
     FROM job_queue WHERE status='failed'`
  );
}

async function betaFeedbackItems(limit = 50) {
  return query<any>(
    `SELECT bf.id, bf.feedback_type, bf.title, bf.body, bf.status, bf.created_at, p.title AS page_title
     FROM beta_feedback bf
     LEFT JOIN pages p ON p.id=bf.page_id
     ORDER BY FIELD(bf.status,'open','reviewing','done','wontfix'), bf.id DESC
     LIMIT :limit`,
    { limit }
  );
}

async function updateBetaFeedback(id: number, status: unknown, userId: number | null) {
  const normalized = normalizeFeedbackStatus(status);
  await exec(
    `UPDATE beta_feedback
     SET status=:status, handled_by=IF(:status IN ('done','wontfix'), :userId, handled_by),
         handled_at=IF(:status IN ('done','wontfix'), NOW(), handled_at)
     WHERE id=:id`,
    { id, status: normalized, userId }
  );
}

function normalizeFeedbackType(value: unknown) {
  const type = String(value ?? 'other');
  return ['bug', 'syntax', 'search', 'editor', 'server_claim', 'mod_verification', 'policy', 'other'].includes(type) ? type : 'other';
}

function normalizeIssueSeverity(value: unknown) {
  const severity = String(value ?? 'medium').trim();
  return ['critical', 'high', 'medium', 'low'].includes(severity) ? severity : 'medium';
}

function boundedText(value: unknown, maxLength: number) {
  return String(value ?? '').trim().slice(0, maxLength);
}

function boundedOptionalText(value: unknown, maxLength: number) {
  const text = boundedText(value, maxLength);
  return text || null;
}

function boundedKey(value: unknown, maxLength: number) {
  const key = boundedText(value, maxLength);
  return /^[a-zA-Z0-9._:-]+$/.test(key) ? key : '';
}

function limitedText(value: unknown, maxLength: number) {
  const text = String(value ?? '');
  return text.length <= maxLength ? text : null;
}

function boundedPositiveInt(value: unknown, max: number) {
  const integer = nullablePositiveInt(value);
  return integer && integer <= max ? integer : null;
}

function boundedUnsignedInt(value: unknown, max: number) {
  const number = Number(value);
  if (!Number.isInteger(number) || number < 0 || number > max) return null;
  return number;
}

function normalizeContributorTaskType(value: unknown) {
  const type = String(value ?? '').trim();
  return ['write_page', 'improve_stub', 'fix_broken_link', 'add_category', 'verify_mod', 'verify_server', 'fix_search_alias', 'check_file_license', 'review_edit', 'policy_review'].includes(type)
    ? type
    : null;
}

function normalizeContributorTaskTargetType(value: unknown) {
  const type = String(value ?? 'none').trim();
  return ['page', 'revision', 'file', 'search_term', 'server', 'mod', 'none'].includes(type) ? type : null;
}

function normalizeTaskPriority(value: unknown) {
  const priority = String(value ?? 'normal').trim();
  return ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : null;
}

function normalizeContributorTaskStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['open', 'assigned', 'done', 'skipped', 'blocked'].includes(status) ? status : null;
}

function normalizeBetaIssueType(value: unknown) {
  const type = String(value ?? 'other').trim();
  return ['bug', 'permission', 'security', 'editor', 'parser', 'search', 'server_wiki', 'mod_wiki', 'file', 'policy', 'performance', 'ui', 'content', 'other'].includes(type)
    ? type
    : 'other';
}

function normalizeBetaIssueStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['open', 'triaged', 'in_progress', 'fixed', 'wontfix', 'duplicate'].includes(status) ? status : null;
}

function normalizeReleaseGateStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['not_started', 'checking', 'passed', 'failed', 'waived'].includes(status) ? status : null;
}

function normalizeReleaseBlockerType(value: unknown) {
  const type = String(value ?? 'other').trim();
  return ['security', 'permission', 'data_loss', 'search', 'content', 'server_policy', 'mod_policy', 'admin', 'performance', 'other'].includes(type) ? type : 'other';
}

function normalizeReleaseBlockerSourceType(value: unknown) {
  const type = String(value ?? 'manual').trim();
  return ['beta_issue', 'security_test', 'content_audit', 'search_audit', 'manual'].includes(type) ? type : 'manual';
}

function normalizeReleaseBlockerSeverity(value: unknown) {
  const severity = String(value ?? 'high').trim();
  return ['high', 'critical'].includes(severity) ? severity : 'high';
}

function normalizeReleaseBlockerStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['open', 'in_progress', 'resolved', 'waived'].includes(status) ? status : null;
}

function normalizeContentAuditType(value: unknown) {
  const type = String(value ?? 'structure').trim();
  return ['style', 'accuracy', 'structure', 'policy', 'source', 'search'].includes(type) ? type : null;
}

function normalizeContentAuditStatus(value: unknown) {
  const status = String(value ?? 'pending').trim();
  return ['pending', 'passed', 'needs_fix', 'failed'].includes(status) ? status : null;
}

function normalizeSecurityTestStatus(value: unknown) {
  const status = String(value ?? 'pending').trim();
  return ['pending', 'passed', 'failed'].includes(status) ? status : null;
}

function normalizeSignupMode(value: unknown) {
  const mode = String(value ?? 'open').trim();
  return ['closed', 'invite', 'open'].includes(mode) ? mode : null;
}

function normalizeServerListingMode(value: unknown) {
  const mode = String(value ?? 'verified_or_owner').trim();
  return ['verified_only', 'verified_or_owner', 'all'].includes(mode) ? mode : null;
}

function currentSqlDateTime() {
  return new Date().toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeAnnouncementType(value: unknown) {
  const type = String(value ?? 'notice').trim();
  return ['notice', 'maintenance', 'policy', 'release', 'incident', 'campaign'].includes(type) ? type : 'notice';
}

function normalizeAnnouncementVisibility(value: unknown) {
  const visibility = String(value ?? 'public').trim();
  return ['public', 'logged_in', 'staff'].includes(visibility) ? visibility : 'public';
}

function boundedReleaseVersion(value: unknown) {
  const version = boundedText(value, 32);
  return /^[A-Za-z0-9._:-]+$/.test(version) ? version : '';
}

function normalizeReleaseNoteType(value: unknown) {
  const type = String(value ?? 'feature').trim();
  return ['feature', 'fix', 'policy', 'security', 'content'].includes(type) ? type : 'feature';
}

function normalizeIncidentType(value: unknown) {
  const type = String(value ?? 'other').trim();
  return ['availability', 'search', 'permission', 'security', 'data', 'editor', 'server_claim', 'file', 'other'].includes(type) ? type : 'other';
}

function normalizeIncidentSeverity(value: unknown) {
  const severity = String(value ?? 'minor').trim();
  return ['minor', 'major', 'critical'].includes(severity) ? severity : 'minor';
}

function normalizeIncidentStatus(value: unknown) {
  const status = String(value ?? 'investigating').trim();
  return ['investigating', 'identified', 'resolved', 'postmortem'].includes(status) ? status : null;
}

function normalizePolicyVersionStatus(value: unknown) {
  const status = String(value ?? 'draft').trim();
  return ['draft', 'beta', 'active', 'deprecated'].includes(status) ? status : null;
}

function normalizeAllowDeny(value: unknown) {
  const result = String(value ?? '').trim();
  return ['allow', 'deny'].includes(result) ? result : null;
}

function normalizePermissionAuditStatus(value: unknown) {
  const status = String(value ?? 'pending').trim();
  return ['pending', 'passed', 'failed'].includes(status) ? status : null;
}

function normalizeSecurityReleaseCategory(value: unknown) {
  const category = String(value ?? 'other').trim();
  return ['xss', 'permission', 'csrf', 'file', 'auth', 'api', 'privacy', 'other'].includes(category) ? category : 'other';
}

function normalizeSecurityReleaseStatus(value: unknown) {
  const status = String(value ?? 'pending').trim();
  return ['pending', 'passed', 'failed', 'waived'].includes(status) ? status : null;
}

function normalizePerformanceTargetArea(value: unknown) {
  const area = String(value ?? 'page').trim();
  return ['page', 'search', 'recent_changes', 'category', 'server_list', 'mod_list', 'admin', 'edit', 'job'].includes(area) ? area : null;
}

function normalizePerformanceCheckStatus(value: unknown) {
  const status = String(value ?? 'pending').trim();
  return ['pending', 'passed', 'needs_work', 'failed'].includes(status) ? status : null;
}

function normalizeProjectBoardStatus(value: unknown) {
  const status = String(value ?? 'active').trim();
  return ['active', 'paused', 'done', 'archived'].includes(status) ? status : null;
}

function normalizeBoardItemStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['todo', 'doing', 'review', 'done', 'blocked'].includes(status) ? status : null;
}

function normalizeEditFilterType(value: unknown) {
  const filterType = String(value ?? 'keyword').trim();
  return ['regex', 'keyword', 'link_count', 'namespace_rule', 'component_rule'].includes(filterType) ? filterType : null;
}

function normalizeEditFilterAction(value: unknown) {
  const action = String(value ?? 'warn').trim();
  return ['warn', 'tag', 'block_save', 'require_review'].includes(action) ? action : null;
}

function normalizeAliasType(value: unknown) {
  const aliasType = String(value ?? 'alias').trim();
  return ['alias', 'redirect', 'typo', 'english', 'korean_alt', 'search'].includes(aliasType) ? aliasType : 'alias';
}

function normalizeSubwikiStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['pending', 'active', 'readonly', 'verification_expired', 'inactive', 'closed', 'needs_maintainer', 'outdated', 'merged', 'archived', 'hidden'].includes(status)
    ? status
    : null;
}

function normalizeMarkdownImportSourceType(value: unknown) {
  const sourceType = String(value ?? 'markdown').trim();
  return ['gitbook', 'markdown', 'manual'].includes(sourceType) ? sourceType : null;
}

function normalizeGitbookImportSourceType(value: unknown) {
  const sourceType = String(value ?? 'manual').trim();
  return ['manual', 'markdown_zip', 'notion_export', 'other'].includes(sourceType) ? sourceType : null;
}

function boundedJsonString(value: unknown, maxLength: number) {
  try {
    const json = JSON.stringify(value);
    return json.length <= maxLength ? json : null;
  } catch {
    return null;
  }
}

function markdownChecklistJson(value: unknown) {
  const items = Array.isArray(value)
    ? value.slice(0, 100).map((item) => boundedText(item, 255)).filter(Boolean)
    : [];
  return JSON.stringify(items);
}

function checklistLines(value: unknown) {
  return String(value ?? '')
    .split(/\r?\n/)
    .map((line) => boundedText(line, 255))
    .filter(Boolean)
    .slice(0, 100);
}

function importErrorLabel(value: unknown) {
  const labels: Record<string, string> = {
    import_documents_required: '가져올 문서가 없습니다. Markdown 본문이나 문서 묶음을 입력해 주세요.',
    import_too_many_documents: '문서 수가 제한을 넘었습니다.',
    import_document_too_large: '문서 하나의 크기가 제한을 넘었습니다.',
    import_archive_too_large: '전체 가져오기 데이터가 제한을 넘었습니다.',
    import_archive_too_many_entries: '압축 파일 안의 항목이 너무 많습니다.',
    import_filename_too_long: '파일 경로가 너무 깁니다.',
    import_field_too_large: '입력 필드가 너무 깁니다.'
  };
  const key = String(value ?? '');
  return labels[key] ?? (key ? `이전 실행 중 오류가 발생했습니다: ${key}` : '이전 실행 중 오류가 발생했습니다.');
}

async function addSubwikiSidebarItem(codeInput: unknown, body: any) {
  const code = boundedText(codeInput, 64);
  if (!code) return { ok: false, status: 400, error: 'invalid_code' } as const;
  const space = await one<any>(`SELECT id FROM wiki_spaces WHERE code=:code OR space_key=:code`, { code });
  if (!space) return { ok: false, status: 404, error: 'not_found' } as const;
  const label = boundedText(body.label, 120);
  if (!label) return { ok: false, status: 400, error: 'label_required' } as const;
  const targetUrl = normalizeSidebarTargetUrl(body.targetUrl);
  if (body.targetUrl && !targetUrl) return { ok: false, status: 400, error: 'invalid_target_url' } as const;
  const result = await exec(
    `INSERT INTO subwiki_sidebar_items (space_id, parent_id, label, target_title, target_url, sort_order, created_at, updated_at)
     VALUES (:spaceId, :parentId, :label, :targetTitle, :targetUrl, :sortOrder, NOW(), NOW())`,
    {
      spaceId: space.id,
      parentId: nullablePositiveInt(body.parentId) ?? null,
      label,
      targetTitle: boundedText(body.targetTitle, 255) || null,
      targetUrl,
      sortOrder: Number.isInteger(Number(body.sortOrder)) ? Number(body.sortOrder) : 0
    }
  );
  return { ok: true, id: result.insertId, spaceId: Number(space.id) } as const;
}

async function updateModCreatorVerification(slugInput: unknown, body: any, userId: number | null) {
  const slug = boundedText(slugInput, 64);
  if (!slug) return { ok: false, status: 400, error: 'invalid_slug' } as const;
  const verified = body.verified === false || body.verified === 'false' || body.verified === '0' ? 0 : 1;
  const result = await exec(
    `UPDATE mod_wikis
     SET creator_verified=:verified, verified_by=:verifiedBy, verified_at=IF(:verified=1, NOW(), NULL), updated_at=NOW()
     WHERE slug=:slug`,
    { slug, verified, verifiedBy: userId }
  );
  if (result.affectedRows === 0) return { ok: false, status: 404, error: 'not_found' } as const;
  return { ok: true, slug, creatorVerified: Boolean(verified) } as const;
}

async function updateSubwikiStatus(codeInput: unknown, body: any, userId: number | null) {
  const code = boundedText(codeInput, 64);
  if (!code) return { ok: false, status: 400, error: 'invalid_code' } as const;
  const space = await one<any>(`SELECT ${wikiSpaceFields} FROM wiki_spaces WHERE code=:code OR space_key=:code`, { code });
  if (!space) return { ok: false, status: 404, error: 'not_found' } as const;
  const statusValue = normalizeSubwikiStatus(body.status);
  if (!statusValue) return { ok: false, status: 400, error: 'invalid_status' } as const;
  const reason = boundedText(body.reason, 1000) || null;
  await exec(`UPDATE wiki_spaces SET status=:status, updated_at=NOW() WHERE id=:id`, { id: space.id, status: statusValue });
  await exec(
    `INSERT INTO subwiki_lifecycle_logs (space_id, old_status, new_status, reason, changed_by, created_at)
     VALUES (:spaceId, :oldStatus, :newStatus, :reason, :userId, NOW())`,
    { spaceId: space.id, oldStatus: space.status, newStatus: statusValue, reason, userId }
  );
  return { ok: true, spaceId: Number(space.id), statusValue } as const;
}

async function updateServerStatusAction(user: any, pageId: number | null | undefined, body: any) {
  if (!can(user, 'server.official_edit') && !can(user, 'report.handle')) throw actionError(403, 'forbidden', '서버 상태 관리 권한이 필요합니다.');
  if (!pageId) throw actionError(400, 'invalid_page_id', '서버 문서 번호가 올바르지 않습니다.');
  const page = await getPageById(pageId);
  if (!page || String(page.namespace_code ?? '') !== 'server' || String(page.status ?? '') === 'deleted') throw actionError(404, 'server_not_found', '서버 문서를 찾을 수 없습니다.');
  const operationalStatus = normalizeServerOperationalStatus(body.operationalStatus);
  if (body.operationalStatus && !operationalStatus) throw actionError(400, 'invalid_operational_status', '운영 상태를 확인해 주세요.');
  const verifiedStatus = normalizeServerVerifiedStatus(body.verifiedStatus);
  if (body.verifiedStatus && !verifiedStatus) throw actionError(400, 'invalid_verified_status', '인증 상태를 확인해 주세요.');
  await exec(
    `UPDATE entity_servers
     SET operational_status=COALESCE(:operationalStatus, operational_status),
         verified_status=COALESCE(:verifiedStatus, verified_status),
         updated_at=NOW()
     WHERE page_id=:pageId`,
    { pageId, operationalStatus, verifiedStatus }
  );
  if (verifiedStatus) await syncServerWikiVerifiedStatus(pageId, verifiedStatus);
  if (operationalStatus === 'disputed') {
    await exec(
      `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, status, created_at, updated_at)
       VALUES ('server_dispute', 'server', :pageId, 'high', 'open', NOW(), NOW())`,
      { pageId }
    );
  }
  await logAdmin(user?.id ?? null, 'server.status.update', 'server', pageId, { operationalStatus, verifiedStatus, note: boundedText(body.note, 500) || null });
  return { ok: true, pageId, operationalStatus, verifiedStatus };
}

function subwikiErrorLabel(value: unknown) {
  const labels: Record<string, string> = {
    server_slug_required: '서버 슬러그를 입력해 주세요.',
    mod_slug_required: '모드 슬러그는 영문, 숫자, 점, 밑줄, 하이픈 2-64자로 입력해 주세요.',
    invalid_code: '위키 코드를 확인해 주세요.',
    invalid_slug: '모드 슬러그를 확인해 주세요.',
    invalid_status: '상태 값을 확인해 주세요.',
    label_required: '사이드바 라벨을 입력해 주세요.',
    invalid_target_url: '사이드바 외부 링크는 안전한 http 또는 https 주소여야 합니다.',
    not_found: '대상 위키를 찾을 수 없습니다.'
  };
  const key = String(value ?? '');
  return labels[key] ?? (key ? `처리 중 오류가 발생했습니다: ${key}` : '처리 중 오류가 발생했습니다.');
}

async function activeUserIdOrNull(value: unknown) {
  if (value === undefined || value === null || value === '') return null;
  const userId = nullablePositiveInt(value);
  if (!userId) return null;
  const user = await one<any>(`SELECT id FROM users WHERE id=:userId AND status='active'`, { userId });
  return user ? userId : null;
}

async function readablePageByIdForRequest(request: any, pageId: number) {
  const page = await getPageById(pageId);
  return page && await canReadPageResource(aclActorForRequest(request), page) ? page : null;
}

async function contributorTaskExists(taskId: number) {
  return Boolean(await one<any>(`SELECT id FROM contributor_tasks WHERE id=:taskId`, { taskId }));
}

async function contributorTaskRow(taskId: number) {
  return one<any>(
    `SELECT ${contributorTaskSelectFields}
     FROM contributor_tasks ct
     LEFT JOIN pages target_page ON target_page.id=ct.target_id AND ct.target_type IN ('page','server','mod')
     LEFT JOIN namespaces target_namespace ON target_namespace.id=target_page.namespace_id
     WHERE ct.id=:taskId`,
    { taskId }
  );
}

async function userDashboardStats(userId: number) {
  return one<any>(
    `SELECT
       (SELECT COUNT(*) FROM watched_pages WHERE user_id=:userId) AS watch_count,
       (SELECT COUNT(*) FROM contributor_tasks WHERE assigned_to=:userId AND status IN ('open','assigned')) AS assigned_task_count,
       (SELECT COUNT(*) FROM contributor_tasks WHERE assigned_to IS NULL AND status='open') AS recommended_task_count,
       (SELECT COUNT(*) FROM contributor_tasks WHERE assigned_to=:userId AND status='done') AS completed_task_count,
       (SELECT COUNT(*) FROM page_revisions WHERE created_by=:userId) AS edit_count`,
    { userId }
  );
}

async function filterRecentRowsForActor(actor: any, rows: any[]) {
  const readableIds = await readablePageIdSet(actor, rows.map((row) => nullablePositiveInt(row.page_id) ?? 0));
  return rows.filter((row) => readableIds.has(Number(row.page_id)));
}

async function projectBoardExists(boardId: number) {
  return Boolean(await one<any>(`SELECT id FROM project_boards WHERE id=:boardId`, { boardId }));
}

async function wikiSpaceExists(spaceId: number) {
  return Boolean(await one<any>(`SELECT id FROM wiki_spaces WHERE id=:spaceId`, { spaceId }));
}

async function contributorTaskTargetForRequest(request: any, targetTypeInput: unknown, targetIdInput: unknown): Promise<
  | { ok: true; targetType: string; targetId: number | null }
  | { ok: false; statusCode: number; error: string }
> {
  const targetType = normalizeContributorTaskTargetType(targetTypeInput);
  if (!targetType) return { ok: false, statusCode: 400, error: 'invalid_target_type' };
  if (targetType === 'none') return { ok: true, targetType, targetId: null };
  const targetId = nullablePositiveInt(targetIdInput);
  if (['page', 'server', 'mod'].includes(targetType)) {
    if (!targetId) return { ok: false, statusCode: 400, error: 'target_required' };
    if (!(await readablePageByIdForRequest(request, targetId))) return { ok: false, statusCode: 404, error: 'target_not_found' };
    return { ok: true, targetType, targetId };
  }
  if (targetType === 'revision') {
    if (!targetId) return { ok: false, statusCode: 400, error: 'target_required' };
    const revision = await pageRevisionById(targetId, canViewRestrictedRevisions((request as any).user), canViewSuppressedRevisions((request as any).user));
    if (!revision) return { ok: false, statusCode: 404, error: 'target_not_found' };
    const page = await getPageById(Number(revision.page_id));
    if (!(await canReadPageResource(aclActorForRequest(request), page)) || !(await aclDecision(aclActorForRequest(request), 'history', page)).allowed) {
      return { ok: false, statusCode: 404, error: 'target_not_found' };
    }
    return { ok: true, targetType, targetId };
  }
  if (targetType === 'file') {
    if (!targetId) return { ok: false, statusCode: 400, error: 'target_required' };
    const file = await one<any>(`SELECT id FROM files WHERE id=:targetId AND status IN ('normal','license_needed')`, { targetId });
    if (!file) return { ok: false, statusCode: 404, error: 'target_not_found' };
    return { ok: true, targetType, targetId };
  }
  return { ok: true, targetType, targetId };
}

async function filterContributorTasksForActor(actor: any, rows: any[]) {
  const pageTargetIds = rows
    .filter((row) => ['page', 'server', 'mod'].includes(String(row.target_type ?? '')))
    .map((row) => nullablePositiveInt(row.target_id) ?? 0);
  const readablePageIds = await readablePageIdSet(actor, pageTargetIds);
  const revisionIds = rows
    .filter((row) => String(row.target_type ?? '') === 'revision')
    .map((row) => nullablePositiveInt(row.target_id) ?? 0)
    .filter((id) => id > 0);
  const readableRevisionIds = new Set<number>();
  if (revisionIds.length > 0) {
    const revisions = await query<any>(
      `SELECT r.id, p.id AS page_id, p.space_id, p.protection_level, p.status, p.title, n.code AS namespace_code
       FROM revisions r
       JOIN pages p ON p.id=r.page_id
       JOIN namespaces n ON n.id=p.namespace_id
       WHERE r.id IN (:revisionIds)`,
      { revisionIds }
    );
    for (const revision of revisions) {
      if (await canReadPageResource(actor, revision) && (await aclDecision(actor, 'history', revision)).allowed) {
        readableRevisionIds.add(Number(revision.id));
      }
    }
  }
  return rows.filter((row) => {
    const targetType = String(row.target_type ?? '');
    if (['page', 'server', 'mod'].includes(targetType)) return readablePageIds.has(Number(row.target_id));
    if (targetType === 'revision') return readableRevisionIds.has(Number(row.target_id));
    return true;
  });
}

async function adminActionPage(request: any, reply: any, action: string) {
  const pageId = nullablePositiveInt((request.params as any).id);
  if (!pageId) {
    reply.code(400).send({ error: 'invalid_page_id' });
    return null;
  }
  const page = await getPageById(pageId);
  if (!page) {
    reply.code(404).send({ error: 'not_found' });
    return null;
  }
  if (!(await aclDecision(aclActorForRequest(request), action, page)).allowed) {
    reply.code(403).send({ error: 'acl_denied' });
    return null;
  }
  return page;
}

async function protectPageAction(user: any, pageId: number | null | undefined, body: any) {
  if (!can(user, 'page.protect')) throw actionError(403, 'forbidden', '문서 보호 권한이 필요합니다.');
  if (!pageId) throw actionError(400, 'invalid_page_id', '문서 번호가 올바르지 않습니다.');
  const page = await getPageById(pageId);
  if (!page) throw actionError(404, 'not_found', '문서를 찾을 수 없습니다.');
  if (!(await aclDecision(user, 'acl', page)).allowed) throw actionError(403, 'acl_denied', '이 문서의 보호 설정을 바꿀 권한이 없습니다.');
  const level = normalizePageProtectionLevel(body.level ?? body.protectionLevel ?? 'trusted_only');
  if (!level) throw actionError(400, 'invalid_protection_level', '보호 수준을 확인해 주세요.');
  await protectPage(pageId, level, user?.id ?? null);
  await logAdmin(user?.id ?? null, 'page.protect', 'page', pageId, {
    namespace: page.namespace_code,
    title: page.title,
    level,
    reason: boundedText(body.reason, 255) || null
  });
  return { ok: true, pageId, href: wikiUrl(page.namespace_code, page.title), level };
}

async function deletePageAction(user: any, pageId: number | null | undefined, body: any, requireConfirmation = false) {
  if (!can(user, 'page.delete')) throw actionError(403, 'forbidden', '문서 삭제 권한이 필요합니다.');
  if (!pageId) throw actionError(400, 'invalid_page_id', '문서 번호가 올바르지 않습니다.');
  const page = await getPageById(pageId);
  if (!page) throw actionError(404, 'not_found', '문서를 찾을 수 없습니다.');
  if (!(await aclDecision(user, 'delete', page)).allowed) throw actionError(403, 'acl_denied', '이 문서를 삭제할 권한이 없습니다.');
  const expected = normalizeTitle(page.display_title ?? page.title);
  const confirmed = normalizeTitle(body.confirmTitle ?? body.confirm ?? '');
  if (requireConfirmation && expected && confirmed !== expected) throw actionError(400, 'delete_confirmation_required', '삭제하려면 문서 제목을 정확히 입력해 주세요.');
  await deletePage(pageId, user?.id ?? null);
  await logAdmin(user?.id ?? null, 'page.delete', 'page', pageId, {
    namespace: page.namespace_code,
    title: page.title,
    reason: boundedText(body.reason, 255) || null
  });
  return { ok: true, pageId, href: `${wikiUrl(page.namespace_code, page.title)}/history` };
}

function normalizeEditableNamespace(value: unknown): NamespaceCode | null {
  const namespace = String(value ?? '').trim();
  return ['main', 'mod', 'modpack', 'server', 'dev', 'guide', 'data', 'help', 'project', 'template', 'file'].includes(namespace)
    ? (namespace as NamespaceCode)
    : null;
}

function publicPageResource(page: any) {
  const namespace = String(page?.namespace_code ?? 'main') as NamespaceCode;
  return {
    id: Number(page.id),
    namespace,
    namespaceName: page.namespace_name ?? null,
    title: page.title,
    displayTitle: page.display_title ?? page.title,
    slug: page.slug,
    url: wikiUrl(namespace, String(page.title ?? '')),
    pageType: page.page_type,
    status: page.status,
    protectionLevel: page.protection_level,
    currentRevisionId: page.current_revision_id ? Number(page.current_revision_id) : null,
    createdAt: page.created_at,
    updatedAt: page.updated_at,
    html: page.html ?? '',
    toc: safeJsonArray(page.toc_json),
    links: safeJsonArray(page.links_json),
    categories: safeJsonArray(page.categories_json),
    components: safeJsonArray(page.components_json),
    missingLinks: safeJsonArray(page.missing_links_json)
  };
}

function safeJsonArray(value: unknown) {
  if (!value) return [];
  if (Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeJobType(value: unknown) {
  const jobType = String(value ?? '').trim();
  return ['render_page', 'reindex_page', 'rebuild_links', 'rebuild_categories', 'check_file_usage', 'check_mod_links', 'check_server_status', 'run_consistency_check'].includes(jobType)
    ? jobType
    : null;
}

function normalizeJobPayload(jobType: string, value: unknown) {
  const payload = value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  if (['render_page', 'reindex_page', 'rebuild_links', 'rebuild_categories'].includes(jobType)) {
    return { pageId: nullablePositiveInt(payload.pageId) ?? 0 };
  }
  if (jobType === 'check_file_usage') {
    return { pageId: nullablePositiveInt(payload.pageId) ?? null };
  }
  if (jobType === 'check_server_status') {
    return {
      pageId: nullablePositiveInt(payload.pageId) ?? null,
      limit: boundedPositiveInt(payload.limit, 100) ?? 100
    };
  }
  if (jobType === 'run_consistency_check') {
    return { autoFix: Boolean(payload.autoFix) };
  }
  return {};
}

function normalizeRunAfter(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  const maxFuture = Date.now() + 1000 * 60 * 60 * 24 * 30;
  if (date.getTime() > maxFuture) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

async function canRecordSearchClick(pageId: number, user: any) {
  const page = await getPageById(pageId);
  return canReadPageResource(user, page);
}

async function readableSearchRows(user: any, rows: any[]) {
  const ids = [...new Set(rows.map((row) => Number(row.page_id ?? row.id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return [];
  const pages = await query<any>(
    `SELECT p.id, p.space_id, p.protection_level, p.status, p.title, n.code AS namespace_code
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE p.id IN (:ids)`,
    { ids }
  );
  const byId = new Map(pages.map((page) => [Number(page.id), page]));
  const readableIds = new Set<number>();
  for (const page of pages) {
    if (await canReadPageResource(user, page)) readableIds.add(Number(page.id));
  }
  return rows.filter((row) => {
    const id = Number(row.page_id ?? row.id);
    return readableIds.has(id) && byId.has(id);
  });
}

async function readablePageIdSet(user: any, pageIds: number[]) {
  const ids = [...new Set(pageIds.filter((id) => Number.isFinite(id) && id > 0))];
  if (ids.length === 0) return new Set<number>();
  const pages = await query<any>(
    `SELECT p.id, p.space_id, p.protection_level, p.status, p.title, n.code AS namespace_code
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE p.id IN (:ids)`,
    { ids }
  );
  const readableIds = new Set<number>();
  for (const page of pages) {
    if (await canReadPageResource(user, page)) readableIds.add(Number(page.id));
  }
  return readableIds;
}

async function filterRowsByReadablePage(user: any, rows: any[], pageIdKey = 'id') {
  const readableIds = await readablePageIdSet(user, rows.map((row) => Number(row?.[pageIdKey])));
  return rows.filter((row) => readableIds.has(Number(row?.[pageIdKey])));
}

async function withReadableDocCounts(user: any, rows: any[]) {
  const spaceIds = [...new Set(rows.map((row) => Number(row.space_id)).filter((id) => Number.isFinite(id) && id > 0))];
  if (spaceIds.length === 0) return rows;
  const pages = await query<any>(
    `SELECT p.id, p.space_id, p.protection_level, p.status, p.title, n.code AS namespace_code
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE p.space_id IN (:spaceIds) AND p.status NOT IN ('deleted','hidden')`,
    { spaceIds }
  );
  const counts = new Map<number, number>();
  for (const page of pages) {
    if (!(await canReadPageResource(user, page))) continue;
    const spaceId = Number(page.space_id);
    counts.set(spaceId, (counts.get(spaceId) ?? 0) + 1);
  }
  return rows.map((row) => ({ ...row, doc_count: counts.get(Number(row.space_id)) ?? 0 }));
}

async function resolveSearchQueryForActor(q: string, user: any) {
  const resolved = await resolveSearchQuery(q);
  const candidates = await readableSearchRows(user, Array.isArray(resolved.candidates) ? resolved.candidates : []);
  if (candidates.length === 1) {
    const candidate = candidates[0];
    return {
      action: 'redirect',
      target: wikiUrl(candidate.namespace_code, candidate.title),
      reason: resolved.reason,
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

function normalizeFeedbackStatus(value: unknown) {
  const status = String(value ?? 'open');
  return ['open', 'reviewing', 'done', 'wontfix'].includes(status) ? status : 'open';
}

function normalizeCampaignType(value: unknown) {
  const type = String(value ?? 'vanilla').trim();
  return ['vanilla', 'mod', 'server', 'guide', 'policy', 'search', 'cleanup'].includes(type) ? type : 'vanilla';
}

function normalizeCampaignStatus(value: unknown) {
  const status = String(value ?? 'draft').trim();
  return ['draft', 'active', 'paused', 'completed', 'archived'].includes(status) ? status : 'draft';
}

function normalizeCampaignPageStatus(value: unknown) {
  const status = String(value ?? '').trim();
  if (!status) return 'needed';
  return ['needed', 'drafting', 'review', 'done', 'skipped'].includes(status) ? status : null;
}

function normalizeDateTimeInput(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const date = new Date(text);
  if (!Number.isFinite(date.getTime())) return null;
  return date.toISOString().slice(0, 19).replace('T', ' ');
}

function normalizeDateInput(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return null;
  const date = new Date(`${text}T00:00:00Z`);
  if (!Number.isFinite(date.getTime())) return null;
  return text;
}

function safeLocalRedirect(value: unknown) {
  const redirectTo = String(value ?? '/');
  return redirectTo.startsWith('/') && !redirectTo.startsWith('//') && !/[\u0000-\u001f\u007f]/.test(redirectTo) ? encodeURI(redirectTo) : '/';
}

function matchesSearchSpace(row: any, requested: string) {
  const space = String(requested ?? '').trim();
  if (!space) return true;
  return row.namespace_code === space || row.space_code === space || String(row.space_id ?? '') === space;
}

async function updateAdminWorkItem(workId: number, body: any, actorId: number | null) {
  if (!workId) return { ok: false, error: 'invalid_work_id' };
  const status = body.status === undefined || body.status === '' ? null : normalizeAdminWorkStatus(body.status);
  const priority = body.priority === undefined || body.priority === '' ? null : normalizeAdminWorkPriority(body.priority);
  if ((body.status !== undefined && body.status !== '' && !status) || (body.priority !== undefined && body.priority !== '' && !priority)) {
    return { ok: false, error: 'invalid_work_update' };
  }
  const hasAssignedTo = Object.prototype.hasOwnProperty.call(body, 'assignedTo');
  const assignedTo = body.assignedTo === '' || body.assignedTo === undefined ? null : nullablePositiveInt(body.assignedTo);
  if (hasAssignedTo && body.assignedTo !== '' && body.assignedTo !== undefined && !assignedTo) return { ok: false, error: 'invalid_assignee' };
  const result = await exec(
    `UPDATE admin_work_items
     SET status=COALESCE(:status,status),
         priority=COALESCE(:priority,priority),
         assigned_to=IF(:hasAssignedTo, :assignedTo, assigned_to),
         updated_at=NOW()
     WHERE id=:id`,
    { id: workId, status, priority, hasAssignedTo, assignedTo }
  );
  if (Number(result.affectedRows ?? 0) === 0) return { ok: false, error: 'not_found' };
  await logAdmin(actorId, 'admin_work.update', 'admin_work_item', workId, { status, priority, assignedTo: hasAssignedTo ? assignedTo : undefined });
  return { ok: true };
}

function normalizeAdminWorkStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['open', 'in_progress', 'done', 'dismissed'].includes(status) ? status : null;
}

function normalizeAdminWorkPriority(value: unknown) {
  const priority = String(value ?? '').trim();
  return ['low', 'normal', 'high', 'urgent'].includes(priority) ? priority : null;
}

async function pendingReviewDetail(reviewId: number) {
  const review = await one<any>(
    `SELECT pr.id, pr.review_type, pr.target_id, pr.page_id, pr.submitted_by, pr.status, pr.reason, pr.payload_json, pr.reviewed_by, pr.reviewed_at, pr.created_at,
            u.username AS submitted_username, u.display_name AS submitted_display_name
     FROM pending_reviews pr
     LEFT JOIN users u ON u.id=pr.submitted_by
     WHERE pr.id=:reviewId`,
    { reviewId }
  );
  if (!review) return null;
  const draft = await one<any>(`SELECT ${pendingReviewDraftFields} FROM pending_review_drafts WHERE review_id=:reviewId`, { reviewId });
  const current = draft
    ? await one<any>(
        `SELECT p.id, p.title, p.current_revision_id, pr.content_raw
         FROM pages p
         JOIN namespaces n ON n.id=p.namespace_id
         LEFT JOIN page_revisions pr ON pr.id=p.current_revision_id
         WHERE n.code=:namespaceCode AND p.title=:title AND p.status!='deleted'`,
        { namespaceCode: draft.namespace_code, title: draft.title }
      )
    : null;
  return { ...review, draft, current };
}

async function approveModLinkReview(review: any, actorId: number | null) {
  const pageId = Number(review.page_id ?? 0);
  if (!pageId) throw new Error('page_required');
  const payload = parseJsonObject(review.payload_json);
  const nextOfficialLinks = Object.prototype.hasOwnProperty.call(payload, 'newOfficialLinks')
    ? stringOrNull(payload.newOfficialLinks)
    : null;
  await exec(
    `UPDATE entity_mods
     SET official_links=:officialLinks, last_checked=NOW(), updated_at=NOW()
     WHERE page_id=:pageId`,
    { pageId, officialLinks: nextOfficialLinks }
  );
  await exec(`DELETE FROM mod_links WHERE page_id=:pageId AND link_type='official'`, { pageId });
  for (const link of parseModLinkRows(null, nextOfficialLinks).filter((row) => row.linkType === 'official')) {
    await exec(
      `INSERT INTO mod_links (page_id, link_type, url, status, checked_at, created_at)
       VALUES (:pageId, :linkType, :url, :status, NOW(), NOW())`,
      { pageId, ...link }
    );
  }
  await refreshModQualityStatus(pageId, actorId);
  await exec(
    `INSERT INTO recent_changes (page_id, actor_id, change_type, title, namespace_code, summary, created_at)
     SELECT p.id, :actorId, 'edit', p.title, n.code, '공식 모드 링크 검토 승인', NOW()
     FROM pages p JOIN namespaces n ON n.id=p.namespace_id WHERE p.id=:pageId`,
    { pageId, actorId }
  );
  await logAdmin(actorId, 'mod_link_review.approve', 'page', pageId, {
    reviewId: Number(review.id),
    oldOfficialLinks: payload.oldOfficialLinks ?? null,
    newOfficialLinks: nextOfficialLinks
  });
}

function normalizeReviewStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['approved', 'rejected', 'needs_changes'].includes(status) ? status : null;
}

function appliedPage(result: SavePageResult) {
  if (result.pending) throw new Error('page_requires_review');
  return result;
}

async function completeContributorTask(taskId: number, actorId: number | null) {
  const task = await one<any>(`SELECT id, task_type, target_type, target_id, title FROM contributor_tasks WHERE id=:taskId`, { taskId });
  if (!task || task.target_type !== 'page' || !task.target_id) return;
  const issueTypeClause = taskIssueTypeClause(task.task_type);
  if (!issueTypeClause) return;
  await exec(
    `UPDATE page_quality_issues
     SET status='resolved', resolved_at=NOW()
     WHERE page_id=:pageId AND status='open' AND issue_type IN (${issueTypeClause})`,
    { pageId: task.target_id }
  );
  await exec(
    `INSERT INTO recent_changes (page_id, actor_id, change_type, title, namespace_code, summary, created_at)
     SELECT p.id, :actorId, 'edit', p.title, n.code, :summary, NOW()
     FROM pages p JOIN namespaces n ON n.id=p.namespace_id WHERE p.id=:pageId`,
    { pageId: task.target_id, actorId, summary: `기여자 작업 완료: ${task.title}`.slice(0, 255) }
  );
}

function taskIssueTypeClause(taskType: string) {
  const map: Record<string, string> = {
    improve_stub: "'stub','missing_status','missing_infobox','no_internal_links','needs_source','outdated'",
    fix_broken_link: "'broken_link'",
    add_category: "'missing_category'",
    verify_mod: "'mod_missing_check_date'",
    verify_server: "'server_missing_address'",
    policy_review: "'disputed'"
  };
  return map[taskType] ?? '';
}

function normalizeServerOwnerRole(value: unknown) {
  const role = String(value ?? '').trim();
  return ['owner', 'manager', 'editor'].includes(role) ? role : null;
}

function normalizeServerOwnerStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['active', 'pending', 'revoked'].includes(status) ? status : null;
}

async function grantServerOwner(pageId: number, userId: number, role: string, status: string, actorId: number | null) {
  await exec(
    `INSERT INTO server_owners (page_id, user_id, role, status, granted_by, granted_at)
     VALUES (:pageId, :userId, :role, :status, :actorId, NOW())
     ON DUPLICATE KEY UPDATE role=VALUES(role), status=VALUES(status), granted_by=VALUES(granted_by), granted_at=NOW(), revoked_at=NULL, revoked_by=NULL`,
    { pageId, userId, role, status, actorId }
  );
  await syncServerOwnerSubwikiRole(pageId, userId, role, status, actorId);
}

async function syncServerWikiVerifiedStatus(pageId: number, verifiedStatus: string) {
  const wikiStatus = verifiedStatus === 'verified' ? 'verified' : verifiedStatus === 'revoked' ? 'revoked' : 'pending';
  await exec(
    `UPDATE server_wikis sw
     JOIN wiki_spaces ws ON ws.id=sw.space_id
     SET sw.verified_status=:wikiStatus, sw.updated_at=NOW()
     WHERE ws.root_page_id=:pageId AND ws.space_type='server_wiki'`,
    { pageId, wikiStatus }
  );
}

async function syncServerEndpointFromEntity(pageId: number) {
  const server = await one<any>(`SELECT host, edition, status_enabled FROM entity_servers WHERE page_id=:pageId`, { pageId });
  const host = String(server?.host ?? '').trim();
  const enabled = Number(server?.status_enabled ?? 0) === 1 && Boolean(host);
  if (!enabled) {
    await exec(`UPDATE server_endpoints SET enabled=0, updated_at=NOW() WHERE page_id=:pageId`, { pageId });
    return;
  }
  await exec(
    `INSERT INTO server_endpoints (page_id, host, port, edition, enabled, created_at, updated_at)
     VALUES (:pageId, :host, 25565, :edition, 1, NOW(), NOW())
     ON DUPLICATE KEY UPDATE host=VALUES(host), edition=VALUES(edition), enabled=1, updated_at=NOW()`,
    { pageId, host, edition: String(server.edition ?? '') === 'bedrock' ? 'bedrock' : 'java' }
  );
}

async function markServerPageVerified(pageId: number, actorId: number | null) {
  const page = await getPageById(pageId);
  if (!page || page.namespace_code !== 'server') return;
  const current = String(page.content_raw ?? '');
  let next = current.replace(/\|인증\s*=\s*(?:미인증|인증 없음|검토 중|대기|pending|none)[^\n]*/i, '|인증=운영자 인증');
  next = next.replace(/\[\[분류:인증 대기 서버\]\]/g, '[[분류:인증 서버]]');
  if (next === current) return;
  await savePage({
    namespace: 'server',
    title: page.title,
    content: next,
    summary: '서버 운영자 인증 반영',
    userId: actorId,
    pageType: page.page_type ?? 'server',
    skipReview: true,
    isMinor: true,
    editTags: ['server-verified']
  });
}

async function syncServerOwnerSubwikiRole(pageId: number, userId: number, role: string, status: string, actorId: number | null) {
  await exec(
    `UPDATE subwiki_roles sr
     JOIN wiki_spaces ws ON ws.id=sr.space_id
     SET sr.status='revoked', sr.revoked_at=NOW(), sr.revoked_by=:actorId
     WHERE ws.root_page_id=:pageId AND ws.space_type='server_wiki' AND sr.user_id=:userId AND sr.status='active'`,
    { pageId, userId, actorId }
  );
  if (status !== 'active') return;
  const subwikiRole = ['owner', 'manager', 'editor'].includes(role) ? role : 'editor';
  await exec(
    `INSERT INTO subwiki_roles (space_id, user_id, role, status, granted_by, granted_at)
     SELECT ws.id, :userId, :role, 'active', :actorId, NOW()
     FROM wiki_spaces ws
     WHERE ws.root_page_id=:pageId AND ws.space_type='server_wiki'
     ON DUPLICATE KEY UPDATE status='active', granted_by=VALUES(granted_by), granted_at=NOW(), revoked_at=NULL, revoked_by=NULL`,
    { pageId, userId, role: subwikiRole, actorId }
  );
}

function normalizeServerOperationalStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['active', 'checking_failed', 'inactive', 'closed', 'disputed', 'unverified'].includes(status) ? status : null;
}

function normalizeServerVerifiedStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['none', 'pending', 'verified', 'revoked'].includes(status) ? status : null;
}

async function officialAreaMap(components: Array<{ name: string; props: Record<string, string> }>) {
  const targets = [
    ...new Set(
      components
        .filter((component) => component.name === 'official_area')
        .map((component) => component.props['문서'])
        .filter(Boolean)
    )
  ];
  const entries = [];
  for (const target of targets) {
    const parsed = parseLinkTarget(target);
    if (parsed.namespace !== 'server') continue;
    const rootTitle = parsed.title.split('/')[0];
    const targetPage = await getPageByTitle('server', parsed.title);
    const rootPage = await getPageByTitle('server', rootTitle);
    const claim = rootPage
      ? await one<any>(
          `SELECT
             CASE
               WHEN status='verified' AND renewal_required_at IS NOT NULL AND renewal_required_at <= NOW() THEN 'renewal_required'
               WHEN status='verified' THEN 'verified'
               ELSE status
             END AS verification_status,
             renewal_required_at
           FROM server_claims
           WHERE page_id=:pageId AND status IN ('verified','expired','revoked')
           ORDER BY FIELD(status, 'verified', 'expired', 'revoked'), COALESCE(last_verified_at, verified_at, updated_at) DESC
           LIMIT 1`,
          { pageId: rootPage.id }
        )
      : null;
    entries.push([
      target,
      {
        status: claim?.verification_status ?? 'unverified',
        lastModifiedAt: targetPage?.updated_at ?? null,
        renewalRequiredAt: claim?.renewal_required_at ?? null
      }
    ]);
  }
  return Object.fromEntries(entries);
}

function normalizeUploadFileName(fileName: string) {
  const base = path.basename(fileName).replace(/\s+/g, ' ').trim();
  const safe = base.replace(/[<>:"|?*\\\/]/g, '_').slice(0, 180);
  return safe || `file-${Date.now()}`;
}

function normalizeOriginalFileName(fileName: string) {
  const base = path.basename(fileName).replace(/[\u0000-\u001f\u007f]+/g, '').replace(/\s+/g, ' ').trim();
  return (base || 'uploaded-file').slice(0, 255);
}

function detectImageUpload(bytes: Buffer) {
  if (bytes.length < 12) return null;
  if (bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { mimeType: 'image/png', ext: '.png' };
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return { mimeType: 'image/jpeg', ext: '.jpg' };
  }
  const gifHeader = bytes.subarray(0, 6).toString('ascii');
  if (gifHeader === 'GIF87a' || gifHeader === 'GIF89a') {
    return { mimeType: 'image/gif', ext: '.gif' };
  }
  if (bytes.subarray(0, 4).toString('ascii') === 'RIFF' && bytes.subarray(8, 12).toString('ascii') === 'WEBP') {
    return { mimeType: 'image/webp', ext: '.webp' };
  }
  return null;
}

async function uploadFileAction(request: any) {
  const user = request.user;
  if (!(await canUploadFile(aclActorForRequest(request)))) {
    return { ok: false as const, status: 403, code: 'forbidden', message: '파일 업로드 권한이 없습니다. 로그인 상태와 문서 권한을 확인하세요.' };
  }
  if (!consumeRateLimit(request, 'file-upload:ip', 30, 60 * 60 * 1000, user?.id ? `user:${user.id}` : 'anon')) {
    return { ok: false as const, status: 429, code: 'rate_limited', message: '파일 업로드 요청이 너무 많습니다. 잠시 뒤 다시 시도하세요.' };
  }
  const file = await request.file();
  if (!file) return { ok: false as const, status: 400, code: 'file_required', message: '업로드할 파일을 선택하세요.' };
  if (!/^image\/(png|jpeg|webp|gif)$/.test(file.mimetype)) {
    return { ok: false as const, status: 400, code: 'unsupported_mime', message: 'PNG, JPEG, WebP, GIF 이미지만 업로드할 수 있습니다.' };
  }
  const bytes = await file.toBuffer();
  const imageType = detectImageUpload(bytes);
  if (!imageType || imageType.mimeType !== file.mimetype) {
    return { ok: false as const, status: 400, code: 'invalid_image_content', message: '파일 확장자와 실제 이미지 형식이 일치하지 않습니다.' };
  }
  const sha256 = crypto.createHash('sha256').update(bytes).digest('hex');
  const fileName = normalizeUploadFileName(file.filename);
  const originalName = normalizeOriginalFileName(file.filename);
  const storageKey = `${sha256.slice(0, 2)}/${sha256}${imageType.ext}`;
  const fields = (file as any).fields ?? {};
  const existingName = await one<any>(`SELECT id, file_name, storage_key, sha256, status FROM files WHERE file_name=:fileName AND status!='deleted'`, { fileName });
  if (existingName && !['normal', 'license_needed'].includes(String(existingName.status))) {
    return { ok: false as const, status: 409, code: 'file_restricted', message: '같은 이름의 제한된 파일이 이미 있습니다.', fileName };
  }
  if (existingName && existingName.sha256 !== sha256) {
    return { ok: false as const, status: 409, code: 'file_name_exists', message: '같은 이름의 다른 파일이 이미 있습니다. 파일명을 바꿔 업로드하세요.', fileName };
  }
  if (existingName) {
    return { ok: true as const, id: existingName.id, fileName, storageKey: existingName.storage_key, url: `${config.cdnPublicUrl}/${existingName.storage_key}` };
  }
  const existingHash = await one<any>(`SELECT id, file_name, storage_key, status FROM files WHERE sha256=:sha256`, { sha256 });
  if (existingHash && !['normal', 'license_needed', 'deleted'].includes(String(existingHash.status))) {
    return { ok: false as const, status: 409, code: 'file_restricted', message: '같은 내용의 제한된 파일이 이미 있습니다.' };
  }
  const target = path.join(config.cdnRoot, 'mwiki', storageKey);
  await fs.mkdir(path.dirname(target), { recursive: true });
  await fs.writeFile(target, bytes, { flag: 'wx' }).catch(async (error: any) => {
    if (error.code !== 'EEXIST') throw error;
  });
  const license = multipartField(fields.license);
  const sourceUrl = normalizeOptionalHttpUrl(multipartField(fields.sourceUrl));
  const sourceText = multipartField(fields.sourceText);
  const fileStatus = license ? 'normal' : 'license_needed';
  if (existingHash?.status === 'deleted') {
    await exec(
      `UPDATE files
       SET original_name=:originalName, file_name=:fileName, storage_key=:storageKey, mime_type=:mimeType, size_bytes=:sizeBytes,
           license=:license, source_url=:sourceUrl, source_text=:sourceText, status=:status
      WHERE id=:id`,
      {
        id: existingHash.id,
        originalName,
        fileName,
        storageKey: `mwiki/${storageKey}`,
        mimeType: file.mimetype,
        sizeBytes: bytes.length,
        license,
        sourceUrl,
        sourceText,
        status: fileStatus
      }
    );
    if (fileStatus === 'license_needed') await enqueueFileLicenseWork(existingHash.id);
    return { ok: true as const, id: existingHash.id, fileName, storageKey: `mwiki/${storageKey}`, url: `${config.cdnPublicUrl}/mwiki/${storageKey}` };
  }
  if (existingHash) {
    return { ok: true as const, id: existingHash.id, fileName: existingHash.file_name, storageKey: existingHash.storage_key, url: `${config.cdnPublicUrl}/${existingHash.storage_key}` };
  }
  const result = await exec(
    `INSERT INTO files (uploader_id, original_name, file_name, storage_key, mime_type, size_bytes, sha256, license, source_url, source_text, status, created_at)
     VALUES (:userId, :originalName, :fileName, :storageKey, :mimeType, :sizeBytes, :sha256, :license, :sourceUrl, :sourceText, :status, NOW())`,
    {
      userId: user?.id ?? null,
      originalName,
      fileName,
      storageKey: `mwiki/${storageKey}`,
      mimeType: file.mimetype,
      sizeBytes: bytes.length,
      sha256,
      license,
      sourceUrl,
      sourceText,
      status: fileStatus
    }
  );
  if (fileStatus === 'license_needed') await enqueueFileLicenseWork(result.insertId);
  return { ok: true as const, id: result.insertId, fileName, storageKey: `mwiki/${storageKey}`, url: `${config.cdnPublicUrl}/mwiki/${storageKey}` };
}

function multipartField(field: any) {
  const value = Array.isArray(field) ? field[0]?.value : field?.value ?? field;
  const text = String(value ?? '').trim();
  return text ? text.slice(0, 500) : null;
}

async function watchedPages(user: any) {
  const rows = await query<any>(
    `SELECT p.id, p.space_id, p.protection_level, p.status, p.title, n.code AS namespace_code, wp.watch_discussion, wp.created_at
     FROM watched_pages wp
     JOIN pages p ON p.id=wp.page_id
     JOIN namespaces n ON n.id=p.namespace_id
     WHERE wp.user_id=:userId AND p.status!='deleted'
     ORDER BY wp.created_at DESC`,
    { userId: user.id }
  );
  const visibleRows = [];
  for (const row of rows) {
    if (await canReadPageResource(user, row)) visibleRows.push(row);
  }
  return visibleRows;
}

async function watchedRecentChanges(user: any, limit = 50) {
  const rows = await query<any>(
    `SELECT rc.id, rc.page_id, rc.revision_id, rc.change_type, rc.title, rc.namespace_code, rc.summary, rc.created_at,
            p.id AS resource_page_id, p.space_id, p.protection_level, p.status
     FROM watched_pages wp
     JOIN recent_changes rc ON rc.page_id=wp.page_id
     JOIN pages p ON p.id=rc.page_id
     WHERE wp.user_id=:userId AND (rc.change_type!='discussion' OR wp.watch_discussion=1)
     ORDER BY rc.created_at DESC
     LIMIT :limit`,
    { userId: user.id, limit: Math.max(1, Math.min(200, Number(limit) || 50)) }
  );
  const visibleRows = [];
  for (const row of rows) {
    if (await canReadPageResource(user, {
      id: row.resource_page_id,
      space_id: row.space_id,
      protection_level: row.protection_level,
      status: row.status,
      namespace_code: row.namespace_code,
      title: row.title
    })) {
      const { resource_page_id, space_id, protection_level, status, ...change } = row;
      visibleRows.push(change);
    }
  }
  return visibleRows;
}

function recentChangeFilters(query: any, privileged = false) {
  const includeManagement = privileged && query.includeManagement === '1';
  const includeDeleted = privileged && query.includeDeleted === '1';
  const includeSystem = privileged && query.includeSystem === '1';
  return {
    namespace: query.namespace ? String(query.namespace) : undefined,
    type: query.type ? String(query.type) : undefined,
    actorId: privileged && query.actorId && /^\d+$/.test(String(query.actorId)) ? Number(query.actorId) : undefined,
    prefix: query.prefix ? String(query.prefix).trim() : undefined,
    contentOnly: privileged ? query.contentOnly !== '0' : true,
    publicOnly: !includeManagement && !includeDeleted,
    includeManagement,
    includeDeleted,
    includeSystem
  };
}

async function recentActorIdFromQuery(query: any, privileged = false) {
  if (!privileged) return undefined;
  const actor = String(query.actor ?? query.actorId ?? '').trim();
  if (!actor) return undefined;
  if (/^\d+$/.test(actor)) return Number(actor);
  const user = await userByIdentifier(actor);
  return user?.id ? Number(user.id) : -1;
}

function missingDocumentPage(namespace: NamespaceCode, title: string, user: any, queryParams: Record<string, unknown> = {}) {
  const editParams = new URLSearchParams();
  const requestedType = String(queryParams.type ?? '').trim();
  const requestedTemplate = String(queryParams.template ?? '').trim();
  if (requestedType && requestedType !== documentTypeForNamespace(namespace)) editParams.set('type', requestedType);
  if (requestedTemplate) editParams.set('template', requestedTemplate);
  if (String(queryParams.blank ?? '') === '1') editParams.set('blank', '1');
  const suffix = editParams.toString() ? `?${editParams.toString()}` : '';
  return messagePage('문서 없음', '아직 작성되지 않은 문서입니다. 같은 주제의 문서를 먼저 검색하거나 새 문서로 작성할 수 있습니다.', user, {
    tone: 'error',
    actionHref: `${wikiUrl(namespace, title)}/edit${suffix}`,
    actionLabel: '새 문서 만들기',
    secondaryHref: `/search?q=${encodeURIComponent(title)}`,
    secondaryLabel: '검색',
    currentSpace: namespace
  });
}

function revisionHistoryFilterTag(query: any, user: any) {
  const tag = String(query?.tag ?? '').trim();
  const allowed = new Set(['edit', 'rollback', 'review', 'official']);
  if (user) {
    allowed.add('operation');
    allowed.add('hidden');
  }
  return allowed.has(tag) ? tag : '';
}

function revisionHistoryTokens(revision: any, isCurrent: boolean) {
  const summary = String(revision.edit_summary ?? '');
  const tokens = new Set<string>();
  if (isCurrent) tokens.add('current');
  if (revision.is_minor) tokens.add('minor');
  if (revision.visibility && revision.visibility !== 'public') tokens.add('hidden');
  if (/되돌|rollback/i.test(summary)) tokens.add('rollback');
  if (/검토|review|pending/i.test(summary)) tokens.add('review');
  if (/공식|운영자|official/i.test(summary)) tokens.add('official');
  if (/운영|관리|권한|보호|삭제|숨김|operation|admin|acl|protect|delete|hide/i.test(summary)) tokens.add('operation');
  for (const item of safeJsonArray(revision.edit_tags)) {
    const value = String(item).trim();
    tokens.add(value);
    if (/되돌|rollback/i.test(value)) tokens.add('rollback');
    if (/검토|review|pending/i.test(value)) tokens.add('review');
    if (/공식|운영자|official/i.test(value)) tokens.add('official');
    if (/운영|관리|권한|보호|삭제|숨김|operation|admin|acl|protect|delete|hide/i.test(value)) tokens.add('operation');
  }
  const hasSpecificPublicTag = ['rollback', 'review', 'official', 'hidden', 'operation'].some((token) => tokens.has(token));
  if (!hasSpecificPublicTag) tokens.add('edit');
  return tokens;
}

function filterRevisionHistory(revisions: any[], tag: string, user: any) {
  if (!tag) return revisions;
  if ((tag === 'hidden' || tag === 'operation') && !user) return revisions;
  return revisions.filter((revision, index) => revisionHistoryTokens(revision, index === 0).has(tag));
}

async function generateModVerificationTasks(actorId: number | null) {
  const tasks = [
    {
      type: 'version_check',
      sql: `SELECT p.id AS page_id
            FROM pages p
            JOIN namespaces n ON n.id=p.namespace_id
            LEFT JOIN entity_mods em ON em.page_id=p.id
            LEFT JOIN mod_versions mv ON mv.page_id=p.id
            WHERE n.code='mod' AND p.status!='deleted'
              AND (em.last_checked IS NULL OR em.last_checked < DATE_SUB(CURDATE(), INTERVAL 90 DAY)
                   OR em.supported_versions IS NULL OR em.supported_versions IN ('', '문서 참조')
                   OR mv.checked_at IS NULL OR mv.checked_at < DATE_SUB(CURDATE(), INTERVAL 90 DAY))
            GROUP BY p.id`
    },
    {
      type: 'link_check',
      sql: `SELECT p.id AS page_id
            FROM pages p
            JOIN namespaces n ON n.id=p.namespace_id
            LEFT JOIN mod_links ml ON ml.page_id=p.id
            WHERE n.code='mod' AND p.status!='deleted'
            GROUP BY p.id
            HAVING SUM(ml.id IS NOT NULL)=0 OR SUM(ml.status IN ('unknown','broken')) > 0`
    },
    {
      type: 'dependency_check',
      sql: `SELECT p.id AS page_id
            FROM pages p
            JOIN namespaces n ON n.id=p.namespace_id
            LEFT JOIN mod_dependencies md ON md.page_id=p.id
            LEFT JOIN entity_mods em ON em.page_id=p.id
            WHERE n.code='mod' AND p.status!='deleted'
            GROUP BY p.id, em.dependencies
            HAVING SUM(md.id IS NOT NULL)=0 AND (em.dependencies IS NULL OR em.dependencies IN ('', '문서 참조', '알 수 없음'))`
    },
    {
      type: 'loader_check',
      sql: `SELECT p.id AS page_id
            FROM pages p
            JOIN namespaces n ON n.id=p.namespace_id
            LEFT JOIN entity_mods em ON em.page_id=p.id
            WHERE n.code='mod' AND p.status!='deleted' AND (em.loaders IS NULL OR em.loaders='' OR em.loaders='문서 참조')`
    }
  ];
  let created = 0;
  for (const task of tasks) {
    const pages = await query<any>(task.sql);
    for (const page of pages) {
      const result = await exec(
        `INSERT INTO mod_verification_tasks (page_id, task_type, status, assigned_to, note, due_at, created_at, updated_at)
         SELECT :pageId, :taskType, 'open', NULL, :note, DATE_ADD(NOW(), INTERVAL 14 DAY), NOW(), NOW()
         WHERE NOT EXISTS (
           SELECT 1 FROM mod_verification_tasks
           WHERE page_id=:pageId AND task_type=:taskType AND status IN ('open','in_progress')
         )`,
        { pageId: page.page_id, taskType: task.type, note: '자동 생성' }
      );
      created += Number(result.affectedRows ?? 0);
      if (Number(result.affectedRows ?? 0) > 0) await refreshModQualityStatus(Number(page.page_id), actorId);
    }
  }
  await logAdmin(actorId, 'mod_verification.generate', 'system', null, { created });
  return { ok: true, created };
}

async function modVerificationTasks() {
  return query<any>(
    `SELECT mvt.id, mvt.page_id, mvt.task_type, mvt.status, mvt.assigned_to, mvt.note, mvt.due_at, mvt.completed_at, mvt.created_at, mvt.updated_at,
            p.title, u.username AS assigned_username, u.display_name AS assigned_display_name
     FROM mod_verification_tasks mvt
     JOIN pages p ON p.id=mvt.page_id
     LEFT JOIN users u ON u.id=mvt.assigned_to
     ORDER BY FIELD(mvt.status,'open','in_progress','done','skipped'), mvt.due_at IS NULL, mvt.due_at, mvt.id DESC
     LIMIT 200`
  );
}

async function updateModVerificationTask(taskId: number, body: any, actorId: number | null) {
  if (!taskId) return { ok: false, error: 'invalid_task_id' };
  const status = body.status === undefined || body.status === '' ? null : normalizeModTaskStatus(body.status);
  if (body.status && !status) return { ok: false, error: 'invalid_status' };
  const assignedTo = nullablePositiveInt(body.assignedTo);
  if (Object.prototype.hasOwnProperty.call(body, 'assignedTo') && body.assignedTo !== '' && body.assignedTo !== undefined && !assignedTo) {
    return { ok: false, error: 'invalid_assignee' };
  }
  const dueAt = body.dueAt === undefined || body.dueAt === '' ? null : normalizeDateTimeInput(body.dueAt);
  if (body.dueAt && !dueAt) return { ok: false, error: 'invalid_due_at' };
  const result = await exec(
    `UPDATE mod_verification_tasks
     SET status=COALESCE(:status,status),
         assigned_to=IF(:hasAssignedTo, :assignedTo, assigned_to),
         note=COALESCE(:note,note),
         due_at=COALESCE(:dueAt,due_at),
         completed_at=IF(:isDone, NOW(), completed_at),
         updated_at=NOW()
     WHERE id=:id`,
    {
      id: taskId,
      status: status ?? null,
      hasAssignedTo: Object.prototype.hasOwnProperty.call(body, 'assignedTo'),
      assignedTo,
      note: boundedText(body.note, 255) || null,
      dueAt,
      isDone: status === 'done'
    }
  );
  if (Number(result.affectedRows ?? 0) === 0) return { ok: false, error: 'not_found' };
  if (status === 'done') await completeModVerificationTask(taskId, actorId, body);
  return { ok: true, status: status ?? body.status ?? null };
}

async function completeModVerificationTask(taskId: number, actorId: number | null, body: any) {
  const task = await one<any>(`SELECT ${modVerificationTaskFields} FROM mod_verification_tasks WHERE id=:taskId`, { taskId });
  if (!task) return;
  const note = String(body?.note ?? '').trim() || null;
  await applyModVerificationPayload(Number(task.page_id), body, actorId);
  if (task.task_type === 'version_check' || task.task_type === 'loader_check') {
    await exec(`UPDATE mod_versions SET checked_at=NOW(), checked_by=:actorId WHERE page_id=:pageId`, { pageId: task.page_id, actorId });
    await exec(`UPDATE entity_mods SET last_checked=NOW(), updated_at=NOW() WHERE page_id=:pageId`, { pageId: task.page_id });
  }
  if (task.task_type === 'link_check') {
    await exec(`UPDATE mod_links SET checked_at=NOW() WHERE page_id=:pageId`, { pageId: task.page_id });
  }
  await refreshModQualityStatus(Number(task.page_id), actorId);
  await exec(
    `INSERT INTO recent_changes (page_id, actor_id, change_type, title, namespace_code, summary, created_at)
     SELECT p.id, :actorId, 'edit', p.title, n.code, :summary, NOW()
     FROM pages p JOIN namespaces n ON n.id=p.namespace_id WHERE p.id=:pageId`,
    { pageId: task.page_id, actorId, summary: `모드 검증 완료: ${task.task_type}${note ? ` - ${note}` : ''}`.slice(0, 255) }
  );
  await logAdmin(actorId, 'mod_verification.complete', 'page', Number(task.page_id), { taskId, taskType: task.task_type, note });
}

async function applyModVerificationPayload(pageId: number, body: any, actorId: number | null) {
  const supportedVersions = stringOrNull(body?.supportedVersions);
  const loaders = stringOrNull(body?.loaders);
  const officialLinks = stringOrNull(body?.officialLinks);
  const dependencies = stringOrNull(body?.dependencies);
  const license = stringOrNull(body?.license);
  if (supportedVersions || loaders || officialLinks || dependencies || license) {
    await exec(
      `UPDATE entity_mods
       SET supported_versions=COALESCE(:supportedVersions, supported_versions),
           loaders=COALESCE(:loaders, loaders),
           official_links=COALESCE(:officialLinks, official_links),
           dependencies=COALESCE(:dependencies, dependencies),
           license=COALESCE(:license, license),
           last_checked=NOW(),
           updated_at=NOW()
       WHERE page_id=:pageId`,
      { pageId, supportedVersions, loaders, officialLinks, dependencies, license }
    );
  }
  for (const version of parseModVersionRows(body?.modVersions, supportedVersions, loaders)) {
    await exec(
      `INSERT INTO mod_versions (page_id, minecraft_version, loader, support_status, note, checked_at, checked_by)
       VALUES (:pageId, :minecraftVersion, :loader, :supportStatus, :note, NOW(), :actorId)`,
      { pageId, actorId, ...version }
    );
  }
  for (const link of parseModLinkRows(body?.modLinks, officialLinks)) {
    await exec(
      `INSERT INTO mod_links (page_id, link_type, url, status, checked_at, created_at)
       VALUES (:pageId, :linkType, :url, :status, NOW(), NOW())`,
      { pageId, ...link }
    );
  }
  for (const dependency of parseDependencyRows(body?.dependencyRows, dependencies)) {
    await exec(
      `INSERT INTO mod_dependencies (page_id, dependency_name, required_type, note)
       VALUES (:pageId, :dependencyName, :requiredType, :note)`,
      { pageId, ...dependency }
    );
  }
}

function parseModVersionRows(raw: unknown, versions: string | null, loaders: string | null) {
  const rows = String(raw ?? '')
    .split(/\r?\n/)
    .map((line) => line.split(',').map((part) => part.trim()))
    .filter((parts) => parts[0]);
  if (rows.length === 0 && versions) {
    const loader = normalizeLoader((loaders ?? '').split(',')[0]);
    return versions.split(',').map((version) => ({
      minecraftVersion: version.trim(),
      loader,
      supportStatus: 'supported',
      note: null
    })).filter((row) => row.minecraftVersion);
  }
  return rows.map(([minecraftVersion, loader, supportStatus, note]) => ({
    minecraftVersion,
    loader: normalizeLoader(loader),
    supportStatus: ['supported', 'partial', 'unsupported', 'unknown'].includes(supportStatus) ? supportStatus : 'unknown',
    note: note || null
  }));
}

function parseModLinkRows(raw: unknown, officialLinks: string | null) {
  const text = String(raw ?? officialLinks ?? '').trim();
  return text
    .split(/\r?\n|,/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [typeMaybe, urlMaybe, statusMaybe] = line.split('|').map((part) => part.trim());
      const url = urlMaybe && /^https?:\/\//.test(urlMaybe) ? urlMaybe : typeMaybe;
      const type = urlMaybe && !/^https?:\/\//.test(typeMaybe) ? typeMaybe : inferModLinkType(url);
      return {
        linkType: normalizeModLinkType(type),
        url,
        status: ['active', 'broken', 'unknown'].includes(statusMaybe) ? statusMaybe : 'active'
      };
    })
    .filter((row) => /^https?:\/\//.test(row.url));
}

function parseDependencyRows(raw: unknown, dependencies: string | null) {
  return String(raw ?? dependencies ?? '')
    .split(/\r?\n|,/)
    .map((line) => line.split('|').map((part) => part.trim()))
    .filter((parts) => parts[0])
    .map(([dependencyName, requiredType, note]) => ({
      dependencyName,
      requiredType: ['required', 'optional', 'incompatible', 'recommended'].includes(requiredType) ? requiredType : 'required',
      note: note || null
    }));
}

function normalizeLoader(value: unknown) {
  const loader = String(value ?? '').trim().toLowerCase();
  return ['forge', 'fabric', 'quilt', 'neoforge'].includes(loader) ? loader : 'unknown';
}

function normalizeModLinkType(value: unknown) {
  const type = String(value ?? '').trim().toLowerCase();
  return ['official', 'modrinth', 'curseforge', 'github', 'wiki', 'discord', 'other'].includes(type) ? type : 'other';
}

function inferModLinkType(url: string) {
  if (/modrinth\.com/i.test(url)) return 'modrinth';
  if (/curseforge\.com/i.test(url)) return 'curseforge';
  if (/github\.com/i.test(url)) return 'github';
  if (/discord\./i.test(url)) return 'discord';
  return 'official';
}

function stringOrNull(value: unknown) {
  const text = String(value ?? '').trim();
  return text || null;
}

async function refreshModQualityStatus(pageId: number, actorId: number | null) {
  const row = await one<any>(
    `SELECT
       (SELECT COUNT(*) FROM mod_verification_tasks WHERE page_id=:pageId AND status IN ('open','in_progress')) AS active_tasks,
       (SELECT COUNT(*) FROM mod_links WHERE page_id=:pageId AND status='broken') AS broken_links,
       em.last_checked
     FROM entity_mods em
     WHERE em.page_id=:pageId`,
    { pageId }
  );
  if (!row) return;
  const activeTasks = Number(row.active_tasks ?? 0);
  const brokenLinks = Number(row.broken_links ?? 0);
  const status = brokenLinks > 0 ? 'partial_old' : activeTasks > 0 || !row.last_checked ? 'needs_check' : 'normal';
  const reason =
    brokenLinks > 0
      ? `깨진 모드 링크 ${brokenLinks}개`
      : activeTasks > 0
        ? `모드 검증 작업 ${activeTasks}개 남음`
        : row.last_checked
          ? '모드 검증 완료'
          : '모드 확인일 없음';
  await exec(
    `REPLACE INTO page_quality_status (page_id, status, reason, checked_version, checked_at, checked_by, updated_at)
     VALUES (:pageId, :status, :reason, NULL, NOW(), :actorId, NOW())`,
    { pageId, status, reason, actorId }
  );
  if (status === 'normal') {
    await exec(
      `UPDATE page_quality_issues
       SET status='resolved', resolved_at=NOW()
       WHERE page_id=:pageId AND status='open' AND issue_type='mod_missing_check_date'`,
      { pageId }
    );
  }
}

function normalizeModTaskStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['open', 'in_progress', 'done', 'skipped'].includes(status) ? status : null;
}

async function logRecentDiscussion(page: any, actorId: number | null, summary: string) {
  await exec(
    `INSERT INTO recent_changes (page_id, actor_id, change_type, title, namespace_code, summary, created_at)
     VALUES (:pageId, :actorId, 'discussion', :title, :namespaceCode, :summary, NOW())`,
    { pageId: page.id ?? page.page_id, actorId, title: page.title ?? '', namespaceCode: page.namespace_code ?? 'main', summary: summary.slice(0, 255) }
  );
}

function normalizeReportStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['reviewing', 'resolved', 'rejected'].includes(status) ? status : null;
}

async function resolveReportAction(user: any, reportId: number | null | undefined, body: any) {
  if (!can(user, 'report.handle')) throw actionError(403, 'forbidden', '신고 처리 권한이 필요합니다.');
  if (!reportId) throw actionError(400, 'invalid_report_id', '신고 번호가 올바르지 않습니다.');
  const report = await one<any>(`SELECT id, target_type, target_id, status FROM reports WHERE id=:id`, { id: reportId });
  if (!report) throw actionError(404, 'report_not_found', '신고를 찾을 수 없습니다.');
  const status = normalizeReportStatus(body?.status ?? body?.action ?? 'resolved');
  if (!status) throw actionError(400, 'invalid_report_status', '처리 상태를 확인해 주세요.');
  const note = boundedText(body?.note ?? body?.reason, 500) || null;
  await exec(
    `UPDATE reports
     SET status=:status,
         handled_by=:userId,
         handled_at=NOW(),
         resolved_by=IF(:isFinal, :userId, resolved_by),
         resolved_at=IF(:isFinal, NOW(), resolved_at)
     WHERE id=:id`,
    { id: reportId, status, userId: user?.id ?? null, isFinal: status === 'resolved' || status === 'rejected' }
  );
  await exec(
    `UPDATE admin_work_items
     SET status=IF(:isFinal, 'done', 'in_progress'), assigned_to=:userId, updated_at=NOW()
     WHERE work_type='report' AND target_type='report' AND target_id=:id`,
    { id: reportId, userId: user?.id ?? null, isFinal: status === 'resolved' || status === 'rejected' }
  );
  await logAdmin(user?.id ?? null, `report.${status}`, 'report', reportId, {
    previousStatus: report.status,
    targetType: report.target_type,
    targetId: report.target_id,
    note
  });
  return { ok: true, status };
}

async function qualityListForActor(kind: string, actor: any) {
  if (kind === 'broken-links' || kind === 'needed-pages') {
    const rows = await query<any>(
      `SELECT pl.from_page_id, p.space_id, p.protection_level, p.status, p.title AS source_title, sn.code AS source_namespace_code,
              pl.target_title, tn.code AS namespace_code
       FROM page_links pl
       JOIN pages p ON p.id=pl.from_page_id
       JOIN namespaces sn ON sn.id=p.namespace_id
       JOIN namespaces tn ON tn.id=pl.target_namespace_id
       WHERE pl.link_type='missing' AND p.status NOT IN ('deleted','hidden')
       LIMIT 1000`
    );
    const counts = new Map<string, { namespace_code: string; target_title: string; link_count: number }>();
    for (const row of rows) {
      const page = {
        id: row.from_page_id,
        space_id: row.space_id,
        protection_level: row.protection_level,
        status: row.status,
        namespace_code: row.source_namespace_code,
        title: row.source_title
      };
      if (!(await canReadPageResource(actor, page))) continue;
      const key = `${row.namespace_code}:${row.target_title}`;
      const current = counts.get(key) ?? { namespace_code: row.namespace_code, target_title: row.target_title, link_count: 0 };
      current.link_count += 1;
      counts.set(key, current);
    }
    return [...counts.values()]
      .sort((a, b) => b.link_count - a.link_count || a.target_title.localeCompare(b.target_title))
      .slice(0, 100)
      .map((row) => kind === 'broken-links' ? { namespace_code: row.namespace_code, target_title: row.target_title, count: row.link_count } : row);
  }
  const rows = await qualityList(kind);
  const readableIds = await readablePageIdSet(actor, rows.map((row) => nullablePositiveInt(row.id ?? row.page_id ?? row.target_page_id) ?? 0));
  return rows.filter((row) => {
    const pageId = nullablePositiveInt(row.id ?? row.page_id ?? row.target_page_id);
    return !pageId || readableIds.has(pageId);
  });
}

async function reportTargetForRequest(request: any, body: any): Promise<
  | { ok: true; targetType: string; targetId: number | null; pageId: number | null }
  | { ok: false; statusCode: number; error: string }
> {
  const requestedType = boundedText(body.targetType, 40) || (body.pageId || body.targetId ? 'page' : 'general');
  const targetType = ['page', 'revision', 'file', 'discussion', 'user', 'general'].includes(requestedType) ? requestedType : 'general';
  const targetId = nullablePositiveInt(body.targetId ?? body.pageId);
  const pageId = nullablePositiveInt(body.pageId) ?? (targetType === 'page' ? targetId : null);
  const actor = aclActorForRequest(request);
  if (targetType === 'page') {
    if (!pageId) return { ok: false, statusCode: 400, error: 'page_required' };
    const page = await getPageById(pageId);
    if (!(await canReadPageResource(actor, page))) return { ok: false, statusCode: 404, error: 'target_not_found' };
    return { ok: true, targetType, targetId: Number(page.id), pageId: Number(page.id) };
  }
  if (targetType === 'revision') {
    if (!targetId) return { ok: false, statusCode: 400, error: 'revision_required' };
    const revision = await pageRevisionById(targetId, canViewRestrictedRevisions((request as any).user), canViewSuppressedRevisions((request as any).user));
    if (!revision) return { ok: false, statusCode: 404, error: 'target_not_found' };
    const page = await getPageById(Number(revision.page_id));
    if (!(await canReadPageResource(actor, page)) || !(await aclDecision(actor, 'history', page)).allowed) {
      return { ok: false, statusCode: 404, error: 'target_not_found' };
    }
    return { ok: true, targetType, targetId, pageId: Number(revision.page_id) };
  }
  if (targetType === 'file') {
    if (!targetId) return { ok: false, statusCode: 400, error: 'file_required' };
    const file = await one<any>(`SELECT id FROM files WHERE id=:id AND status IN ('normal','license_needed')`, { id: targetId });
    if (!file) return { ok: false, statusCode: 404, error: 'target_not_found' };
    return { ok: true, targetType, targetId, pageId: null };
  }
  if (targetType === 'discussion') {
    if (!targetId) return { ok: false, statusCode: 400, error: 'discussion_required' };
    const thread = await one<any>(`SELECT id, page_id FROM discussion_threads WHERE id=:id AND status!='hidden'`, { id: targetId });
    if (!thread) return { ok: false, statusCode: 404, error: 'target_not_found' };
    const page = await getPageById(Number(thread.page_id));
    if (!(await canReadPageResource(actor, page))) return { ok: false, statusCode: 404, error: 'target_not_found' };
    return { ok: true, targetType, targetId, pageId: Number(thread.page_id) };
  }
  if (targetType === 'user') {
    if (!targetId) return { ok: false, statusCode: 400, error: 'user_required' };
    const targetUser = await one<any>(`SELECT id FROM users WHERE id=:id AND status!='deleted'`, { id: targetId });
    if (!targetUser) return { ok: false, statusCode: 404, error: 'target_not_found' };
    return { ok: true, targetType, targetId: Number(targetUser.id), pageId: null };
  }
  return { ok: true, targetType, targetId, pageId };
}

function normalizeDiscussionStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['open', 'resolved', 'locked', 'hidden'].includes(status) ? status : null;
}

function discussionTabStatus(value: unknown) {
  const status = String(value ?? 'open').trim();
  if (status === 'closed' || status === 'close') return 'resolved';
  return ['open', 'resolved', 'locked', 'new'].includes(status) ? status : 'open';
}

function discussionStatusHref(status: unknown) {
  const tab = discussionTabStatus(status);
  return tab === 'resolved' ? 'closed' : tab;
}

async function serverVerification(pageId: number) {
  const claim = await one<any>(
    `SELECT status, method, verified_at, last_verified_at, renewal_required_at, expires_at,
       CASE
         WHEN status='verified' AND renewal_required_at IS NOT NULL AND renewal_required_at <= NOW() THEN 'renewal_required'
         WHEN status='verified' THEN 'verified'
         ELSE status
       END AS verification_status
     FROM server_claims
     WHERE page_id=:pageId AND status IN ('verified','expired','revoked')
     ORDER BY FIELD(status, 'verified', 'expired', 'revoked'), COALESCE(last_verified_at, verified_at, updated_at) DESC
     LIMIT 1`,
    { pageId }
  );
  return claim
    ? {
        status: claim.verification_status,
        method: claim.method,
        verifiedAt: claim.verified_at,
        lastVerifiedAt: claim.last_verified_at,
        renewalRequiredAt: claim.renewal_required_at,
        expiresAt: claim.expires_at
      }
    : { status: 'unverified' };
}

async function myServerRows(user: any) {
  const isAdmin = can(user, 'server.official_edit') || can(user, 'report.handle') ? 1 : 0;
  return query<any>(
    `SELECT ws.id AS space_id, ws.slug, ws.title, ws.name, ws.root_page_id, es.host, es.edition, es.operational_status, es.status_enabled,
       claim.verification_status, claim.renewal_required_at, claim.expires_at,
       TIMESTAMPDIFF(DAY, NOW(), claim.renewal_required_at) AS renewal_days_left,
       COALESCE(doc_stats.doc_count, 0) AS doc_count,
       doc_stats.last_edit_at,
       COALESCE(review_stats.pending_review_count, 0) AS pending_review_count,
       COALESCE(role_stats.owner_count, 0) AS owner_count,
       ping.checked_at AS last_ping_at,
       ping.online AS last_ping_online,
       ping.players_online AS last_ping_players_online,
       ping.players_max AS last_ping_players_max,
       ping.version_name AS last_ping_version
     FROM wiki_spaces ws
     JOIN pages root ON root.id=ws.root_page_id
     LEFT JOIN entity_servers es ON es.page_id=ws.root_page_id
     LEFT JOIN (
       SELECT page_id,
              MAX(renewal_required_at) AS renewal_required_at,
              MAX(expires_at) AS expires_at,
              CASE
                WHEN SUM(status='verified' AND renewal_required_at IS NOT NULL AND renewal_required_at <= NOW()) > 0 THEN 'renewal_required'
                WHEN SUM(status='verified') > 0 THEN 'verified'
                WHEN SUM(status='expired') > 0 THEN 'expired'
                WHEN SUM(status='revoked') > 0 THEN 'revoked'
                ELSE 'unverified'
              END AS verification_status
       FROM server_claims
       WHERE status IN ('verified','expired','revoked')
       GROUP BY page_id
     ) claim ON claim.page_id=ws.root_page_id
     LEFT JOIN (
       SELECT ws2.id AS space_id, COUNT(p.id) AS doc_count, MAX(rc.created_at) AS last_edit_at
       FROM wiki_spaces ws2
       JOIN pages p ON p.title=ws2.slug OR p.title LIKE CONCAT(ws2.slug, '/%')
       JOIN namespaces n ON n.id=p.namespace_id AND n.code='server'
       LEFT JOIN recent_changes rc ON rc.page_id=p.id
       WHERE ws2.space_type='server_wiki' AND p.status!='deleted'
       GROUP BY ws2.id
     ) doc_stats ON doc_stats.space_id=ws.id
     LEFT JOIN (
       SELECT ws3.id AS space_id, COUNT(pr.id) AS pending_review_count
       FROM wiki_spaces ws3
       JOIN pages p ON p.title=ws3.slug OR p.title LIKE CONCAT(ws3.slug, '/%')
       JOIN namespaces n ON n.id=p.namespace_id AND n.code='server'
       JOIN pending_reviews pr ON pr.page_id=p.id AND pr.status='pending'
       WHERE ws3.space_type='server_wiki'
       GROUP BY ws3.id
     ) review_stats ON review_stats.space_id=ws.id
     LEFT JOIN (
       SELECT owned.space_id, COUNT(DISTINCT owned.user_id) AS owner_count
       FROM (
         SELECT space_id, user_id FROM subwiki_roles WHERE status='active' AND role IN ('owner','manager','editor')
         UNION
         SELECT ws4.id AS space_id, so.user_id
         FROM server_owners so
         JOIN wiki_spaces ws4 ON ws4.root_page_id=so.page_id
         WHERE so.status='active'
       ) owned
       GROUP BY owned.space_id
     ) role_stats ON role_stats.space_id=ws.id
     LEFT JOIN (
       SELECT ep.page_id, pl.checked_at, pl.online, pl.players_online, pl.players_max, pl.version_name
       FROM server_endpoints ep
       JOIN server_ping_logs pl ON pl.endpoint_id=ep.id
       JOIN (
         SELECT ep2.page_id, MAX(pl2.checked_at) AS latest_checked_at
         FROM server_endpoints ep2
         JOIN server_ping_logs pl2 ON pl2.endpoint_id=ep2.id
         GROUP BY ep2.page_id
       ) latest ON latest.page_id=ep.page_id AND latest.latest_checked_at=pl.checked_at
     ) ping ON ping.page_id=ws.root_page_id
     WHERE ws.space_type='server_wiki'
       AND (:isAdmin=1
         OR EXISTS (SELECT 1 FROM subwiki_roles sr WHERE sr.space_id=ws.id AND sr.user_id=:userId AND sr.status='active' AND sr.role IN ('owner','manager','editor'))
         OR EXISTS (SELECT 1 FROM server_owners so WHERE so.page_id=ws.root_page_id AND so.user_id=:userId AND so.status='active'))
     ORDER BY claim.verification_status='renewal_required' DESC, claim.renewal_required_at IS NULL, claim.renewal_required_at, ws.title`,
    { userId: user.id, isAdmin }
  );
}

async function canEditPageResource(user: any, page: any) {
  if (!page) return false;
  return (await aclDecision(user, 'edit', page)).allowed;
}

async function pageEditAccess(user: any, page: any) {
  if (!page) return { allowed: true, forceReviewReason: null as string | null };
  if ((await aclDecision(user, 'edit', page)).allowed) return { allowed: true, forceReviewReason: null };
  if ((await aclDecision(user, 'edit_request', page)).allowed) {
    const level = String(page.protection_level ?? 'open');
    if (!user || user.anonymous) return { allowed: true, forceReviewReason: '비로그인 편집 검토' };
    if (level === 'official_only' || level === 'owner_only' || ['server', 'mod'].includes(String(page.namespace_code ?? ''))) return { allowed: true, forceReviewReason: '공식 영역 편집 검토 필요' };
    if (level === 'review_required') return { allowed: true, forceReviewReason: '문서 보호 정책: 검토 후 반영' };
    return { allowed: true, forceReviewReason: 'ACL: 편집 요청 필요' };
  }
  return { allowed: false, forceReviewReason: null };
}

function editPolicyNotice(page: any, namespace: NamespaceCode, title: string, user: any) {
  const level = String(page?.protection_level ?? (namespace === 'main' && normalizeTitle(title) === '대문' ? 'review_required' : 'open'));
  if (namespace === 'main' && isUserWikiTitle(title)) {
    return '사용자 문서는 본인과 관리자만 수정할 수 있으며 문서 제목은 변경할 수 없습니다.';
  }
  if (!user) return level === 'open'
    ? '비로그인 편집은 Turnstile 확인 후 저장되며 운영자 검토를 거쳐 반영됩니다.'
    : '이 문서는 로그인 후 편집할 수 있습니다.';
  if (level === 'review_required') return '이 문서의 편집은 검토 후 공개됩니다.';
  if (level === 'autoconfirmed_only' && !user.groups?.some((group: string) => ['autoconfirmed', 'trusted', 'moderator', 'admin', 'developer'].includes(group))) {
    return '자동 인증 전 사용자의 편집은 검토 대기 목록으로 이동합니다.';
  }
  if (level === 'official_only' || level === 'owner_only' || (['server', 'mod'].includes(namespace) && normalizeTitle(title).includes('/'))) {
    return '이 문서는 공식 영역입니다. 인증된 담당자는 바로 수정할 수 있고 일반 사용자의 수정은 검토가 필요합니다.';
  }
  if (['trusted_only', 'admin_only', 'locked'].includes(level)) return '이 문서는 보호되어 있습니다. 현재 권한에 따라 편집이 제한될 수 있습니다.';
  return '이 문서는 누구나 편집할 수 있습니다. 저장하면 새 판으로 기록됩니다.';
}

async function newUserReviewReason(userId: number) {
  const settings = await one<any>(`SELECT new_user_review_required FROM open_beta_settings WHERE id=1`);
  if (!settings?.new_user_review_required) return null;
  const privileged = await one<any>(
    `SELECT 1 AS ok
     FROM user_groups ug JOIN groups g ON g.id=ug.group_id
     WHERE ug.user_id=:userId AND g.code IN ('autoconfirmed','trusted','moderator','admin','developer')
     LIMIT 1`,
    { userId }
  );
  if (privileged) return null;
  const trust = await one<any>(`SELECT trust_level FROM user_trust WHERE user_id=:userId`, { userId });
  return (trust?.trust_level ?? 'new') === 'new' ? '신규 사용자 편집 검토 설정' : null;
}

function normalizeTrustLevel(value: unknown) {
  const trustLevel = String(value ?? '').trim();
  return ['new', 'normal', 'autoconfirmed', 'trusted', 'restricted'].includes(trustLevel) ? trustLevel : null;
}

async function syncManualTrustGroups(userId: number, trustLevel: string) {
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

async function canManageContributorTasks(user: any) {
  if (!user) return false;
  if (can(user, 'report.handle') || can(user, 'page.review')) return true;
  const group = await one<any>(
    `SELECT 1 AS ok
     FROM user_groups ug JOIN groups g ON g.id=ug.group_id
     WHERE ug.user_id=:userId AND g.code IN ('trusted','moderator','admin','developer')
     LIMIT 1`,
    { userId: user.id }
  );
  return Boolean(group);
}

async function canUploadFile(user: any) {
  if (can(user, 'file.upload')) return true;
  return (await aclDecision(user, 'upload_file', {
    id: 0,
    namespace_code: 'main',
    title: '파일',
    protection_level: 'open'
  })).allowed;
}

function canManageAclGroups(user: any) {
  return can(user, 'user.block') || can(user, 'report.handle') || Boolean(user?.groups?.some((group: string) => ['admin', 'developer'].includes(group)));
}

async function enqueueFileLicenseWork(fileId: number) {
  await exec(
    `INSERT INTO admin_work_items (work_type, target_type, target_id, priority, status, created_at, updated_at)
     SELECT 'file_license', 'file', :fileId, 'normal', 'open', NOW(), NOW()
     WHERE NOT EXISTS (
       SELECT 1 FROM admin_work_items
       WHERE work_type='file_license' AND target_type='file' AND target_id=:fileId AND status IN ('open','in_progress')
     )`,
    { fileId }
  );
}

function canEditPage(user: any, level: string) {
  if (!user) return false;
  if (level === 'open') return true;
  if (level === 'login_required') return true;
  if (level === 'review_required') return true;
  if (level === 'autoconfirmed_only') return user.groups.some((group: string) => ['autoconfirmed', 'trusted', 'moderator', 'admin', 'developer'].includes(group));
  if (level === 'trusted_only') return user.groups.some((group: string) => ['trusted', 'moderator', 'admin', 'developer'].includes(group));
  if (level === 'owner_only' || level === 'official_only') return user.groups.some((group: string) => ['server_owner', 'moderator', 'admin', 'developer'].includes(group));
  if (level === 'admin_only') return user.groups.some((group: string) => ['admin', 'developer'].includes(group));
  return false;
}

async function sectionLocks(pageId: number) {
  return query<any>(
    `SELECT id, page_id, anchor, heading, lock_type, owner_group, reason, created_at, updated_at
     FROM page_section_locks
     WHERE page_id=:pageId
     ORDER BY id`,
    { pageId }
  );
}

function normalizeSectionLockType(value: unknown) {
  const type = String(value ?? '').trim();
  return ['owner_only', 'trusted_only', 'admin_only', 'locked'].includes(type) ? type : null;
}

function normalizePageProtectionLevel(value: unknown) {
  const level = String(value ?? '').trim();
  return ['open', 'login_required', 'review_required', 'autoconfirmed_only', 'trusted_only', 'official_only', 'owner_only', 'admin_only', 'locked'].includes(level) ? level : null;
}

const aclActions = ['read', 'edit', 'create', 'move', 'delete', 'revert', 'history', 'raw', 'create_thread', 'write_thread_comment', 'edit_request', 'upload_file', 'acl'] as const;

function normalizeAclAction(value: unknown) {
  const action = String(value ?? '').trim();
  return aclActions.includes(action as any) ? action : null;
}

function normalizeAclEffect(value: unknown) {
  const effect = String(value ?? '').trim();
  return ['allow', 'deny', 'goto_space'].includes(effect) ? effect : null;
}

function normalizeAclSubjectType(value: unknown) {
  const type = String(value ?? '').trim();
  return ['perm', 'user', 'ip', 'cidr', 'aclgroup', 'role'].includes(type) ? type : null;
}

async function aclDecision(user: any, action: string, page: any) {
  if (!page) return { allowed: false, source: 'missing', rule: null as any };
  const normalizedAction = normalizeAclAction(action);
  if (!normalizedAction) return { allowed: false, source: 'invalid', rule: null as any };
  const blocked = await actorInAclGroup(user, ['blocked', 'spam']);
  if (blocked && !['read'].includes(normalizedAction)) return { allowed: false, source: 'system', rule: { effect: 'deny', subject_value: 'aclgroup:blocked' } };
  for (const target of [
    { type: 'page', id: Number(page.id) || null },
    { type: 'space', id: Number(page.space_id) || null },
    { type: 'site', id: null }
  ]) {
    const rules = await aclRulesForTarget(target.type, target.id, normalizedAction);
    for (const rule of rules) {
      if (!(await aclSubjectMatches(rule, user, page))) continue;
      if (rule.effect === 'goto_space') break;
      return { allowed: rule.effect === 'allow', source: target.type, rule };
    }
  }
  for (const rule of defaultAclRulesForPage(page, normalizedAction)) {
    if (await aclSubjectMatches(rule, user, page)) return { allowed: rule.effect === 'allow', source: 'default', rule };
  }
  return { allowed: false, source: 'default', rule: null as any };
}

async function aclRulesForTarget(targetType: string, targetId: number | null, action: string) {
  return query<any>(
    `SELECT ${aclRuleFields} FROM acl_rules
     WHERE target_type=:targetType
       AND (:targetId IS NULL OR target_id=:targetId)
       AND action=:action
       AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY sort_order, id`,
    { targetType, targetId, action }
  );
}

async function attachAclOverview(page: any, user: any) {
  const summary: Record<string, string> = {};
  for (const action of ['read', 'edit', 'create_thread', 'write_thread_comment', 'move', 'delete', 'acl']) {
    const decision = await aclDecision(user, action, page);
    summary[action] = decision.allowed ? aclSubjectDisplay(decision.rule) : '권한 없음';
  }
  const explicitRules = await query<any>(
    `SELECT ${aclRuleFields} FROM acl_rules
     WHERE target_type='page' AND target_id=:pageId AND (expires_at IS NULL OR expires_at > NOW())
     ORDER BY action, sort_order, id`,
    { pageId: page.id }
  );
  const rules = explicitRules.length ? explicitRules : ['read', 'edit', 'create_thread', 'write_thread_comment', 'move', 'delete', 'acl'].flatMap((action) => defaultAclRulesForPage(page, action));
  const logs = await aclLogsForPage(Number(page.id));
  page.aclSummary = summary;
  page.aclRules = rules;
  page.aclLogs = logs;
  page.canChangeAcl = (await aclDecision(user, 'acl', page)).allowed;
}

async function aclLogsForPage(pageId: number) {
  return query<any>(
    `SELECT ${aclChangeLogFields}, COALESCE(u.display_name, u.username, '자동') AS actor_name
     FROM acl_change_logs acl
     LEFT JOIN users u ON u.id=acl.changed_by
     WHERE acl.target_type='page' AND acl.target_id=:pageId
     ORDER BY acl.created_at DESC, acl.id DESC
     LIMIT 50`,
    { pageId }
  );
}

function aclSubjectDisplay(rule: any) {
  if (!rule) return '권한 없음';
  const value = String(rule.subject_value ?? '').replace(/^perm:/, '').replace(/^role:/, '');
  const labels: Record<string, string> = {
    any: '누구나',
    guest: '비로그인 사용자',
    member: '로그인 사용자',
    autoconfirmed: '자동 인증 사용자',
    trusted: '신뢰 사용자',
    moderator: '관리자 보조',
    admin: '관리자',
    developer: '개발자',
    server_owner: '서버 운영자',
    mod_wiki_manager: '모드 위키 관리자',
    owner_user: '사용자 문서 주인'
  };
  return labels[value] ?? value;
}

async function handleAclPost(request: any, reply: any, namespace: NamespaceCode, title: string) {
  const user = request.user;
  const page = (await getPageByTitle(namespace, title)) ?? (await getPageByAlias(namespace, title));
  const aclHref = page ? `${wikiUrl(namespace, page.title)}/acl` : wikiUrl(namespace, title);
  if (!page) return htmlError(reply, user, 404, '문서 없음', '문서를 찾을 수 없습니다.', '/wiki', '위키 대문');
  if (!(await aclDecision(user, 'acl', page)).allowed) return htmlError(reply, user, 403, '권한 없음', 'ACL을 변경할 권한이 없습니다.', wikiUrl(namespace, page.title), '문서 보기');
  const body = request.body as any;
  const deleteRuleId = nullablePositiveInt(body.deleteRuleId);
  if (deleteRuleId) {
    const oldRule = await one<any>(`SELECT ${aclRuleFields} FROM acl_rules WHERE id=:id AND target_type='page' AND target_id=:pageId`, { id: deleteRuleId, pageId: page.id });
    if (!oldRule) return htmlError(reply, user, 404, 'ACL 규칙 없음', '삭제할 ACL 규칙을 찾을 수 없습니다.', aclHref, 'ACL 보기');
    await exec(`DELETE FROM acl_rules WHERE id=:id AND target_type='page' AND target_id=:pageId`, { id: deleteRuleId, pageId: page.id });
    await logAclChange(page, 'delete', oldRule, null, boundedText(body.reason, 255) || 'ACL 규칙 삭제', user?.id ?? null);
    return reply.redirect(`${wikiUrl(namespace, page.title)}/acl`);
  }
  const template = normalizeAclTemplate(body.template);
  if (template) {
    const oldRules = await query<any>(`SELECT ${aclRuleFields} FROM acl_rules WHERE target_type='page' AND target_id=:pageId ORDER BY action, sort_order, id`, { pageId: page.id });
    await exec(`DELETE FROM acl_rules WHERE target_type='page' AND target_id=:pageId`, { pageId: page.id });
    const rules = aclTemplateRulesForPage(template, page);
    for (const [index, rule] of rules.entries()) {
      await exec(
        `INSERT INTO acl_rules (target_type, target_id, action, effect, subject_type, subject_value, sort_order, reason, expires_at, created_by, created_at, updated_at)
         VALUES ('page', :pageId, :action, :effect, :subjectType, :subjectValue, :sortOrder, :reason, NULL, :userId, NOW(), NOW())`,
        {
          pageId: page.id,
          action: rule.action,
          effect: rule.effect,
          subjectType: rule.subject_type,
          subjectValue: rule.subject_value,
          sortOrder: (index + 1) * 10,
          reason: rule.reason,
          userId: user?.id ?? null
        }
      );
    }
    await logAclChange(page, 'reset', oldRules, { template, rules }, boundedText(body.reason, 255) || `ACL 템플릿 적용: ${template}`, user?.id ?? null);
    return reply.redirect(`${wikiUrl(namespace, page.title)}/acl`);
  }
  const action = normalizeAclAction(body.action);
  const effect = normalizeAclEffect(body.effect);
  const subjectType = normalizeAclSubjectType(body.subjectType);
  const subjectValue = subjectType === 'user'
    ? await normalizeAclUserSubjectValue(body.subjectValue)
    : normalizeAclSubjectValue(subjectType, body.subjectValue);
  if (!action || !effect || !subjectType || !subjectValue) return htmlError(reply, user, 400, '입력 오류', 'ACL 규칙 값이 올바르지 않습니다.', aclHref, 'ACL 보기');
  const sort = await one<any>(`SELECT COALESCE(MAX(sort_order), 0) + 10 AS nextSort FROM acl_rules WHERE target_type='page' AND target_id=:pageId AND action=:action`, {
    pageId: page.id,
    action
  });
  const expiresAt = aclExpiresAt(body.expiresIn);
  const result = await exec(
    `INSERT INTO acl_rules (target_type, target_id, action, effect, subject_type, subject_value, sort_order, reason, expires_at, created_by, created_at, updated_at)
     VALUES ('page', :pageId, :action, :effect, :subjectType, :subjectValue, :sortOrder, :reason, :expiresAt, :userId, NOW(), NOW())`,
    {
      pageId: page.id,
      action,
      effect,
      subjectType,
      subjectValue,
      sortOrder: Number(sort?.nextSort ?? 10),
      reason: boundedText(body.reason, 255) || null,
      expiresAt,
      userId: user?.id ?? null
    }
  );
  const newRule = await one<any>(`SELECT ${aclRuleFields} FROM acl_rules WHERE id=:id`, { id: result.insertId });
  await logAclChange(page, 'insert', null, newRule ?? {}, boundedText(body.reason, 255) || null, user?.id ?? null);
  await exec(
    `INSERT INTO recent_changes (page_id, actor_id, change_type, title, namespace_code, summary, created_at)
     VALUES (:pageId, :userId, 'protect', :title, :namespace, :summary, NOW())`,
    { pageId: page.id, userId: user?.id ?? null, title: page.title, namespace: page.namespace_code, summary: `ACL 변경: ${action} ${effect} ${subjectType}:${subjectValue}` }
  );
  return reply.redirect(`${wikiUrl(namespace, page.title)}/acl`);
}

async function logAclChange(page: any, actionType: 'insert' | 'update' | 'delete' | 'reset', oldRule: any, newRule: any, reason: string | null, userId: number | null) {
  await exec(
    `INSERT INTO acl_change_logs (target_type, target_id, action_type, old_rule_json, new_rule_json, reason, changed_by, created_at)
     VALUES ('page', :pageId, :actionType, :oldRule, :newRule, :reason, :userId, NOW())`,
    {
      pageId: page.id,
      actionType,
      oldRule: oldRule == null ? null : JSON.stringify(oldRule),
      newRule: newRule == null ? null : JSON.stringify(newRule),
      reason,
      userId
    }
  );
}

function normalizeAclTemplate(value: unknown) {
  const template = String(value ?? '').trim();
  return ['public_edit', 'members_only', 'autoconfirmed_only', 'request_only', 'locked'].includes(template) ? template : null;
}

function aclTemplateRulesForPage(template: string, page: any) {
  const common = [
    aclPermRule('read', 'allow', 'any', `${template}_template`),
    aclPermRule('history', 'allow', 'any', `${template}_template`),
    aclPermRule('raw', 'allow', 'any', `${template}_template`),
    aclPermRule('create_thread', 'allow', template === 'locked' ? 'member' : 'any', `${template}_template`),
    aclPermRule('write_thread_comment', 'allow', template === 'locked' ? 'member' : 'any', `${template}_template`),
    aclPermRule('create', 'allow', 'member', `${template}_template`),
    aclPermRule('move', 'allow', 'autoconfirmed', `${template}_template`),
    aclPermRule('revert', 'allow', 'autoconfirmed', `${template}_template`),
    aclPermRule('upload_file', 'allow', 'autoconfirmed', `${template}_template`),
    aclPermRule('delete', 'allow', 'admin', `${template}_template`),
    aclPermRule('acl', 'allow', 'admin', `${template}_template`)
  ];
  if (template === 'members_only') return [...common, aclPermRule('edit', 'allow', 'member', `${template}_template`), aclPermRule('edit_request', 'allow', 'any', `${template}_template`)];
  if (template === 'autoconfirmed_only') return [...common, aclPermRule('edit', 'allow', 'autoconfirmed', `${template}_template`), aclPermRule('edit_request', 'allow', 'any', `${template}_template`)];
  if (template === 'request_only') return [...common, aclPermRule('edit', 'allow', 'admin', `${template}_template`), aclPermRule('edit_request', 'allow', 'any', `${template}_template`)];
  if (template === 'locked') return [...common, aclPermRule('edit', 'allow', 'admin', `${template}_template`), aclPermRule('edit_request', 'deny', 'any', `${template}_template`)];
  const defaultEdit = defaultAclRulesForPage(page, 'edit');
  return [...common, ...(defaultEdit.length ? defaultEdit : [aclPermRule('edit', 'allow', 'any', `${template}_template`)]), aclPermRule('edit_request', 'allow', 'any', `${template}_template`)];
}

function normalizeAclSubjectValue(subjectType: string | null, value: unknown) {
  const subject = String(value ?? '').trim();
  if (!subject || subject.length > 255) return null;
  if (subjectType === 'perm') return ['any', 'guest', 'member', 'autoconfirmed', 'trusted', 'moderator', 'admin', 'developer'].includes(subject.replace(/^perm:/, '')) ? subject.replace(/^perm:/, '') : null;
  if (subjectType === 'role') return ['server_owner', 'server_manager', 'server_editor', 'mod_wiki_manager', 'mod_wiki_editor', 'page_contributor', 'space_contributor', 'owner_user'].includes(subject.replace(/^role:/, '')) ? subject.replace(/^role:/, '') : null;
  if (subjectType === 'user') return nullablePositiveInt(subject.replace(/^user:/, '')) ? subject.replace(/^user:/, '') : null;
  if (subjectType === 'aclgroup') return /^[a-z0-9_-]{1,64}$/.test(subject.replace(/^aclgroup:/, '')) ? subject.replace(/^aclgroup:/, '') : null;
  if (subjectType === 'ip') return net.isIP(subject) ? subject : null;
  if (subjectType === 'cidr') return /^[0-9a-fA-F:.]+\/\d{1,3}$/.test(subject) ? subject : null;
  return null;
}

async function normalizeAclUserSubjectValue(value: unknown) {
  const subject = String(value ?? '').trim().replace(/^user:/, '');
  if (!subject || subject.length > 255) return null;
  if (nullablePositiveInt(subject)) return subject;
  const user = await userByIdentifier(subject);
  return user?.id ? String(user.id) : null;
}

function aclExpiresAt(value: unknown) {
  const duration = String(value ?? '').trim();
  if (duration === '24h') return new Date(Date.now() + 24 * 60 * 60 * 1000);
  if (duration === '3d') return new Date(Date.now() + 3 * 24 * 60 * 60 * 1000);
  if (duration === '7d') return new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  return null;
}

function defaultAclRulesForPage(page: any, action: string) {
  const level = String(page?.protection_level ?? 'open');
  const namespace = String(page?.namespace_code ?? 'main');
  const title = String(page?.title ?? '');
  const rules: any[] = [];
  const add = (effect: string, subjectValue: string, reason = 'default') => rules.push({ action, effect, subject_type: 'perm', subject_value: subjectValue, sort_order: rules.length + 1, reason });
  if (action === 'read' || action === 'history' || action === 'raw' || action === 'create_thread' || action === 'write_thread_comment' || action === 'edit_request') {
    if (namespace === 'main' && isUserWikiTitle(title) && ['create_thread', 'write_thread_comment'].includes(action)) add('allow', 'member', 'user_wiki_default');
    else add('allow', 'any');
    return rules;
  }
  if (action === 'delete' || action === 'acl') return [aclPermRule(action, 'allow', 'admin')];
  if (action === 'upload_file' || action === 'move' || action === 'revert') return [aclPermRule(action, 'allow', 'autoconfirmed')];
  if (action === 'create') return [aclPermRule(action, 'allow', 'member')];
  if (action !== 'edit') return rules;
  if (namespace === 'main' && title === '대문') return [aclPermRule(action, 'allow', 'autoconfirmed', 'front_page_default')];
  if (namespace === 'main' && isUserWikiTitle(title)) return [aclRoleRule(action, 'allow', 'owner_user', 'user_wiki_default')];
  if ((namespace === 'server' || namespace === 'mod') && title.includes('/')) return [aclRoleRule(action, 'allow', namespace === 'server' ? 'server_owner' : 'mod_wiki_manager', 'official_area_default')];
  if (level === 'open') add('allow', 'any');
  else if (level === 'login_required') add('allow', 'member');
  else if (level === 'review_required' || level === 'autoconfirmed_only') add('allow', 'autoconfirmed');
  else if (level === 'trusted_only') add('allow', 'trusted');
  else if (level === 'admin_only' || level === 'locked') add('allow', 'admin');
  else if (level === 'owner_only' || level === 'official_only') return [aclRoleRule(action, 'allow', namespace === 'server' ? 'server_owner' : namespace === 'mod' ? 'mod_wiki_manager' : 'owner_user', 'official_area_default')];
  return rules;
}

function aclPermRule(action: string, effect: string, subjectValue: string, reason = 'default') {
  return { action, effect, subject_type: 'perm', subject_value: subjectValue, sort_order: 1, reason };
}

function aclRoleRule(action: string, effect: string, subjectValue: string, reason = 'default') {
  return { action, effect, subject_type: 'role', subject_value: subjectValue, sort_order: 1, reason };
}

async function aclSubjectMatches(rule: any, user: any, page: any) {
  const type = String(rule.subject_type ?? 'perm');
  const value = String(rule.subject_value ?? '');
  if (type === 'perm') return aclPermMatches(value, user);
  if (type === 'user') return Boolean(user && Number(user.id) === Number(value.replace(/^user:/, '')));
  if (type === 'aclgroup') return actorInAclGroup(user, [value.replace(/^aclgroup:/, '')]);
  if (type === 'role') return aclRoleMatches(value, user, page);
  if (type === 'ip') return Boolean(user?.actorIpText && user.actorIpText === value.replace(/^ip:/, ''));
  if (type === 'cidr') return Boolean(user?.actorIpText && ipInCidr(String(user.actorIpText), value.replace(/^cidr:/, '')));
  return false;
}

function ipInCidr(ip: string, cidr: string) {
  const [range, bitsText] = cidr.split('/');
  const bits = Number(bitsText);
  const family = net.isIP(ip);
  if (!family || family !== net.isIP(range) || !Number.isInteger(bits)) return false;
  const maxBits = family === 4 ? 32 : 128;
  if (bits < 0 || bits > maxBits) return false;
  const ipBuffer = ipToBytes(ip);
  const rangeBuffer = ipToBytes(range);
  if (!ipBuffer || !rangeBuffer || ipBuffer.length !== rangeBuffer.length) return false;
  const fullBytes = Math.floor(bits / 8);
  const remainingBits = bits % 8;
  for (let i = 0; i < fullBytes; i += 1) {
    if (ipBuffer[i] !== rangeBuffer[i]) return false;
  }
  if (remainingBits === 0) return true;
  const mask = 0xff << (8 - remainingBits) & 0xff;
  return (ipBuffer[fullBytes] & mask) === (rangeBuffer[fullBytes] & mask);
}

function ipToBytes(ip: string) {
  if (net.isIP(ip) === 4) return Buffer.from(ip.split('.').map((part) => Number(part)));
  if (net.isIP(ip) !== 6) return null;
  const sections = ip.split('::');
  const left = sections[0] ? sections[0].split(':') : [];
  const right = sections[1] ? sections[1].split(':') : [];
  const missing = 8 - left.length - right.length;
  if (missing < 0) return null;
  const groups = [...left, ...Array(missing).fill('0'), ...right].map((part) => parseInt(part || '0', 16));
  if (groups.length !== 8 || groups.some((part) => !Number.isInteger(part) || part < 0 || part > 0xffff)) return null;
  const buffer = Buffer.alloc(16);
  groups.forEach((part, index) => buffer.writeUInt16BE(part, index * 2));
  return buffer;
}

function aclPermMatches(value: string, user: any) {
  const perm = value.replace(/^perm:/, '');
  if (perm === 'any') return true;
  if (perm === 'guest') return !user || Boolean(user.anonymous);
  if (perm === 'member') return Boolean(user && !user.anonymous);
  if (!user || user.anonymous) return false;
  if (perm === 'developer') return user.groups?.includes('developer');
  if (perm === 'admin') return user.groups?.some((group: string) => ['admin', 'developer'].includes(group));
  if (perm === 'moderator') return user.groups?.some((group: string) => ['moderator', 'admin', 'developer'].includes(group));
  if (perm === 'trusted') return user.groups?.some((group: string) => ['trusted', 'moderator', 'admin', 'developer'].includes(group));
  if (perm === 'autoconfirmed') return user.groups?.some((group: string) => ['autoconfirmed', 'trusted', 'moderator', 'admin', 'developer'].includes(group));
  return false;
}

async function aclRoleMatches(value: string, user: any, page: any) {
  if (!user || user.anonymous) return false;
  const role = value.replace(/^role:/, '');
  if (role === 'owner_user') return canEditUserWikiTitle(user, String(page?.title ?? ''));
  if (role === 'server_owner' || role === 'server_manager' || role === 'server_editor') {
    const slug = String(page?.title ?? '').split('/')[0];
    const roles = role === 'server_owner' ? 'owner' : role === 'server_manager' ? 'owner,manager' : 'owner,manager,editor';
    const owner = await one<any>(
      `SELECT 1 AS ok
       FROM wiki_spaces ws
       LEFT JOIN server_owners so ON so.page_id=ws.root_page_id AND so.user_id=:userId AND so.status='active'
       LEFT JOIN subwiki_roles sr ON sr.space_id=ws.id AND sr.user_id=:userId AND sr.status='active'
       WHERE ws.code=:code AND (FIND_IN_SET(so.role, :roles) OR FIND_IN_SET(sr.role, :roles))
       LIMIT 1`,
      { code: `server-${slug}`, userId: user.id, roles }
    );
    return Boolean(owner) || can(user, 'server.official_edit') || can(user, 'report.handle');
  }
  if (role === 'mod_wiki_manager' || role === 'mod_wiki_editor') {
    const slug = String(page?.title ?? '').split('/')[0];
    const space = slug ? await modSubwikiSpace(slug) : null;
    if (!space) return can(user, 'report.handle');
    if (role === 'mod_wiki_manager') return canManageSubwiki(user, Number(space.id));
    const editor = await one<any>(
      `SELECT 1 AS ok FROM subwiki_roles WHERE space_id=:spaceId AND user_id=:userId AND status='active' AND role IN ('owner','manager','editor') LIMIT 1`,
      { spaceId: space.id, userId: user.id }
    );
    return Boolean(editor) || canManageSubwiki(user, Number(space.id));
  }
  if (role === 'page_contributor') {
    const contributor = await one<any>(`SELECT 1 AS ok FROM page_revisions WHERE page_id=:pageId AND created_by=:userId LIMIT 1`, { pageId: page.id, userId: user.id });
    return Boolean(contributor);
  }
  if (role === 'space_contributor') {
    const contributor = await one<any>(
      `SELECT 1 AS ok FROM page_revisions r JOIN pages p ON p.id=r.page_id WHERE p.space_id=:spaceId AND r.created_by=:userId LIMIT 1`,
      { spaceId: page.space_id, userId: user.id }
    );
    return Boolean(contributor);
  }
  return false;
}

async function actorInAclGroup(user: any, groupKeys: string[]) {
  if (!user || groupKeys.length === 0) return false;
  const groupKeysCsv = groupKeys.join(',');
  const actorIpText = net.isIP(String(user.actorIpText ?? '')) ? String(user.actorIpText) : null;
  const row = await one<any>(
    `SELECT 1 AS ok
     FROM acl_group_members agm
     JOIN acl_groups ag ON ag.id=agm.group_id
     WHERE FIND_IN_SET(ag.group_key, :groupKeysCsv)
       AND ag.status='active'
       AND agm.removed_at IS NULL
       AND (agm.expires_at IS NULL OR agm.expires_at > NOW())
       AND (
         (agm.member_type='user' AND :userId IS NOT NULL AND agm.user_id=:userId)
         OR (agm.member_type='ip' AND :actorIpText IS NOT NULL AND agm.ip=INET6_ATON(:actorIpText))
       )
     LIMIT 1`,
    { groupKeysCsv, userId: user.anonymous ? null : user.id, actorIpText }
  );
  if (row) return true;
  if (!actorIpText) return false;
  const cidrRows = await query<any>(
    `SELECT agm.cidr
     FROM acl_group_members agm
     JOIN acl_groups ag ON ag.id=agm.group_id
     WHERE FIND_IN_SET(ag.group_key, :groupKeysCsv)
       AND ag.status='active'
       AND agm.member_type='cidr'
       AND agm.cidr IS NOT NULL
       AND agm.removed_at IS NULL
       AND (agm.expires_at IS NULL OR agm.expires_at > NOW())`,
    { groupKeysCsv }
  );
  return cidrRows.some((item) => ipInCidr(actorIpText, String(item.cidr ?? '')));
}

async function assertSectionEditAllowed(page: any, anchor: string, user: any) {
  const lock = await one<any>(`SELECT ${pageSectionLockFields} FROM page_section_locks WHERE page_id=:pageId AND anchor=:anchor`, { pageId: page.id, anchor });
  if (!lock) return;
  if (!(await canEditSectionLock(user, page, lock))) {
    throw new Error('section_locked');
  }
}

async function assertLockedSectionsUnchanged(page: any, nextContent: string, user: any) {
  const locks = await sectionLocks(Number(page.id));
  if (locks.length === 0) return;
  const currentContent = String(page.content_raw ?? '');
  for (const lock of locks) {
    if (await canEditSectionLock(user, page, lock)) continue;
    const before = sectionContentByAnchor(currentContent, lock.anchor);
    const after = sectionContentByAnchor(nextContent, lock.anchor);
    if (before !== after) throw new Error(`section_locked:${lock.heading}`);
  }
}

function sectionContentByAnchor(content: string, anchor: string) {
  const parsed = parseMarkup(content);
  const heading = parsed.headings.find((item) => item.anchor === anchor);
  if (!heading) return null;
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return lines.slice(heading.startLine - 1, heading.endLine).join('\n');
}

function removeSectionFromContent(content: string, startLine: number, endLine: number) {
  const lines = content.replace(/\r\n/g, '\n').split('\n');
  return [...lines.slice(0, startLine - 1), ...lines.slice(endLine)].join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
}

async function canEditSectionLock(user: any, page: any, lock: any) {
  if (can(user, 'page.protect') || can(user, 'report.handle')) return true;
  if (!user) return false;
  if (lock.owner_group && user.groups?.includes(lock.owner_group)) return true;
  if (lock.lock_type === 'trusted_only') return user.groups?.some((group: string) => ['trusted', 'moderator', 'admin', 'developer'].includes(group));
  if (lock.lock_type === 'owner_only') {
    const space = await subwikiSpaceForPage(page);
    return space ? canManageSubwiki(user, Number(space.id)) : false;
  }
  return false;
}

async function subwikiSpaceForPage(page: any) {
  const namespace = String(page.namespace_code ?? '');
  const root = String(page.title ?? '').split('/')[0];
  if (!root || !['server', 'mod'].includes(namespace)) return null;
  return one<any>(`SELECT ${wikiSpaceFields} FROM wiki_spaces WHERE code=:code AND space_type IN ('server_wiki','mod_wiki')`, { code: `${namespace}-${root}` });
}

async function subwikiEditPolicy(namespace: NamespaceCode, title: string, user: any) {
  if (!['server', 'mod'].includes(namespace)) return { allowed: true, forceReviewReason: null as string | null };
  const root = String(title ?? '').split('/')[0];
  if (!root) return { allowed: true, forceReviewReason: null as string | null };
  const space = await one<any>(
    `SELECT ws.id, ss.allow_public_edit, ss.public_edit_enabled, ss.require_review, ss.review_required
     FROM wiki_spaces ws
     LEFT JOIN subwiki_settings ss ON ss.space_id=ws.id
     WHERE ws.code=:code AND ws.space_type IN ('server_wiki','mod_wiki')
     LIMIT 1`,
    { code: `${namespace}-${root}` }
  );
  if (!space) return { allowed: true, forceReviewReason: null as string | null };
  const manager = await canManageSubwiki(user, Number(space.id));
  if (manager) return { allowed: true, forceReviewReason: null };
  if (Number(space.allow_public_edit ?? space.public_edit_enabled ?? 1) === 0) return { allowed: false, forceReviewReason: null };
  const requiresReview = Number(space.require_review ?? space.review_required ?? 0) === 1;
  const officialPage = String(title ?? '').includes('/');
  return { allowed: true, forceReviewReason: officialPage ? '공식 영역 편집 검토 필요' : requiresReview ? '위키 공개 편집 검토 설정' : null };
}

function canViewRestrictedRevisions(user: any) {
  return can(user, 'report.handle') || Boolean(user?.groups?.some((group: string) => ['admin', 'developer', 'moderator'].includes(group)));
}

function canViewSuppressedRevisions(user: any) {
  return Boolean(user?.groups?.some((group: string) => ['admin', 'developer'].includes(group)));
}

type WikiTool = 'read' | 'edit' | 'aclHistory' | 'history' | 'discussion' | 'diff' | 'raw' | 'permissions' | 'acl';

const wikiToolSuffixes: Array<{ tool: WikiTool; suffix: string }> = [
  { tool: 'aclHistory', suffix: '/acl/history' },
  { tool: 'discussion', suffix: '/discussion' },
  { tool: 'permissions', suffix: '/permissions' },
  { tool: 'history', suffix: '/history' },
  { tool: 'edit', suffix: '/edit' },
  { tool: 'diff', suffix: '/diff' },
  { tool: 'raw', suffix: '/raw' },
  { tool: 'acl', suffix: '/acl' }
];

function splitWikiToolPath(rawPath: string) {
  for (const entry of wikiToolSuffixes) {
    if (rawPath.endsWith(entry.suffix)) {
      return { basePath: rawPath.slice(0, -entry.suffix.length), tool: entry.tool, suffix: entry.suffix };
    }
  }
  return { basePath: rawPath, tool: 'read' as WikiTool, suffix: '' };
}

async function canReadPageResource(user: any, page: any) {
  if (!page) return false;
  const status = String(page.status ?? '');
  if ((status === 'deleted' || status === 'hidden') && !canViewRestrictedRevisions(user)) return false;
  return (await aclDecision(user, 'read', page)).allowed;
}

async function renderRevisionPage(revision: any, user: any) {
  const revisionPage = await getPageAtRevision(
    Number(revision.page_id),
    Number(revision.id),
    canViewRestrictedRevisions(user),
    canViewSuppressedRevisions(user),
    String(revision.page_status ?? '') === 'deleted'
  );
  if (!revisionPage) return null;
  if (revisionPage.page_type === 'mod') revisionPage.modDetails = await modDetails(Number(revisionPage.id));
  revisionPage.sidebarItems = await sidebarForPage(revisionPage.namespace_code, revisionPage.title, user);
  revisionPage.recentRows = await recentChanges(15);
  return revisionPage;
}

async function attachDocumentToolChrome(page: any, namespace: NamespaceCode, user: any) {
  if (!page) return;
  const pageNamespace = (page.namespace_code ?? namespace) as NamespaceCode;
  if (page.page_type === 'mod') page.modDetails = await modDetails(Number(page.id));
  page.sidebarItems = await sidebarForPage(pageNamespace, page.title, user);
  page.recentRows = await recentChanges(15);
  await attachSubwikiTheme(page, pageNamespace);
}

async function renderRawDocumentPage(request: any, reply: any, page: any, user: any, aclActor: any) {
  if (!page) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  if (!(await aclDecision(aclActor, 'raw', page)).allowed) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  const revisionId = nullablePositiveInt((request.query as any).oldid);
  const revision = revisionId ? await pageRevision(Number(page.id), revisionId, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user)) : null;
  if (revisionId && !revision) return reply.code(404).type('text/html').send(messagePage('리비전 없음', '이 문서의 공개 리비전을 찾을 수 없습니다.', user, { tone: 'error', actionHref: wikiUrl(page.namespace_code, page.title), actionLabel: '문서 보기' }));
  await attachDocumentToolChrome(page, page.namespace_code, aclActor);
  return reply.type('text/html').send(rawPage(page, String(revision?.content_raw ?? page.content_raw ?? ''), user, revision));
}

function userWikiTitleFromPath(rawPath: string) {
  const clean = normalizeTitle(decodePathPart(rawPath)).replace(/^\/+|\/+$/g, '');
  const [username, ...rest] = clean.split('/').filter(Boolean);
  if (!username) return null;
  const subPath = rest.join('/');
  return {
    username,
    subPath,
    title: subPath ? `사용자:${username}/${subPath}` : `사용자:${username}`
  };
}

function isUserWikiTitle(title: string) {
  return normalizeTitle(title).startsWith('사용자:');
}

function userWikiOwnerName(title: string) {
  if (!isUserWikiTitle(title)) return '';
  return normalizeTitle(title).slice('사용자:'.length).split('/')[0] ?? '';
}

function userWikiDisplayTitle(title: string) {
  if (!isUserWikiTitle(title)) return title;
  const subPath = normalizeTitle(title).slice('사용자:'.length).split('/').slice(1).join('/');
  return subPath || '사용자 문서';
}

async function renderUserWikiPage(request: any, reply: any, rawPath: string) {
  const toolPath = splitWikiToolPath(rawPath);
  const parsed = userWikiTitleFromPath(toolPath.basePath);
  if (!parsed) return reply.code(404).type('text/html').send(messagePage('사용자 위키 없음', '사용자 위키 경로가 올바르지 않습니다.', request.user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  if (toolPath.suffix) return reply.redirect(`${wikiUrl('main', parsed.title)}${toolPath.suffix}`);
  const page = await getPageByTitle('main', parsed.title);
  if (!page) {
    const owner = await one<any>(`SELECT id FROM users WHERE username=:username AND status='active'`, { username: parsed.username });
    if (owner && request.user && Number(owner.id) === Number(request.user.id)) {
      await ensureUserWiki(Number(request.user.id));
      return reply.redirect(`/user/${encodeURIComponent(parsed.username)}`);
    }
    return reply.code(404).type('text/html').send(messagePage('사용자 위키 없음', '사용자 위키 문서를 찾을 수 없습니다.', request.user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  }
  page.sidebarItems = userWikiSidebar(parsed.username);
  page.display_title = userWikiDisplayTitle(String(page.title ?? parsed.title));
  page.recentRows = await recentChanges(15);
  page.sectionLocks = await sectionLocks(Number(page.id));
  await attachDiscussionChrome(page, request.user, aclActorForRequest(request));
  await recordPageView(page, request);
  return reply.type('text/html').send(articlePage(page, request.user));
}

function userWikiSidebar(username: string) {
  return ['소개', '연습장', '작업목록', '메모'].map((label, index) => ({
    id: index + 1,
    parent_id: null,
    label,
    target_title: `사용자:${username}/${label}`
  }));
}

async function ensureUserWiki(userId: number) {
  const user = await one<any>(`SELECT id, username, display_name, created_at FROM users WHERE id=:userId AND status='active'`, { userId });
  if (!user) return null;
  const username = String(user.username);
  const existing = await one<any>(`SELECT uw.id, uw.user_id, uw.space_id, uw.username_slug, uw.status, uw.created_at, uw.updated_at, ws.root_page_id FROM user_wikis uw JOIN wiki_spaces ws ON ws.id=uw.space_id WHERE uw.user_id=:userId`, { userId });
  if (existing) {
    await syncUserWikiPages(Number(existing.space_id), username);
    return existing;
  }
  const root = appliedPage(await savePage({
    namespace: 'main',
    title: `사용자:${username}`,
    displayTitle: '사용자 문서',
    content: userWikiTemplate(username, user.display_name, user.created_at),
    summary: '사용자 위키 생성',
    userId,
    pageType: 'article'
  }));
  const parent = await one<any>(`SELECT id FROM wiki_spaces WHERE code='main' OR root_namespace_code='main' ORDER BY id LIMIT 1`);
  await exec(
    `INSERT INTO wiki_spaces (code, space_key, name, title, slug, space_type, parent_space_id, root_page_id, root_namespace_code, root_path, description, status, created_by, owner_user_id, created_at, updated_at)
     VALUES (:code, :code, :name, :name, :slug, 'user_wiki', :parentId, :rootPageId, 'main', :rootPath, :description, 'active', :userId, :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE root_page_id=VALUES(root_page_id), status='active', updated_at=NOW()`,
    {
      code: `user-${username}`,
      name: `${user.display_name} 사용자 위키`,
      slug: username,
      parentId: parent?.id ?? null,
      rootPageId: root.pageId,
      rootPath: `/user/${username}`,
      description: `${user.display_name}의 개인 작업 공간`,
      userId
    }
  );
  const space = await one<any>(`SELECT id FROM wiki_spaces WHERE code=:code`, { code: `user-${username}` });
  await exec(
    `INSERT INTO user_wikis (user_id, space_id, username_slug, status, created_at, updated_at)
     VALUES (:userId, :spaceId, :username, 'active', NOW(), NOW())
     ON DUPLICATE KEY UPDATE space_id=VALUES(space_id), status='active', updated_at=NOW()`,
    { userId, spaceId: space.id, username }
  );
  const docs = [
    ['소개', `'''${user.display_name}'''의 소개 문서입니다.\n\n== 소개 ==\n\n== 관심 분야 ==\n`],
    ['연습장', '이 문서는 편집 연습용 공간입니다.\n\n== 연습장 ==\n위키 문법, 문서 양식, 표, 링크 등을 자유롭게 테스트할 수 있습니다.\n'],
    ['작업목록', '== 작업 중인 문서 ==\n* \n\n== 메모 ==\n'],
    ['메모', '== 메모 ==\n개인 작업 메모 공간입니다. 공개 문서이므로 개인정보를 적지 마세요.\n']
  ];
  for (const [localPath, content] of docs) {
    await savePage({
      namespace: 'main',
      title: `사용자:${username}/${localPath}`,
      displayTitle: localPath,
      content,
      summary: '사용자 위키 기본 문서 생성',
      userId,
      pageType: 'article'
    });
  }
  await syncUserWikiPages(Number(space.id), username);
  return one<any>(`SELECT ${userWikiFields} FROM user_wikis WHERE user_id=:userId`, { userId });
}

async function syncUserWikiPages(spaceId: number, username: string) {
  await exec(
    `UPDATE pages
     SET space_id=:spaceId,
         local_path=CASE
           WHEN title=:rootTitle THEN '대문'
           WHEN title LIKE :prefixLike THEN SUBSTRING(title, CHAR_LENGTH(:prefix) + 1)
           ELSE local_path
         END,
         display_title=CASE
           WHEN title=:rootTitle THEN '사용자 문서'
           WHEN title LIKE :prefixLike THEN SUBSTRING(title, CHAR_LENGTH(:prefix) + 1)
           ELSE display_title
         END,
         protection_level='owner_only',
         updated_at=NOW()
     WHERE namespace_id=(SELECT id FROM namespaces WHERE code='main')
       AND (title=:rootTitle OR title LIKE :prefixLike)`,
    { spaceId, rootTitle: `사용자:${username}`, prefix: `사용자:${username}/`, prefixLike: `사용자:${username}/%` }
  );
}

function userWikiTemplate(username: string, displayName: string, createdAt: string) {
  return `{{사용자 정보
|이름=${displayName}
|가입일=${formatWikiDateTime(new Date(createdAt))}
|관심 분야=
}}

'''${displayName}'''의 사용자 문서입니다.

== 소개 ==

== 관심 분야 ==

== 작업 중인 문서 ==

== 하위 문서 ==
* [[사용자:${username}/소개|소개]]
* [[사용자:${username}/연습장|연습장]]
* [[사용자:${username}/작업목록|작업목록]]
* [[사용자:${username}/메모|메모]]

이 공간은 개인 작업 공간이며 공식 문서가 아닙니다. 개인정보를 적지 마세요.`;
}

async function canEditUserWikiTitle(user: any, title: string) {
  if (!isUserWikiTitle(title)) return true;
  if (!user) return false;
  if (can(user, 'report.handle') || can(user, 'page.protect')) return true;
  const ownerName = userWikiOwnerName(title);
  return ownerName.toLowerCase() === String(user.username ?? '').toLowerCase();
}

async function renderSpaceWikiPage(request: any, reply: any, namespace: NamespaceCode, rawPath: string) {
  const user = request.user;
  const aclActor = aclActorForRequest(request);
  const toolPath = splitWikiToolPath(rawPath);
  const title = normalizeTitle(toolPath.basePath);
  const livePage = (await getPageByTitle(namespace, title)) ?? (await getPageByAlias(namespace, title));
  const deletedPage = !livePage && ['history', 'diff', 'raw'].includes(toolPath.tool) ? await getPageByTitleIncludingDeleted(namespace, title) : null;
  const page = livePage ?? deletedPage;
  const requestedType = normalizeDocumentType(String((request.query as any).type ?? documentTypeForNamespace(namespace)));
  if (toolPath.tool === 'permissions' || toolPath.tool === 'acl' || toolPath.tool === 'aclHistory') {
    if (!page) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    const events = await pageProtectionEvents(Number(page.id));
    await attachAclOverview(page, user);
    await attachDocumentToolChrome(page, namespace, aclActor);
    if (toolPath.tool === 'aclHistory') return reply.type('text/html').send(aclHistoryPage(page, events, user));
    return reply.type('text/html').send(permissionInfoPage(page, events, user));
  }
  if (page && !(await canReadPageResource(aclActor, page))) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
  if (toolPath.tool === 'discussion') {
    if (!page) return reply.code(404).type('text/html').send(messagePage('문서 없음', '토론 문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    if (page.page_type === 'mod') page.modDetails = await modDetails(Number(page.id));
    page.sidebarItems = await sidebarForPage(namespace, page.title, aclActor);
    page.recentRows = await recentChanges(15);
    page.sectionLocks = await sectionLocks(Number(page.id));
    page.discussionStatus = discussionTabStatus((request.query as any).status);
    await attachDiscussionChrome(page, user, aclActor);
    await attachSubwikiTheme(page, namespace);
    await recordPageView(page, request);
    return reply.type('text/html').send(discussionPage(page, user));
  }
  if (toolPath.tool === 'raw') return renderRawDocumentPage(request, reply, page, user, aclActor);
  if (toolPath.tool === 'edit') {
    if (namespace === 'main' && isUserWikiTitle(page?.title ?? title) && !(await canEditUserWikiTitle(user, page?.title ?? title))) {
      return reply.code(403).type('text/html').send(messagePage('권한 없음', '사용자 문서는 본인과 관리자만 수정할 수 있습니다.', user, { tone: 'error', actionHref: wikiUrl(namespace, page?.title ?? title), actionLabel: '문서 보기' }));
    }
    const announcements = await publicAnnouncements(request.user);
    const policyNotice = editPolicyNotice(page, namespace, page?.title ?? title, user);
    const blank = String((request.query as any).blank ?? '') === '1';
    const initialContent = page?.content_raw ?? (blank ? '' : ((await templateContent((request.query as any).template, title, namespace)) || defaultMarkup(title, namespace, requestedType)));
    return reply
      .type('text/html')
      .send(
        editPage(
          namespace,
          page?.title ?? title,
          initialContent,
          user,
          announcements,
          page?.page_type ?? pageTypeForDocumentType(requestedType),
          page?.current_revision_id ?? '',
          policyNotice
        )
      );
  }
  if (toolPath.tool === 'history') {
    if (!page) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    if (!(await aclDecision(aclActor, 'history', page)).allowed) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    page.aclLogs = await aclLogsForPage(Number(page.id));
    await attachDocumentToolChrome(page, namespace, aclActor);
    const filterTag = revisionHistoryFilterTag(request.query, user);
    const revisions = await pageRevisions(Number(page.id), canViewRestrictedRevisions(user), canViewSuppressedRevisions(user));
    return reply.type('text/html').send(revisionHistoryPage(page, filterRevisionHistory(revisions, filterTag, user), user, { filterTag }));
  }
  if (toolPath.tool === 'diff') {
    if (!page) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    if (!(await aclDecision(aclActor, 'history', page)).allowed) return reply.code(404).type('text/html').send(messagePage('문서 없음', '문서를 찾을 수 없습니다.', user, { tone: 'error', actionHref: '/wiki', actionLabel: '위키 대문' }));
    const revisions = await pageRevisions(Number(page.id), canViewRestrictedRevisions(user), canViewSuppressedRevisions(user));
    const query = request.query as any;
    const to = Number(query.to || revisions[0]?.id || 0);
    const from = Number(query.from || revisions[1]?.id || to);
    const result = await diffRevisions(Number(page.id), from, to, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user));
    if (!result) return reply.code(404).type('text/html').send(messagePage('비교 없음', '비교할 리비전을 찾을 수 없습니다.', user, { tone: 'error', actionHref: wikiUrl(page.namespace_code, page.title), actionLabel: '문서 보기' }));
    const fromRevision = revisions.find((revision) => Number(revision.id) === from);
    const toRevision = revisions.find((revision) => Number(revision.id) === to);
    await attachDocumentToolChrome(page, namespace, aclActor);
    return reply.type('text/html').send(revisionDiffPage(page, { ...result, fromRevisionNo: fromRevision?.revision_no, toRevisionNo: toRevision?.revision_no }, user));
  }
  const oldid = Number((request.query as any).oldid || 0);
  if (!page && oldid) {
    const revision = await pageRevisionById(oldid, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user), true);
    if (revision && revision.namespace_code === namespace && normalizeTitle(revision.title) === normalizeTitle(title)) {
      const revisionPage = await renderRevisionPage(revision, user);
      if (revisionPage) {
        await attachDiscussionChrome(revisionPage, user, aclActor);
        return reply.type('text/html').send(articlePage(revisionPage, user));
      }
    }
  }
  if (!page) {
    return reply
      .code(404)
      .type('text/html')
      .send(missingDocumentPage(namespace, title, user, request.query as any));
  }
  if (page.page_type === 'mod') page.modDetails = await modDetails(Number(page.id));
  if (oldid) {
    const revisionPage = await getPageAtRevision(Number(page.id), oldid, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user), String(page.status ?? '') === 'deleted');
    if (!revisionPage) return reply.code(404).type('text/html').send(messagePage('리비전 없음', '이 문서의 공개 리비전을 찾을 수 없습니다.', user, { tone: 'error', actionHref: wikiUrl(page.namespace_code, page.title), actionLabel: '현재 문서' }));
    if (revisionPage.page_type === 'mod') revisionPage.modDetails = await modDetails(Number(revisionPage.id));
      revisionPage.sidebarItems = await sidebarForPage(namespace, revisionPage.title, aclActor);
    revisionPage.recentRows = await recentChanges(15);
    await attachDiscussionChrome(revisionPage, user, aclActor);
    await attachSubwikiTheme(revisionPage, namespace);
    return reply.type('text/html').send(articlePage(revisionPage, user));
  }
    page.sidebarItems = await sidebarForPage(namespace, page.title, aclActor);
  page.recentRows = await recentChanges(15);
  page.sectionLocks = await sectionLocks(Number(page.id));
  await attachDiscussionChrome(page, user, aclActor);
  await attachSubwikiTheme(page, namespace);
  await recordPageView(page, request);
  return reply.type('text/html').send(articlePage(page, user));
}

async function renderCustomDomainWikiPage(request: any, reply: any, rawPath: string) {
  const aclActor = aclActorForRequest(request);
  const host = requestHost(request);
  if (!host) return false;
  const space = await one<any>(
    `SELECT ws.id, ws.code, ws.space_key, ws.name, ws.title, ws.slug, ws.space_type, ws.parent_space_id, ws.root_page_id, ws.root_namespace_code, ws.root_path, ws.description, ws.status, ws.created_by, ws.owner_user_id, ws.owner_page_id, ws.created_at, ws.updated_at FROM subwiki_settings ss
     JOIN wiki_spaces ws ON ws.id=ss.space_id
     WHERE ss.custom_domain=:host AND ws.status IN ('active','readonly','verification_expired')
     LIMIT 1`,
    { host }
  );
  if (!space) return false;
  const namespace = importNamespace(space);
  const queryString = String(request.url ?? '').includes('?') ? String(request.url).slice(String(request.url).indexOf('?')) : '';
  const toolPath = splitWikiToolPath(rawPath);
  const cleanPath = normalizeTitle(String(toolPath.basePath ?? '').replace(/^\/+|\/+$/g, ''));
  const title = customDomainPageTitle(space, cleanPath);
  if (toolPath.suffix) return reply.redirect(`${wikiUrl(namespace, title)}${toolPath.suffix}${queryString}`);
  const page = (await getPageByTitle(namespace, title)) ?? (cleanPath ? null : await getPageById(Number(space.root_page_id)));
  if (!page) {
    return reply.code(404).type('text/html').send(messagePage('문서 없음', '이 위키 문서를 찾을 수 없습니다.', request.user, { tone: 'error' }));
  }
  if (!(await canReadPageResource(aclActor, page))) {
    return reply.code(404).type('text/html').send(messagePage('문서 없음', '이 위키 문서를 찾을 수 없습니다.', request.user, { tone: 'error' }));
  }
  if (page.page_type === 'mod') page.modDetails = await modDetails(Number(page.id));
  page.sidebarItems = await sidebarForPage(namespace, page.title, aclActor);
  page.recentRows = await recentChanges(15);
  page.sectionLocks = await sectionLocks(Number(page.id));
  await attachDiscussionChrome(page, request.user, aclActor);
  await attachSubwikiTheme(page, namespace, Number(space.id));
  await recordPageView(page, request);
  return reply.type('text/html').send(articlePage(page, request.user));
}

function customDomainPageTitle(space: any, rawPath: string) {
  const slug = String(space.slug ?? '').trim();
  if (!rawPath) return space.space_type === 'mod_wiki' && slug ? `${slug}/대문` : slug || normalizeTitle(space.title ?? space.name ?? '대문');
  if (!['server_wiki', 'mod_wiki'].includes(String(space.space_type)) || !slug) return rawPath;
  return rawPath === slug || rawPath.startsWith(`${slug}/`) ? rawPath : `${slug}/${rawPath}`;
}

async function saveSpaceWikiPage(request: any, reply: any, namespace: NamespaceCode, rawPath: string) {
  if (rawPath.endsWith('/discussion')) {
    return createDiscussionFromWikiPath(request, reply, namespace, rawPath.replace(/\/discussion$/, ''));
  }
  if (rawPath.endsWith('/rollback')) {
    const title = normalizeTitle(rawPath.replace(/\/rollback$/, ''));
    const page = (await getPageByTitle(namespace, title)) ?? (await getPageByAlias(namespace, title));
    const user = request.user;
    const revisionId = nullablePositiveInt((request.body as any).revisionId);
    const pageHref = wikiUrl(namespace, title);
    if (!revisionId) return htmlError(reply, user, 400, '입력 오류', '되돌릴 리비전을 선택하세요.', `${pageHref}/history`, '판 기록');
    if (!page) return htmlError(reply, user, 404, '문서 없음', '문서를 찾을 수 없습니다.', '/wiki', '위키 대문');
    if (!(await aclDecision(user, 'revert', page)).allowed) return htmlError(reply, user, 403, '권한 없음', '보호된 문서입니다.', pageHref, '문서 보기');
    const rollbackRevision = await pageRevision(Number(page.id), revisionId, canViewRestrictedRevisions(user), canViewSuppressedRevisions(user));
    if (!rollbackRevision) return htmlError(reply, user, 404, '리비전 없음', '리비전을 찾을 수 없습니다.', `${pageHref}/history`, '판 기록');
    await assertLockedSectionsUnchanged(page, rollbackRevision.content_raw ?? '', user);
    await rollbackToRevision(Number(page.id), revisionId, user?.id ?? null);
    return reply.redirect(wikiUrl(namespace, page.title));
  }
  if (rawPath.endsWith('/acl')) {
    const title = normalizeTitle(rawPath.replace(/\/acl$/, ''));
    return handleAclPost(request, reply, namespace, title);
  }
  if (!rawPath.endsWith('/edit')) return htmlError(reply, request.user, 404, '문서 없음', '요청한 문서 작업을 찾을 수 없습니다.', '/wiki', '위키 대문');
  const title = normalizeTitle(rawPath.replace(/\/edit$/, ''));
  const body = request.body as any;
  const user = request.user;
  if (!user && !(await requireTurnstile(request, reply, 'anonymous_edit'))) return reply;
  const aclActor = aclActorForRequest(request);
  const content = limitedText(body.content, maxPageContentLength);
  if (content === null) return htmlError(reply, user, 413, '본문 초과', '문서 본문이 너무 깁니다.', `${wikiUrl(namespace, title)}/edit`, '편집으로 돌아가기');
  const page = (await getPageByTitle(namespace, title)) ?? (await getPageByAlias(namespace, title));
  const targetTitle = normalizeTitle(body.title ?? title);
  const userWikiEditTitle = namespace === 'main' && isUserWikiTitle(page?.title ?? title) ? String(page?.title ?? title) : '';
  if (userWikiEditTitle && normalizeTitle(targetTitle) !== normalizeTitle(userWikiEditTitle)) {
    return htmlError(reply, user, 403, '권한 없음', '사용자 문서 제목은 변경할 수 없습니다.', `${wikiUrl(namespace, title)}/edit`, '편집으로 돌아가기');
  }
  if ((userWikiEditTitle || (namespace === 'main' && isUserWikiTitle(targetTitle))) && !(await canEditUserWikiTitle(user, userWikiEditTitle || targetTitle))) {
    return htmlError(reply, user, 403, '권한 없음', '사용자 위키는 본인만 편집할 수 있습니다.', wikiUrl(namespace, title), '문서 보기');
  }
  const targetPage = targetTitle === title ? page : await getPageByTitle(namespace, targetTitle);
  const pageAccess = page ? await pageEditAccess(aclActor, page) : { allowed: true, forceReviewReason: null as string | null };
  const targetAccess = targetPage && targetPage.id !== page?.id ? await pageEditAccess(aclActor, targetPage) : { allowed: true, forceReviewReason: null as string | null };
  if (!pageAccess.allowed || !targetAccess.allowed) return htmlError(reply, user, 403, '권한 없음', '보호된 문서입니다.', wikiUrl(namespace, title), '문서 보기');
  const baseRevisionId = body.baseRevisionId ? nullablePositiveInt(body.baseRevisionId) : 0;
  if (body.baseRevisionId && !baseRevisionId) return htmlError(reply, user, 400, '입력 오류', '기준 리비전 값이 올바르지 않습니다.', `${wikiUrl(namespace, title)}/edit`, '편집으로 돌아가기');
  if (page && baseRevisionId && Number(page.current_revision_id) !== baseRevisionId) {
    return reply
      .code(409)
      .type('text/html')
      .send(
        editConflictPage(
          namespace,
          targetTitle,
          page.content_raw ?? '',
          content,
          user,
          normalizeSavedPageType(body.pageType) ?? page.page_type ?? '',
          page.current_revision_id ?? '',
          boundedText(body.summary, 255)
        )
      );
  }
  try {
    if (user) await enforceOpenBetaEditPolicy(user.id, content);
    const [newUserReason, subwikiPolicy] = await Promise.all([
      user ? newUserReviewReason(user.id) : Promise.resolve('비로그인 편집 검토'),
      subwikiEditPolicy(namespace, targetTitle, user)
    ]);
    if (!subwikiPolicy.allowed) return htmlError(reply, user, 403, '권한 없음', '이 위키는 공개 편집을 허용하지 않습니다.', wikiUrl(namespace, targetTitle), '문서 보기');
    const areaReview = normalizeDocumentArea(body.area) === 'review_required' ? '문서 영역: 검토 필요' : null;
    const forceReviewReason = [newUserReason, subwikiPolicy.forceReviewReason, pageAccess.forceReviewReason, targetAccess.forceReviewReason, areaReview].filter(Boolean).join(' / ') || null;
    if (page) await assertLockedSectionsUnchanged(page, content, user);
    if (targetPage && targetPage.id !== page?.id) await assertLockedSectionsUnchanged(targetPage, content, user);
    const saved = await savePage({
      namespace,
      title: targetTitle,
      displayTitle: namespace === 'main' ? userWikiDisplayTitle(targetTitle) : undefined,
      content,
      summary: boundedText(body.summary, 255) || undefined,
      userId: user?.id ?? null,
      actorIpText: user ? null : requestRemoteIp(request),
      pageType: normalizeSavedPageType(body.pageType),
      isMinor: parseBoolean(body.isMinor),
      forceReviewReason
    });
    if (saved.pending) {
      return reply
        .type('text/html')
        .send(messagePage('검토 대기', `이 편집은 운영자 검토 후 반영됩니다. 검토 번호: #${saved.pendingReviewId}`, user, { actionHref: wikiUrl(namespace, targetTitle), actionLabel: '문서로 돌아가기' }));
    }
  } catch (error: any) {
    return htmlError(reply, user, 400, '편집 오류', String(error.message ?? '편집을 저장할 수 없습니다.'), `${wikiUrl(namespace, title)}/edit`, '편집으로 돌아가기');
  }
  return reply.redirect(wikiUrl(namespace, targetTitle));
}

function xmlEscape(value: string) {
  return value.replace(/[<>&'"]/g, (char) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[char] ?? char);
}

async function publicAnnouncements(user: any) {
  const visibilities = user ? ['public', 'logged_in'] : ['public'];
  if (user?.groups?.some((group: string) => ['admin', 'moderator', 'developer'].includes(group))) visibilities.push('staff');
  return query<any>(
    `SELECT id, title, body, type, visibility, starts_at, ends_at
     FROM announcements
     WHERE visibility IN (:visibilities)
       AND (starts_at IS NULL OR starts_at <= NOW())
       AND (ends_at IS NULL OR ends_at >= NOW())
     ORDER BY FIELD(type,'incident','maintenance','policy','release','campaign','notice'), id DESC
     LIMIT 10`,
    { visibilities }
  );
}

async function discussionThreadsForPage(pageId: number) {
  return query<any>(
    `SELECT dt.id, dt.page_id, dt.title, dt.status, dt.created_by, dt.created_at, dt.updated_at,
       COALESCE(u.display_name, u.username, '익명') AS actor_name,
       COUNT(dc.id) AS comment_count
     FROM discussion_threads dt
     LEFT JOIN users u ON u.id=dt.created_by
     LEFT JOIN discussion_comments dc ON dc.thread_id=dt.id AND dc.visibility='public'
     WHERE dt.page_id=:pageId AND dt.status!='hidden'
     GROUP BY dt.id, dt.page_id, dt.title, dt.status, dt.created_by, dt.created_at, dt.updated_at, u.display_name, u.username
     ORDER BY FIELD(dt.status,'open','resolved','locked'), dt.updated_at DESC
     LIMIT 30`,
    { pageId }
  );
}

async function discussionCommentsForThreads(threadIds: number[]) {
  if (!threadIds.length) return new Map<number, any[]>();
  const comments = await query<any>(
    `SELECT dc.id, dc.thread_id, dc.parent_id, dc.created_by, dc.body, dc.visibility, dc.created_at, dc.updated_at,
       COALESCE(u.display_name, u.username, '익명') AS actor_name
     FROM discussion_comments dc
     LEFT JOIN users u ON u.id=dc.created_by
     WHERE dc.thread_id IN (:threadIds) AND dc.visibility='public'
     ORDER BY COALESCE(dc.parent_id, dc.id), dc.id`,
    { threadIds }
  );
  const grouped = new Map<number, any[]>();
  for (const comment of comments) {
    const threadId = Number(comment.thread_id);
    const group = grouped.get(threadId) ?? [];
    group.push(comment);
    grouped.set(threadId, group);
  }
  return grouped;
}

async function attachDiscussionChrome(page: any, user: any, aclActor: any) {
  if (!page?.id) return page;
  const [threads, createDecision, writeDecision, watchRow] = await Promise.all([
    discussionThreadsForPage(Number(page.id)),
    aclDecision(aclActor, 'create_thread', page),
    aclDecision(aclActor, 'write_thread_comment', page),
    user?.id ? one<any>(`SELECT watch_discussion FROM watched_pages WHERE user_id=:userId AND page_id=:pageId`, { userId: user.id, pageId: Number(page.id) }) : null
  ]);
  const commentsByThread = await discussionCommentsForThreads(threads.map((thread: any) => Number(thread.id)));
  page.discussionThreads = threads.map((thread: any) => ({
    ...thread,
    comments: commentsByThread.get(Number(thread.id)) ?? []
  }));
  page.canCreateDiscussion = Boolean(createDecision.allowed);
  page.canWriteDiscussion = Boolean(writeDecision.allowed);
  page.is_watched = Boolean(watchRow);
  page.watch_discussion = watchRow ? Number(watchRow.watch_discussion) === 1 : false;
  return page;
}

async function documentTemplatesForSpace(spaceId: number | null, targetType: 'basic' | 'mod_wiki' | 'server_wiki' | 'developer' = 'basic') {
  const targetHints: Record<string, string[]> = {
    basic: ['global', 'basic'],
    mod_wiki: ['global', 'mod_wiki'],
    server_wiki: ['global', 'server_wiki'],
    developer: ['global', 'developer']
  };
  return query<any>(
    `SELECT id, space_id, template_key, title, description, template_scope, target_area, default_category
     FROM document_templates
     WHERE status='active'
       AND (
         template_scope='global'
         OR (:spaceId IS NOT NULL AND space_id=:spaceId)
         OR (space_id IS NULL AND template_key IN (:keys))
       )
     ORDER BY template_scope='global' DESC, COALESCE(space_id,0), title
     LIMIT 80`,
    { spaceId, keys: targetHints[targetType] ?? ['global'] }
  );
}

async function starterSetsForType(targetType: 'mod_wiki' | 'server_wiki' | 'developer' | 'basic') {
  return query<any>(
    `SELECT set_key, title, description
     FROM starter_sets
     WHERE target_space_type=:targetType AND status='active'
     ORDER BY id`,
    { targetType }
  );
}

async function starterDocuments(setKey: string, targetType: 'mod_wiki' | 'server_wiki') {
  const rows = await query<any>(
    `SELECT ssi.local_path, ssi.title, ssi.area, dt.content_raw
     FROM starter_sets ss
     JOIN starter_set_items ssi ON ssi.starter_set_id=ss.id
     LEFT JOIN document_templates dt ON dt.id=ssi.template_id AND dt.status='active'
     WHERE ss.set_key=:setKey AND ss.target_space_type=:targetType AND ss.status='active'
     ORDER BY ssi.sort_order, ssi.id`,
    { setKey, targetType }
  );
  if (rows.length) {
    return rows.map((row) => ({
      title: normalizeTitle(String(row.local_path || row.title)),
      area: row.area,
      content: row.content_raw ? String(row.content_raw).replaceAll('{{문서명}}', String(row.title || row.local_path)) : ''
    }));
  }
  const fallback = targetType === 'server_wiki'
    ? {
        'server-economy': ['접속', '규칙', '경제', '직업', '상점', '후원 정책', '제재 기준', 'FAQ'],
        'server-rpg': ['접속', '규칙', '직업', '퀘스트', '아이템', '지역', '보스', 'FAQ'],
        'server-custom': []
      }[setKey] ?? ['접속', '규칙', '공지', '초보자 가이드', 'FAQ']
    : {
        'mod-systems': ['시작하기', '기본 시스템', '아이템', '블록', '레시피', '문제 해결'],
        'mod-optimization': ['설치', '설정', '호환성', '문제 해결', '성능 비교'],
        'mod-custom': []
      }[setKey] ?? ['설치', '설정', '문제 해결'];
  return fallback.map((title) => ({ title, area: 'default', content: '' }));
}

async function createDocumentTemplate(spaceId: number | null, body: any, userId: number, defaultScope: 'global' | 'space' | 'user') {
  const title = normalizeTitle(String(body.title ?? '').trim());
  if (!title) throw new Error('template_title_required');
  const templateKey = normalizeTemplateKey(body.templateKey || title);
  const requestedScope = normalizeTemplateScope(body.templateScope);
  const allowedScopes = defaultScope === 'global' ? ['global', 'user'] : defaultScope === 'space' ? ['space', 'user'] : ['user'];
  const scope = requestedScope && allowedScopes.includes(requestedScope) ? requestedScope : defaultScope;
  const targetArea = normalizeTemplateArea(body.targetArea) ?? 'any';
  const content = limitedText(String(body.content ?? '').trim(), maxPageContentLength);
  if (!content) throw new Error('template_content_required');
  await exec(
    `INSERT INTO document_templates (space_id, template_key, title, description, template_scope, target_area, default_category, content_raw, created_by, status, created_at, updated_at)
     VALUES (:spaceId, :templateKey, :title, :description, :scope, :targetArea, :defaultCategory, :content, :userId, 'active', NOW(), NOW())
     ON DUPLICATE KEY UPDATE title=VALUES(title), description=VALUES(description), template_scope=VALUES(template_scope),
       target_area=VALUES(target_area), default_category=VALUES(default_category), content_raw=VALUES(content_raw), status='active', updated_at=NOW()`,
    {
      spaceId: scope === 'global' ? null : spaceId,
      templateKey,
      title,
      description: emptyToNull(body.description),
      scope,
      targetArea,
      defaultCategory: emptyToNull(body.defaultCategory),
      content,
      userId
    }
  );
}

async function templateContent(templateRef: unknown, title: string, namespace: NamespaceCode) {
  const ref = String(templateRef ?? '').trim();
  if (!ref) return '';
  const template = /^\d+$/.test(ref)
    ? await one<any>(`SELECT ${documentTemplateFields} FROM document_templates WHERE id=:id AND status='active'`, { id: Number(ref) })
    : await one<any>(
        `SELECT ${documentTemplateFields} FROM document_templates
         WHERE template_key=:key AND status='active'
         ORDER BY template_scope='global' DESC, id DESC
         LIMIT 1`,
        { key: ref }
      );
  if (!template) return '';
  const content = String(template.content_raw ?? '').replaceAll('{{문서명}}', title || '새 문서');
  const category = String(template.default_category ?? '').trim();
  const official = namespace === 'server' && template.target_area === 'official' ? `\n{{공식 영역\n|문서=서버:${title}\n}}\n` : '';
  return `${official}${content}${category ? `\n\n[[분류:${category}]]\n` : ''}`;
}

function normalizeTemplateKey(value: unknown) {
  const key = String(value ?? '')
    .trim()
    .replace(/\s+/g, '_')
    .replace(/[^\w가-힣._-]/g, '')
    .slice(0, 128);
  return key || `template_${Date.now()}`;
}

function normalizeTemplateScope(value: unknown) {
  const scope = String(value ?? '').trim();
  return ['global', 'space', 'user'].includes(scope) ? scope as 'global' | 'space' | 'user' : null;
}

function normalizeTemplateArea(value: unknown) {
  const area = String(value ?? '').trim();
  return ['any', 'official', 'community', 'review_required'].includes(area) ? area : null;
}

function normalizeDocumentArea(value: unknown) {
  const area = String(value ?? '').trim();
  return ['official', 'community', 'review_required'].includes(area) ? area : null;
}

async function sidebarForPage(namespace: NamespaceCode, title: string, user: any = null) {
  const root = title.split('/')[0];
  if (namespace === 'dev') {
    const rows = await query<any>(
      `SELECT p.id AS page_id, p.id, p.space_id, p.protection_level, p.status, n.code AS namespace_code, p.display_title AS label, p.title AS target_title, p.title, p.local_path
       FROM pages p
       JOIN namespaces n ON n.id=p.namespace_id
       WHERE n.code='dev' AND p.status NOT IN ('deleted','hidden')
       ORDER BY p.local_path='대문' DESC, SUBSTRING_INDEX(p.local_path, '/', 1), p.local_path
       LIMIT 120`
    );
    return filterSidebarItemsForAcl(rows, user);
  }
  if (!root || !['server', 'mod'].includes(namespace)) return [];
  const code = `${namespace}-${root}`;
  const rows = await query<any>(
    `SELECT si.id, si.parent_id, si.label, si.target_title,
            p.id AS resolved_page_id, si.page_id, p.space_id, p.protection_level, p.status, n.code AS namespace_code, p.title, p.display_title
     FROM subwiki_sidebar_items si
     JOIN wiki_spaces ws ON ws.id=si.space_id
     LEFT JOIN namespaces root_n ON root_n.code=:namespace
     LEFT JOIN pages p ON p.id=si.page_id OR (si.page_id IS NULL AND p.namespace_id=root_n.id AND p.title=si.target_title)
     LEFT JOIN namespaces n ON n.id=p.namespace_id
     WHERE ws.code=:code
     ORDER BY si.sort_order, si.id
     LIMIT 80`,
    { code, namespace }
  );
  return filterSidebarItemsForAcl(rows, user);
}

async function filterSidebarItemsForAcl(rows: any[], user: any) {
  const filtered = [];
  for (const row of rows) {
    const pageId = row.resolved_page_id ?? row.page_id;
    if (pageId && !(await canReadPageResource(user, { ...row, id: pageId }))) continue;
    filtered.push({ ...row, target_url: normalizeSidebarTargetUrl(row.target_url) });
  }
  return filtered.map(({ resolved_page_id, space_id, protection_level, status, namespace_code, title, display_title, ...row }) => row);
}

function publicSpacePayload(space: any) {
  return {
    id: Number(space.id),
    code: space.code,
    space_key: space.space_key,
    name: space.name,
    title: space.title,
    slug: space.slug,
    space_type: space.space_type,
    root_path: space.root_path,
    description: space.description,
    status: space.status,
    updated_at: space.updated_at
  };
}

function escapePage(value: string) {
  return value.replace(/[&<>"']/g, (char) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[char]!));
}

async function createServerSubwiki(body: any, userId: number | null) {
  const slug = normalizeServerSubwikiSlug(body.slug ?? body.title ?? '');
  if (!slug) throw new Error('server_slug_required');
  const title = normalizeTitle(body.title ?? slug);
  const host = normalizeServerHost(body.host);
  const port = normalizeServerPort(body.port ?? body.host);
  const rootPage = appliedPage(await savePage({
    namespace: 'server',
    title: slug,
    content: `{{서버 정보
|이름=${title}
|주소=${host ?? ''}
|에디션=${body.edition ?? 'Java Edition'}
|지원 버전=${body.supportedVersions ?? '문서 참조'}
|장르=${body.genres ?? '문서 참조'}
|인증=미인증
|화이트리스트=${body.whitelist ?? '문서 참조'}
|상태 확인=${host ? '사용' : '미사용'}
}}

'''${title}''' 서버 공식 위키 대문이다.

== 바로가기 ==
* [[서버:${slug}/접속 방법|접속 방법]]
* [[서버:${slug}/규칙|규칙]]
* [[서버:${slug}/공지|공지]]

[[분류:서버]]
[[분류:인증 대기 서버]]`,
    summary: '서버 공식 위키 대문 생성',
    userId,
    pageType: 'server'
  }));
  await addPageAlias('server', title, rootPage.pageId, 'alias');
  if (host) await addPageAlias('server', host, rootPage.pageId, 'alias');
  if (body.aliases) {
    for (const alias of String(body.aliases).split(',').map((item) => item.trim()).filter(Boolean)) {
      await addPageAlias('server', alias, rootPage.pageId, 'alias');
    }
  }
  const parent = await one<any>(`SELECT id FROM wiki_spaces WHERE code='server'`);
  await exec(
    `INSERT INTO wiki_spaces (code, space_key, name, title, slug, space_type, parent_space_id, root_page_id, root_namespace_code, root_path, description, status, created_by, owner_user_id, created_at, updated_at)
     VALUES (:code, :code, :name, :name, :slug, 'server_wiki', :parentId, :rootPageId, 'server', :rootPath, :description, 'active', :userId, :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE title=VALUES(title), root_page_id=VALUES(root_page_id), status='active', updated_at=NOW()`,
    { code: `server-${slug}`, name: title, slug, parentId: parent?.id ?? null, rootPageId: rootPage.pageId, rootPath: `/server/${slug}`, description: `${title} 공식 서버 위키`, userId }
  );
  const space = await one<any>(`SELECT id FROM wiki_spaces WHERE code=:code`, { code: `server-${slug}` });
  await exec(
    `INSERT INTO server_wikis (space_id, server_name, slug, host, port, edition, supported_versions, genres, verified_status, status, created_by, created_at, updated_at)
     VALUES (:spaceId, :serverName, :slug, :host, :port, :edition, :supportedVersions, :genres, 'pending', 'active', :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE space_id=VALUES(space_id), server_name=VALUES(server_name), host=VALUES(host), port=VALUES(port), edition=VALUES(edition),
       supported_versions=VALUES(supported_versions), genres=VALUES(genres), status='active', updated_at=NOW()`,
    {
      spaceId: space.id,
      serverName: title,
      slug,
      host,
      port,
      edition: ['java', 'bedrock', 'crossplay', 'unknown'].includes(String(body.edition ?? '')) ? body.edition : 'unknown',
      supportedVersions: body.supportedVersions ?? null,
      genres: body.genres ?? null,
      userId
    }
  );
  await exec(
    `INSERT INTO entity_servers (page_id, name, host, edition, supported_versions, genres, verified_status, operational_status, status_enabled, updated_at)
     VALUES (:pageId, :name, :host, :edition, :supportedVersions, :genres, 'pending', 'unverified', :statusEnabled, NOW())
     ON DUPLICATE KEY UPDATE name=VALUES(name), host=VALUES(host), edition=VALUES(edition), supported_versions=VALUES(supported_versions), genres=VALUES(genres), status_enabled=VALUES(status_enabled), updated_at=NOW()`,
    {
      pageId: rootPage.pageId,
      name: title,
      host,
      edition: ['java', 'bedrock', 'crossplay', 'unknown'].includes(String(body.edition ?? '')) ? body.edition : 'unknown',
      supportedVersions: body.supportedVersions ?? null,
      genres: body.genres ?? null,
      statusEnabled: host ? 1 : 0
    }
  );
  await exec(
    `INSERT INTO subwiki_settings (space_id, main_page_id, home_title, short_path, allow_public_edit, public_edit_enabled, require_review, review_required, created_at, updated_at)
     VALUES (:spaceId, :rootPageId, '대문', :shortPath, 0, 0, 1, 1, NOW(), NOW())
     ON DUPLICATE KEY UPDATE main_page_id=VALUES(main_page_id), short_path=VALUES(short_path), updated_at=NOW()`,
    { spaceId: space.id, rootPageId: rootPage.pageId, shortPath: `/server/${slug}` }
  );
  if (userId) {
    await exec(
      `INSERT INTO subwiki_roles (space_id, user_id, role, status, granted_by, granted_at)
       VALUES (:spaceId, :userId, 'owner', 'active', :userId, NOW())
       ON DUPLICATE KEY UPDATE status='active', revoked_at=NULL`,
      { spaceId: space.id, userId }
    );
  }
  const docs = await starterDocuments(String(body.starterSet ?? 'server-basic'), 'server_wiki');
  let sort = 10;
  for (const item of docs) {
    const doc = item.title;
    const page = appliedPage(await savePage({
      namespace: 'server',
      title: `${slug}/${doc}`,
      content: item.content || `{{문서 상태
|기준=서버 공식 위키
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''${title} ${doc}''' 문서이다.

== 내용 ==
서버 운영자가 공식 정보를 작성한다.

[[분류:서버]]
[[분류:서버 공식 위키]]`,
      summary: '서버 공식 위키 기본 문서 생성',
      userId,
      pageType: 'server'
    }));
    await exec(
      `INSERT INTO subwiki_sidebar_items (space_id, page_id, label, target_title, sort_order, created_at, updated_at)
       VALUES (:spaceId, :pageId, :label, :targetTitle, :sortOrder, NOW(), NOW())
       ON DUPLICATE KEY UPDATE page_id=VALUES(page_id), target_title=VALUES(target_title), updated_at=NOW()`,
      { spaceId: space.id, pageId: page.pageId, label: doc, targetTitle: `${slug}/${doc}`, sortOrder: sort }
    );
    sort += 10;
  }
  await exec(
    `INSERT INTO subwiki_lifecycle_logs (space_id, old_status, new_status, reason, changed_by, created_at)
     VALUES (:spaceId, NULL, 'active', '서버 공식 위키 생성', :userId, NOW())`,
    { spaceId: space.id, userId }
  );
  await syncPageSpaces();
  return { ok: true, spaceId: Number(space.id), slug, rootPageId: rootPage.pageId };
}

function formListValue(value: unknown) {
  if (Array.isArray(value)) {
    return value.map((item) => String(item).trim()).filter(Boolean).join(', ');
  }
  return String(value ?? '').trim();
}

async function createModSubwiki(body: any, userId: number | null) {
  const slug = String(body.slug ?? body.title ?? '').trim().replace(/\s+/g, '_');
  if (!/^[A-Za-z0-9._-]{2,64}$/.test(slug)) throw new Error('mod_slug_required');
  const title = normalizeTitle(body.title ?? slug);
  const loaders = formListValue(body.loader);
  const clientRequired = String(body.clientRequired ?? '').trim() || 'unknown';
  const serverRequired = String(body.serverRequired ?? '').trim() || 'unknown';
  const rootPage = appliedPage(await savePage({
    namespace: 'mod',
    title: `${slug}/대문`,
    content: `{{문서 상태
|기준=모드 위키
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

{{모드 정보
|이름=${title}
|영문=${title}
|분류=${body.category ?? '대형 모드'}
|로더=${loaders || '문서 참조'}
|지원 버전=${body.supportedVersions ?? '문서 참조'}
|클라이언트 필요=${clientRequired}
|서버 필요=${serverRequired}
|공식 링크=${body.officialLink ?? '문서 참조'}
|라이선스=${body.license ?? '확인 필요'}
}}

'''${title}''' 모드 위키 대문이다.

[[분류:모드]]
[[분류:모드 위키]]`,
    summary: '모드 위키 대문 생성',
    userId,
    pageType: 'mod'
  }));
  await addPageAlias('mod', slug, rootPage.pageId, 'alias');
  if (title !== slug) await addPageAlias('mod', title, rootPage.pageId, 'alias');
  const parent = await one<any>(`SELECT id FROM wiki_spaces WHERE code='mod'`);
  await exec(
    `INSERT INTO wiki_spaces (code, space_key, name, title, slug, space_type, parent_space_id, root_page_id, root_namespace_code, root_path, description, status, created_by, created_at, updated_at)
     VALUES (:code, :code, :name, :name, :slug, 'mod_wiki', :parentId, :rootPageId, 'mod', :rootPath, :description, 'active', :userId, NOW(), NOW())
     ON DUPLICATE KEY UPDATE title=VALUES(title), root_page_id=VALUES(root_page_id), status='active', updated_at=NOW()`,
    { code: `mod-${slug}`, name: title, slug, parentId: parent?.id ?? null, rootPageId: rootPage.pageId, rootPath: `/mod/${slug}`, description: `${title} 전용 모드 위키`, userId }
  );
  const space = await one<any>(`SELECT id FROM wiki_spaces WHERE code=:code`, { code: `mod-${slug}` });
  await exec(
    `INSERT INTO mod_wikis (space_id, mod_name, category, slug, loaders, supported_versions, official_url, source_url, license, creator_verified, verified_by, verified_at, status, created_at, updated_at)
     VALUES (:spaceId, :modName, :category, :slug, :loaders, :supportedVersions, :officialUrl, :sourceUrl, :license, :creatorVerified, :verifiedBy, IF(:creatorVerified=1, NOW(), NULL), 'needs_check', NOW(), NOW())
     ON DUPLICATE KEY UPDATE space_id=VALUES(space_id), mod_name=VALUES(mod_name), category=VALUES(category), loaders=VALUES(loaders),
       supported_versions=VALUES(supported_versions), official_url=VALUES(official_url), source_url=VALUES(source_url), license=VALUES(license),
       creator_verified=VALUES(creator_verified), verified_by=VALUES(verified_by), verified_at=VALUES(verified_at), updated_at=NOW()`,
    {
      spaceId: space.id,
      modName: title,
      category: body.category ?? null,
      slug,
      loaders: loaders || null,
      supportedVersions: body.supportedVersions ?? null,
      officialUrl: normalizeOptionalHttpUrl(body.officialLink),
      sourceUrl: normalizeOptionalHttpUrl(body.sourceUrl),
      license: body.license ?? null,
      creatorVerified: body.creatorVerified === true || body.creatorVerified === '1' || body.creatorVerified === 'true' ? 1 : 0,
      verifiedBy: userId
    }
  );
  await exec(
    `INSERT INTO subwiki_settings (space_id, main_page_id, home_title, short_path, allow_public_edit, public_edit_enabled, require_review, review_required, created_at, updated_at)
     VALUES (:spaceId, :rootPageId, '대문', :shortPath, 1, 1, 0, 0, NOW(), NOW())
     ON DUPLICATE KEY UPDATE main_page_id=VALUES(main_page_id), short_path=VALUES(short_path), updated_at=NOW()`,
    { spaceId: space.id, rootPageId: rootPage.pageId, shortPath: `/mod/${slug}` }
  );
  if (userId) {
    await exec(
      `INSERT INTO subwiki_roles (space_id, user_id, role, status, granted_by, granted_at)
       VALUES (:spaceId, :userId, 'owner', 'active', :userId, NOW())
       ON DUPLICATE KEY UPDATE status='active', granted_at=NOW(), revoked_at=NULL, revoked_by=NULL`,
      { spaceId: space.id, userId }
    );
  }
  const docs = await starterDocuments(String(body.starterSet ?? 'mod-minimal'), 'mod_wiki');
  let sort = 10;
  for (const item of docs) {
    const doc = item.title;
    const page = appliedPage(await savePage({
      namespace: 'mod',
      title: `${slug}/${doc}`,
      content: item.content || `{{문서 상태
|기준=모드 위키
|상태=검증 필요
|확인일=2026.05.23. 16:04
}}

'''${title} ${doc}''' 문서이다.

[[분류:모드]]
[[분류:모드 위키]]`,
      summary: '모드 위키 기본 문서 생성',
      userId,
      pageType: 'mod'
    }));
    await exec(
      `INSERT INTO subwiki_sidebar_items (space_id, page_id, label, target_title, sort_order, created_at, updated_at)
       VALUES (:spaceId, :pageId, :label, :targetTitle, :sortOrder, NOW(), NOW())`,
      { spaceId: space.id, pageId: page.pageId, label: doc, targetTitle: `${slug}/${doc}`, sortOrder: sort }
    );
    sort += 10;
  }
  await exec(
    `INSERT INTO subwiki_lifecycle_logs (space_id, old_status, new_status, reason, changed_by, created_at)
     VALUES (:spaceId, NULL, 'active', '모드 위키 생성', :userId, NOW())`,
    { spaceId: space.id, userId }
  );
  await syncPageSpaces();
  return { ok: true, spaceId: Number(space.id), slug, rootPageId: rootPage.pageId };
}

async function exportSubwiki(spaceId: number, namespace: NamespaceCode, titleLike: string, actor: any) {
  const [space, pages] = await Promise.all([
    one<any>(`SELECT id, code, space_key, name, title, slug, root_path, description, status, created_at, updated_at FROM wiki_spaces WHERE id=:spaceId`, { spaceId }),
    query<any>(
      `SELECT p.id, p.space_id, p.protection_level, n.code AS namespace_code, p.title, p.display_title, p.slug, p.page_type, p.status, p.created_at, p.updated_at, r.revision_no, r.content_raw
     FROM pages p
     JOIN namespaces n ON n.id=p.namespace_id
     LEFT JOIN page_revisions r ON r.id=p.current_revision_id
     WHERE n.code=:namespace AND p.title LIKE :titleLike AND p.status NOT IN ('deleted','hidden')
     ORDER BY p.title`,
      { namespace, titleLike }
    )
  ]);
  const visiblePages = [];
  for (const page of pages) {
    if (await canReadPageResource(actor, page)) visiblePages.push(page);
  }
  const sidebar = await query<any>(
    `SELECT si.id, si.parent_id, si.page_id, si.label, si.target_title, si.target_url, si.sort_order,
            p.id AS resolved_page_id, p.space_id, p.protection_level, p.status, n.code AS namespace_code, p.title, p.display_title
     FROM subwiki_sidebar_items si
     LEFT JOIN namespaces root_n ON root_n.code=:namespace
     LEFT JOIN pages p ON p.id=si.page_id OR (si.page_id IS NULL AND p.namespace_id=root_n.id AND p.title=si.target_title)
     LEFT JOIN namespaces n ON n.id=p.namespace_id
     WHERE si.space_id=:spaceId
     ORDER BY si.sort_order, si.id`,
    { spaceId, namespace }
  );
  const files = await query<any>(
    `SELECT DISTINCT f.id, f.original_name, f.storage_key, f.mime_type, f.size_bytes, f.sha256, f.license, f.source_url
     FROM files f JOIN file_usages fu ON fu.file_id=f.id
     WHERE fu.page_id IN (${visiblePages.length ? visiblePages.map((_, index) => `:p${index}`).join(',') : '0'})
     ORDER BY f.id`,
    Object.fromEntries(visiblePages.map((page, index) => [`p${index}`, page.id]))
  );
  const exportSidebar = await filterSidebarItemsForAcl(sidebar, actor);
  return {
    generatedAt: new Date().toISOString(),
    format: ['markdown', 'document_tree_json', 'sidebar_json', 'file_list'],
    space,
    markdown: visiblePages.map((page) => ({ title: page.title, body: page.content_raw ?? '' })),
    tree: visiblePages.map((page) => ({
      id: page.id,
      title: page.title,
      displayTitle: page.display_title,
      slug: page.slug,
      pageType: page.page_type,
      revisionNo: page.revision_no,
      createdAt: page.created_at,
      updatedAt: page.updated_at
    })),
    sidebar: exportSidebar,
    files
  };
}

async function gitbookImportJob(id: number) {
  return one<any>(
    `SELECT gij.id, gij.space_id, gij.requested_by, gij.source_type, gij.status, gij.imported_pages,
            gij.source_note, gij.mapping_json, gij.error_message, gij.created_at, gij.updated_at,
            ws.code AS space_code, ws.title AS space_title, ws.slug AS space_slug, ws.space_type, ws.root_namespace_code, ws.root_path
     FROM gitbook_import_jobs gij
     JOIN wiki_spaces ws ON ws.id=gij.space_id
     WHERE gij.id=:id`,
    { id }
  );
}

async function runGitbookImport(job: any, payload: any, actorId: number | null) {
  await exec(`UPDATE gitbook_import_jobs SET status='mapping', error_message=NULL, updated_at=NOW() WHERE id=:id`, { id: job.id });
  const mapping = parseImportJson(job.mapping_json);
  const importPayload = { ...mapping, ...(payload ?? {}) };
  const documents = importDocumentsFromPayload(importPayload);
  if (documents.length === 0) throw new Error('import_documents_required');
  const checklist = importChecklist(documents, importPayload);
  const namespace = importNamespace(job);
  const imported: Array<{ pageId: number; title: string; sourceTitle: string }> = [];
  let sortOrder = await nextSidebarSort(Number(job.space_id));
  for (const [index, document] of documents.entries()) {
    const title = importedPageTitle(job, document.title);
    const content = markdownToWikiMarkup(document.content, document.title, job.space_type);
    const page = appliedPage(await savePage({
      namespace,
      title,
      content,
      summary: `GitBook/Markdown 이전: ${document.title}`,
      userId: actorId,
      pageType: namespace === 'server' ? 'server' : namespace === 'mod' ? 'mod' : 'article',
      skipReview: true
    }));
    await upsertSidebarItem(Number(job.space_id), page.pageId, document.label ?? document.title.split('/').pop() ?? document.title, title, document.sortOrder ?? sortOrder + index * 10);
    imported.push({ pageId: page.pageId, title, sourceTitle: document.title });
  }
  await exec(
    `UPDATE gitbook_import_jobs
     SET status='completed', imported_pages=:count, mapping_json=:mapping, error_message=NULL, updated_at=NOW()
     WHERE id=:id`,
    { id: job.id, count: imported.length, mapping: JSON.stringify({ ...mapping, imported, checklist }) }
  );
  await exec(`UPDATE admin_work_items SET status='done', updated_at=NOW() WHERE work_type='gitbook_import' AND target_id=:id`, { id: job.id });
  return { importedPages: imported.length, imported };
}

function parseImportJson(value: unknown) {
  if (!value) return {};
  if (typeof value === 'object') return value as Record<string, unknown>;
  try {
    return JSON.parse(String(value));
  } catch {
    return {};
  }
}

type ImportDocument = { title: string; label?: string; content: string; sortOrder?: number };

const importLimits = {
  maxDocuments: 200,
  maxArchiveEntries: 1000,
  maxImportPathLength: 500,
  maxMarkdownBytes: 1024 * 1024,
  maxTotalMarkdownBytes: 8 * 1024 * 1024
};

function normalizeGitbookImportPayload(payload: any) {
  const source = payload && typeof payload === 'object' && !Array.isArray(payload) ? payload : {};
  const markdown = limitedText(source.markdown ?? source.markdownBundle ?? '', importLimits.maxTotalMarkdownBytes);
  const summary = limitedText(source.summary ?? source.summaryMarkdown ?? '', importLimits.maxMarkdownBytes);
  if (markdown === null || summary === null) return null;
  const sourceDocuments = Array.isArray(source.documents) ? source.documents : null;
  if (sourceDocuments && sourceDocuments.length > importLimits.maxDocuments) return null;
  const documents = Array.isArray(source.documents)
    ? source.documents.map((document: any) => {
        const content = limitedText(document?.content ?? document?.body ?? document?.markdown ?? '', importLimits.maxMarkdownBytes);
        if (content === null) return null;
        return {
          title: boundedText(document?.title ?? document?.path ?? document?.name, 255),
          path: boundedText(document?.path, 500),
          label: boundedText(document?.label, 255),
          content,
          sortOrder: boundedUnsignedInt(document?.sortOrder, 1_000_000) ?? undefined
        };
      })
    : undefined;
  if (documents?.some((document: any) => document === null)) return null;
  const normalized: Record<string, unknown> = {};
  if (String(markdown).trim()) normalized.markdown = String(markdown).trim();
  if (String(summary).trim()) normalized.summary = String(summary).trim();
  if (documents) normalized.documents = documents;
  return boundedJsonString(normalized, importLimits.maxTotalMarkdownBytes + 50_000) ? normalized : null;
}

async function gitbookImportRequestBody(request: any) {
  if (!request.isMultipart?.()) return request.body as any;
  const body: Record<string, any> = { documents: [] };
  let totalMarkdownBytes = 0;
  for await (const part of request.parts()) {
    if (part.type !== 'file') {
      const value = limitedText(part.value, importLimits.maxMarkdownBytes);
      if (value === null) throw new Error('import_field_too_large');
      body[part.fieldname] = value;
      continue;
    }
    if (part.fieldname !== 'archive' || !part.filename) continue;
    const buffer = await part.toBuffer();
    const filename = String(part.filename);
    if (filename.length > importLimits.maxImportPathLength) throw new Error('import_filename_too_long');
    if (/\.zip$/i.test(filename)) {
      const entries = new AdmZip(buffer).getEntries();
      if (entries.length > importLimits.maxArchiveEntries) throw new Error('import_archive_too_many_entries');
      for (const entry of entries) {
        if (entry.entryName.length > importLimits.maxImportPathLength) throw new Error('import_filename_too_long');
        if (entry.isDirectory || !/\.(md|markdown)$/i.test(entry.entryName)) continue;
        if (body.documents.length >= importLimits.maxDocuments) throw new Error('import_too_many_documents');
        const entrySize = Number(entry.header?.size ?? 0);
        if (entrySize > importLimits.maxMarkdownBytes) throw new Error('import_document_too_large');
        totalMarkdownBytes += entrySize;
        if (totalMarkdownBytes > importLimits.maxTotalMarkdownBytes) throw new Error('import_archive_too_large');
        const content = entry.getData().toString('utf8');
        if (/(^|\/)summary\.md$/i.test(entry.entryName)) body.summary = body.summary || content;
        else body.documents.push({ path: entry.entryName, content });
      }
    } else if (/\.(md|markdown)$/i.test(filename)) {
      if (buffer.length > importLimits.maxMarkdownBytes) throw new Error('import_document_too_large');
      totalMarkdownBytes += buffer.length;
      if (totalMarkdownBytes > importLimits.maxTotalMarkdownBytes) throw new Error('import_archive_too_large');
      const content = buffer.toString('utf8');
      if (/summary\.md$/i.test(filename)) body.summary = body.summary || content;
      else body.documents.push({ path: filename, content });
    }
  }
  return body;
}

function importDocumentsFromPayload(payload: Record<string, any>): ImportDocument[] {
  const direct = Array.isArray(payload.documents) ? payload.documents : Array.isArray(payload.files) ? payload.files : [];
  if (direct.length > importLimits.maxDocuments) throw new Error('import_too_many_documents');
  const summaryByPath = new Map(summaryEntriesFromPayload(payload).map((entry) => [entry.path, entry]));
  const documents = direct
    .map((item: any, index: number) => normalizeImportDocument(item, index))
    .map((document: ImportDocument | null) => applySummaryEntry(document, summaryByPath))
    .filter((item: ImportDocument | null): item is ImportDocument => Boolean(item));
  if (documents.length > 0) return validateImportDocuments(sortImportDocuments(documents));
  const markdown = String(payload.markdown ?? payload.markdownBundle ?? '').trim();
  if (!markdown) return [];
  if (Buffer.byteLength(markdown, 'utf8') > importLimits.maxTotalMarkdownBytes) throw new Error('import_archive_too_large');
  const parsed = parseImportJson(markdown);
  if (Array.isArray((parsed as any).documents) || Array.isArray((parsed as any).files)) return importDocumentsFromPayload(parsed as Record<string, any>);
  return validateImportDocuments(sortImportDocuments(splitMarkdownBundle(markdown).map((document) => applySummaryEntry(document, summaryByPath)).filter((item: ImportDocument | null): item is ImportDocument => Boolean(item))));
}

function normalizeImportDocument(item: any, index: number): ImportDocument | null {
  const sourceTitle = String(item.title ?? item.path ?? item.name ?? '').replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '');
  const content = String(item.content ?? item.body ?? item.markdown ?? '').trim();
  if (!sourceTitle || !content || /(^|\/)summary$/i.test(sourceTitle)) return null;
  return {
    title: normalizeTitle(sourceTitle.replace(/(^|\/)(readme|index)$/i, '$1대문')),
    label: item.label ? normalizeTitle(item.label) : undefined,
    content,
    sortOrder: boundedUnsignedInt(item.sortOrder, 1_000_000) ?? (index + 1) * 10
  };
}

function validateImportDocuments(documents: ImportDocument[]) {
  if (documents.length > importLimits.maxDocuments) throw new Error('import_too_many_documents');
  let totalBytes = 0;
  for (const document of documents) {
    const bytes = Buffer.byteLength(document.content, 'utf8');
    if (bytes > importLimits.maxMarkdownBytes) throw new Error('import_document_too_large');
    totalBytes += bytes;
    if (totalBytes > importLimits.maxTotalMarkdownBytes) throw new Error('import_archive_too_large');
  }
  return documents;
}

function splitMarkdownBundle(markdown: string): ImportDocument[] {
  const parts = markdown.split(/\n-{3,}\n/g).map((part) => part.trim()).filter(Boolean);
  return parts.map((content, index) => {
    const title = markdownTitle(content) || `가져온 문서 ${index + 1}`;
    return { title, label: title.split('/').pop(), content, sortOrder: (index + 1) * 10 };
  });
}

function summaryEntriesFromPayload(payload: Record<string, any>) {
  const explicit = String(payload.summary ?? payload.summaryMarkdown ?? '').trim();
  const direct = Array.isArray(payload.documents) ? payload.documents : Array.isArray(payload.files) ? payload.files : [];
  const summaryDocument = direct.find((item: any) => /(^|\/)summary\.?md$/i.test(String(item.path ?? item.name ?? item.title ?? '')));
  const markdown = explicit || String(summaryDocument?.content ?? summaryDocument?.body ?? summaryDocument?.markdown ?? '').trim();
  if (!markdown) return [];
  return markdown
    .split(/\r?\n/)
    .map((line, index) => {
      const match = line.match(/^\s*[-*]\s+\[([^\]]+)]\(([^)]+)\)/);
      if (!match) return null;
      return {
        label: normalizeTitle(match[1]),
        path: normalizeImportPath(match[2]),
        sortOrder: (index + 1) * 10
      };
    })
    .filter(Boolean) as Array<{ label: string; path: string; sortOrder: number }>;
}

function applySummaryEntry(document: ImportDocument | null, summaryByPath: Map<string, { label: string; sortOrder: number }>) {
  if (!document) return null;
  const entry = summaryByPath.get(normalizeImportPath(document.title));
  return entry ? { ...document, label: entry.label, sortOrder: entry.sortOrder } : document;
}

function sortImportDocuments(documents: ImportDocument[]) {
  return [...documents].sort((a, b) => Number(a.sortOrder ?? 0) - Number(b.sortOrder ?? 0) || a.title.localeCompare(b.title));
}

function normalizeImportPath(value: unknown) {
  return normalizeTitle(String(value ?? '').replace(/\.md$/i, '').replace(/^\/+|\/+$/g, '').replace(/(^|\/)(readme|index)$/i, '$1대문'));
}

function importChecklist(documents: ImportDocument[], payload: Record<string, any>) {
  const summaryEntries = summaryEntriesFromPayload(payload);
  const imageLinks = documents.flatMap((document) => [...document.content.matchAll(/!\[[^\]]*]\(([^)]+)\)/g)].map((match) => ({ document: document.title, url: match[1] })));
  const externalLinks = documents.flatMap((document) => [...document.content.matchAll(/(?<!!)\[[^\]]+]\((https?:\/\/[^)]+)\)/g)].map((match) => ({ document: document.title, url: match[1] })));
  const officialAreas = documents.filter((document) => /\{\{공식 영역/i.test(document.content)).map((document) => document.title);
  return {
    summaryEntries: summaryEntries.length,
    documents: documents.length,
    imageLinks,
    externalLinks,
    officialAreas,
    checks: [
      { key: 'summary_tree', label: 'SUMMARY.md 문서 트리', ok: summaryEntries.length > 0 },
      { key: 'images', label: '이미지 링크 확인 필요', ok: imageLinks.length === 0, count: imageLinks.length },
      { key: 'external_links', label: '외부 링크 확인 필요', ok: externalLinks.length === 0, count: externalLinks.length },
      { key: 'official_area', label: '공식 영역 지정 확인', ok: officialAreas.length > 0, count: officialAreas.length }
    ]
  };
}

function markdownTitle(content: string) {
  const frontMatterTitle = content.match(/^---[\s\S]*?\ntitle:\s*(.+?)\n[\s\S]*?---/i)?.[1]?.trim();
  if (frontMatterTitle) return normalizeTitle(frontMatterTitle.replace(/^["']|["']$/g, ''));
  const heading = content.match(/^#\s+(.+)$/m)?.[1]?.trim();
  if (heading) return normalizeTitle(heading);
  return '';
}

function markdownToWikiMarkup(markdown: string, title: string, spaceType: string) {
  const lines = markdown.replace(/^---[\s\S]*?\n---\s*/i, '').split('\n');
  const output: string[] = [];
  let inFence = false;
  for (const line of lines) {
    const fence = line.match(/^```(\w+)?\s*$/);
    if (fence) {
      output.push(inFence ? '</codeblock>' : `<codeblock${fence[1] ? ` lang="${fence[1]}"` : ''}>`);
      inFence = !inFence;
      continue;
    }
    if (inFence) {
      output.push(line);
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      const level = Math.min(Math.max(heading[1].length + 1, 2), 4);
      output.push(`${'='.repeat(level)} ${heading[2].trim()} ${'='.repeat(level)}`);
      continue;
    }
    output.push(
      line
        .replace(/^[-+]\s+/, '* ')
        .replace(/!\[([^\]]*)\]\((https?:\/\/[^)]+)\)/g, '[$2 $1]')
        .replace(/\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g, '[$2 $1]')
        .replace(/\*\*([^*]+)\*\*/g, "'''$1'''")
        .replace(/`([^`]+)`/g, '<code>$1</code>')
    );
  }
  const category = spaceType === 'server_wiki' ? '서버 공식 위키' : spaceType === 'mod_wiki' ? '모드 위키' : 'GitBook 이전';
  const body = output.join('\n').trim();
  const status = body.includes('{{문서 상태') ? '' : `{{문서 상태\n|기준=Markdown Import\n|상태=검토 필요\n|확인일=${formatWikiDateTime(new Date())}\n}}\n\n`;
  return `${status}${body || `'''${title}''' 문서입니다.`}\n\n[[분류:${category}]]`;
}

function importedPageTitle(job: any, title: string) {
  const normalized = normalizeTitle(title).replace(/^\/+|\/+$/g, '');
  const slug = String(job.space_slug ?? '').trim();
  if (!['server_wiki', 'mod_wiki'].includes(String(job.space_type)) || !slug) return normalized;
  if (normalized === slug || normalized.startsWith(`${slug}/`)) return normalized;
  if (['대문', 'readme', 'index'].includes(normalized.toLowerCase())) return job.space_type === 'server_wiki' ? slug : `${slug}/대문`;
  return `${slug}/${normalized}`;
}

function importNamespace(job: any): NamespaceCode {
  const namespace = String(job.root_namespace_code ?? 'main');
  return ['main', 'mod', 'modpack', 'server', 'dev', 'guide', 'data', 'help', 'project', 'template', 'file'].includes(namespace)
    ? (namespace as NamespaceCode)
    : 'main';
}

async function nextSidebarSort(spaceId: number) {
  const row = await one<{ sort_order: number }>(`SELECT COALESCE(MAX(sort_order),0) + 10 AS sort_order FROM subwiki_sidebar_items WHERE space_id=:spaceId`, { spaceId });
  return Number(row?.sort_order ?? 10);
}

async function sidebarParentIdFromBody(spaceId: number, value: unknown, itemId: number, manageHref: string, user: any, reply: any): Promise<number | null | false> {
  const raw = String(value ?? '').trim();
  if (!raw) return null;
  const parentId = nullablePositiveInt(raw);
  if (!parentId) {
    subwikiManageError(reply, user, 400, '사이드바 부모 항목 값이 올바르지 않습니다.', manageHref);
    return false;
  }
  if (itemId && parentId === itemId) {
    subwikiManageError(reply, user, 400, '사이드바 항목은 자기 자신을 부모로 둘 수 없습니다.', manageHref);
    return false;
  }
  const rows = await query<any>(`SELECT id, parent_id FROM subwiki_sidebar_items WHERE space_id=:spaceId`, { spaceId });
  const parentById = new Map(rows.map((row) => [Number(row.id), row.parent_id ? Number(row.parent_id) : null]));
  if (!parentById.has(parentId)) {
    subwikiManageError(reply, user, 400, '선택한 사이드바 부모 항목을 찾을 수 없습니다.', manageHref);
    return false;
  }
  if (itemId) {
    let current: number | null | undefined = parentId;
    while (current) {
      if (current === itemId) {
        subwikiManageError(reply, user, 400, '사이드바 부모-자식 관계가 순환됩니다.', manageHref);
        return false;
      }
      current = parentById.get(current);
    }
  }
  return parentId;
}

async function upsertSidebarItem(spaceId: number, pageId: number, label: string, targetTitle: string, sortOrder: number, parentId: number | null | undefined = undefined) {
  const existing = await one<any>(`SELECT id FROM subwiki_sidebar_items WHERE space_id=:spaceId AND target_title=:targetTitle LIMIT 1`, { spaceId, targetTitle });
  if (existing) {
    await exec(`UPDATE subwiki_sidebar_items SET page_id=:pageId, parent_id=IF(:parentProvided=1,:parentId,parent_id), label=:label, sort_order=:sortOrder, updated_at=NOW() WHERE id=:id`, {
      id: existing.id,
      pageId,
      parentId: parentId ?? null,
      parentProvided: parentId === undefined ? 0 : 1,
      label,
      sortOrder
    });
    return;
  }
  await exec(
    `INSERT INTO subwiki_sidebar_items (space_id, parent_id, page_id, label, target_title, sort_order, created_at, updated_at)
     VALUES (:spaceId, :parentId, :pageId, :label, :targetTitle, :sortOrder, NOW(), NOW())`,
    { spaceId, parentId, pageId, label, targetTitle, sortOrder }
  );
}

async function serverSubwikiSpace(slug: string) {
  return one<any>(`SELECT ${wikiSpaceFields} FROM wiki_spaces WHERE code=:code AND space_type='server_wiki'`, { code: `server-${slug}` });
}

async function modSubwikiSpace(slug: string) {
  return one<any>(`SELECT ${wikiSpaceFields} FROM wiki_spaces WHERE code=:code AND space_type='mod_wiki'`, { code: `mod-${slug}` });
}

async function canManageSubwiki(user: any, spaceId: number) {
  if (can(user, 'server.official_edit') || can(user, 'report.handle')) return true;
  if (!user) return false;
  const role = await one<any>(
    `SELECT id FROM subwiki_roles
     WHERE space_id=:spaceId AND user_id=:userId AND status='active' AND role IN ('owner','manager','editor')
     UNION
     SELECT so.id
     FROM server_owners so
     JOIN wiki_spaces ws ON ws.root_page_id=so.page_id
     WHERE ws.id=:spaceId AND so.user_id=:userId AND so.status='active'
     LIMIT 1`,
    { spaceId, userId: user.id }
  );
  return Boolean(role);
}

async function canOwnSubwiki(user: any, spaceId: number) {
  if (can(user, 'server.official_edit') || can(user, 'report.handle')) return true;
  if (!user) return false;
  const role = await one<any>(
    `SELECT id FROM subwiki_roles
     WHERE space_id=:spaceId AND user_id=:userId AND status='active' AND role='owner'
     LIMIT 1`,
    { spaceId, userId: user.id }
  );
  return Boolean(role);
}

async function serverBillingContext(spaceId: number) {
  const serverWiki = await one<any>(
    `SELECT id, space_id, server_name, slug, host, port, edition, supported_versions, genres, verified_status, status, created_by, created_at, updated_at
     FROM server_wikis
     WHERE space_id=:spaceId`,
    { spaceId }
  );
  const subscription = serverWiki
    ? await one<any>(
        `SELECT ss.id, ss.server_wiki_id, ss.plan_id, ss.status, ss.started_at, ss.renews_at, ss.cancelled_at, ss.created_by, ss.created_at, ss.updated_at,
                bp.plan_key, bp.name AS plan_name, bp.price_monthly_krw, bp.features_json
         FROM server_subscriptions ss
         JOIN billing_plans bp ON bp.id=ss.plan_id
         WHERE ss.server_wiki_id=:serverWikiId AND ss.status IN ('trialing','active','past_due')
         ORDER BY FIELD(ss.status,'active','trialing','past_due'), ss.id DESC
         LIMIT 1`,
        { serverWikiId: serverWiki.id }
      )
    : null;
  const freePlan = await one<any>(`SELECT id, plan_key, name, price_monthly_krw, status, features_json, created_at, updated_at FROM billing_plans WHERE plan_key='free' LIMIT 1`);
  const plan = subscription
    ? { plan_key: subscription.plan_key, name: subscription.plan_name, price_monthly_krw: subscription.price_monthly_krw, features_json: subscription.features_json }
    : freePlan ?? { plan_key: 'free', name: 'Free', price_monthly_krw: 0, features_json: '{}' };
  const [domains, theme, plans] = await Promise.all([
    serverWiki ? query<any>(`SELECT ${customDomainFields} FROM server_custom_domains WHERE server_wiki_id=:serverWikiId ORDER BY FIELD(status,'active','verified','pending','failed','disabled'), id DESC`, { serverWikiId: serverWiki.id }) : [],
    serverWiki
      ? one<any>(
          `SELECT server_wiki_id, theme_key, logo_file_id, banner_file_id, favicon_file_id, primary_color, accent_color, background_mode, custom_css, custom_css_status, branding_mode, updated_by, created_at, updated_at
           FROM server_theme_settings
           WHERE server_wiki_id=:serverWikiId`,
          { serverWikiId: serverWiki.id }
        )
      : null,
    query<any>(`SELECT id, plan_key, name, price_monthly_krw, status, features_json, created_at, updated_at FROM billing_plans WHERE status='active' ORDER BY FIELD(plan_key,'free','plus','pro','business'), price_monthly_krw`)
  ]);
  return {
    serverWiki,
    subscription,
    plan,
    features: safeFeatures(plan.features_json),
    domains,
    theme,
    plans
  };
}

function safeFeatures(value: unknown) {
  try {
    return JSON.parse(String(value ?? '{}'));
  } catch {
    return {};
  }
}

async function serverFeature(spaceId: number, featureKey: string) {
  const billing = await serverBillingContext(spaceId);
  return Boolean(billing.features?.[featureKey]);
}

async function serverOperatorLimit(spaceId: number) {
  const billing = await serverBillingContext(spaceId);
  return Number(billing.features?.operatorLimit ?? 1);
}

async function attachSubwikiTheme(page: any, namespace: NamespaceCode, spaceId: number | null = null) {
  if (namespace !== 'server' || !page) return;
  const resolvedSpaceId = spaceId ?? (await serverSpaceIdForTitle(page.title));
  if (!resolvedSpaceId) return;
  page.subwikiTheme = await serverThemeForSpaceId(resolvedSpaceId);
}

async function serverSpaceIdForTitle(title: unknown) {
  const slug = String(title ?? '').split('/')[0]?.trim();
  if (!slug) return null;
  const row = await one<any>(`SELECT id FROM wiki_spaces WHERE code=:code AND space_type='server_wiki' LIMIT 1`, { code: `server-${slug}` });
  return row ? Number(row.id) : null;
}

async function serverThemeForSpaceId(spaceId: number) {
  return one<any>(
    `SELECT sts.server_wiki_id, sts.theme_key, sts.primary_color, sts.accent_color, sts.background_mode, sts.custom_css, sts.custom_css_status, sts.branding_mode
     FROM server_wikis sw
     JOIN server_theme_settings sts ON sts.server_wiki_id=sw.id
     WHERE sw.space_id=:spaceId
     LIMIT 1`,
    { spaceId }
  );
}

async function serverWikiIdForSpace(spaceId: number) {
  const row = await one<any>(`SELECT id FROM server_wikis WHERE space_id=:spaceId`, { spaceId });
  return row ? Number(row.id) : null;
}

async function userByIdentifier(identifier: unknown) {
  const value = String(identifier ?? '').trim();
  if (!value) return null;
  return one<any>(
    `SELECT id, username, display_name FROM users
     WHERE username=:value OR email=:value OR display_name=:value
     LIMIT 1`,
    { value }
  );
}

function normalizeSubwikiRole(value: unknown) {
  const role = String(value ?? '').trim();
  return ['owner', 'manager', 'editor', 'reviewer'].includes(role) ? role : null;
}

function normalizeServerDocumentTemplate(value: unknown) {
  const template = String(value ?? 'generic').trim();
  return ['generic', 'notice', 'rules', 'donation', 'sanction'].includes(template) ? template : 'generic';
}

function normalizeModDocumentTemplate(value: unknown) {
  const template = String(value ?? 'generic').trim();
  return ['generic', 'item', 'block', 'machine', 'compatibility', 'version'].includes(template) ? template : 'generic';
}

function normalizeServerEasyEditDocType(value: unknown) {
  const docType = String(value ?? '').trim();
  return ['connection', 'rules', 'notice', 'donation', 'sanction'].includes(docType) ? docType : '';
}

function normalizeServerSeasonStatus(value: unknown) {
  const status = String(value ?? '').trim();
  return ['planned', 'active', 'archived'].includes(status) ? status : null;
}

function serverDocTemplate(serverTitle: string, docTitle: string, template: string) {
  const updated = formatWikiDateTime(new Date());
  const heading = template === 'notice' ? '공지' : template === 'rules' ? '규칙' : template === 'donation' ? '후원 정책' : template === 'sanction' ? '제재 기준' : docTitle;
  const policyBlock =
    template === 'donation'
      ? '\n== 환불 정책 ==\n후원 보상과 환불 기준을 명확히 적는다.\n'
      : template === 'sanction'
        ? '\n== 제재 단계 ==\n경고, 임시 차단, 영구 차단 기준을 구분한다.\n'
        : template === 'rules'
          ? '\n== 기본 규칙 ==\n서버에서 금지되는 행동과 처리 기준을 적는다.\n'
          : template === 'notice'
            ? '\n== 공지 내용 ==\n날짜와 적용 범위를 먼저 적는다.\n'
            : '\n== 내용 ==\n서버 운영자가 공식 정보를 작성한다.\n';
  return `{{문서 상태
|기준=서버 공식 위키
|상태=검증 필요
|확인일=${updated}
}}

'''${serverTitle} ${heading}''' 문서이다.
${policyBlock}
[[분류:서버]]
[[분류:서버 공식 위키]]`;
}

function modWikiDocTemplate(modTitle: string, docTitle: string, template: string) {
  const updated = formatWikiDateTime(new Date());
  const heading =
    template === 'item' ? '아이템'
      : template === 'block' ? '블록'
        : template === 'machine' ? '기계'
          : template === 'compatibility' ? '호환성'
            : template === 'version' ? '버전별 변경점'
              : docTitle;
  const body =
    template === 'item'
      ? '\n{{데이터 표\n|키=item-list\n|제목=아이템 목록\n|열=이름,용도,획득,비고\n|행1=\n}}\n'
      : template === 'block'
        ? '\n{{데이터 표\n|키=block-list\n|제목=블록 목록\n|열=이름,기능,획득,비고\n|행1=\n}}\n'
        : template === 'machine'
          ? '\n{{데이터 표\n|키=machine-list\n|제목=기계 목록\n|열=이름,입력,출력,전력/연료,비고\n|행1=\n}}\n'
          : template === 'compatibility'
            ? '\n{{의존성 정보\n|열=이름,범위,버전,비고\n|행1=\n}}\n'
            : template === 'version'
              ? '\n{{모드 버전표\n|Minecraft=\n|로더=\n|상태=검증 필요\n|비고=\n}}\n'
              : '\n== 내용 ==\n모드 기능, 진행, 설정값을 문서화한다.\n';
  return `{{문서 상태
|기준=모드 위키
|상태=검증 필요
|확인일=${updated}
}}

'''${modTitle} ${heading}''' 문서이다.
${body}
[[분류:모드]]
[[분류:모드 위키]]`;
}

function serverEasyEditDocument(serverTitle: string, docType: string, body: any) {
  const updated = formatWikiDateTime(new Date());
  const value = (key: string, fallback = '') => boundedText(body[key] ?? fallback, 2000);
  const link = normalizeOptionalHttpUrl(body.link);
  const linkLine = link ? `\n== 관련 링크 ==\n* ${link}\n` : '';
  const docs: Record<string, { title: string; content: string }> = {
    connection: {
      title: '접속 방법',
      content: serverOfficialDocument(serverTitle, '접속 방법', updated, `== 서버 주소 ==\n${value('host', '주소 미등록')}\n\n== 지원 버전 ==\n${value('supportedVersions', '문서 참조')}\n\n== 화이트리스트 ==\n${value('whitelist', '문서 참조')}\n\n== 접속 안내 ==\n${value('body', '접속 전 서버 규칙과 공지를 확인한다.')}${linkLine}`)
    },
    rules: {
      title: '규칙',
      content: serverOfficialDocument(serverTitle, '규칙', updated, `== ${value('ruleTitle', '기본 규칙')} ==\n${value('ruleBody', '서버에서 금지되는 행동과 처리 기준을 적는다.')}\n\n== 적용 범위 ==\n${value('scope', '전체 서버')}${linkLine}`)
    },
    notice: {
      title: `공지/${value('noticeTitle', '새 공지')}`,
      content: serverOfficialDocument(serverTitle, value('noticeTitle', '새 공지'), updated, `== 공지 내용 ==\n${value('noticeBody', '공지 내용을 입력한다.')}\n\n== 고정 여부 ==\n${body.pinned ? '고정' : '일반'}\n\n== 게시 기간 ==\n${value('startsAt', '시작일 미정')} ~ ${value('endsAt', '종료일 미정')}`)
    },
    donation: {
      title: '후원 정책',
      content: serverOfficialDocument(serverTitle, '후원 정책', updated, `== 후원 안내 ==\n${value('donationBody', '후원 방식과 보상을 명확히 적는다.')}\n\n== 환불 정책 ==\n${value('refundPolicy', '환불 기준을 명확히 적는다.')}${linkLine}`)
    },
    sanction: {
      title: '제재 기준',
      content: serverOfficialDocument(serverTitle, '제재 기준', updated, `== 제재 단계 ==\n${value('sanctionBody', '경고, 임시 차단, 영구 차단 기준을 구분한다.')}\n\n== 이의 제기 ==\n${value('appealLink', '이의 제기 경로를 적는다.')}`)
    }
  };
  return docs[docType] ?? null;
}

function serverOfficialDocument(serverTitle: string, title: string, updated: string, body: string) {
  return `{{문서 상태
|기준=서버 공식 위키 공식 문서
|상태=검토 필요
|확인일=${updated}
}}

'''${serverTitle} ${title}''' 문서이다.

{{공식 영역
|대상=서버 운영자
|상태=공식
|비고=인증된 서버 운영자가 관리하는 공식 문서
}}

${body}

[[분류:서버]]
[[분류:서버 공식 위키]]
[[분류:공식 문서]]`;
}

function formatWikiDateTime(value: Date) {
  const year = String(value.getFullYear()).padStart(4, '0');
  const month = String(value.getMonth() + 1).padStart(2, '0');
  const day = String(value.getDate()).padStart(2, '0');
  const hour = String(value.getHours()).padStart(2, '0');
  const minute = String(value.getMinutes()).padStart(2, '0');
  return `${year}.${month}.${day}. ${hour}:${minute}`;
}

function emptyToNull(value: unknown) {
  const text = String(value ?? '').trim();
  return text || null;
}

function normalizeOptionalHttpUrl(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    return url.toString().slice(0, 500);
  } catch {
    return null;
  }
}

function normalizeSidebarTargetUrl(value: unknown) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  if (text.startsWith('/') && !text.startsWith('//') && !/[\u0000-\u001f\u007f]/.test(text)) return encodeURI(text).slice(0, 500);
  try {
    const url = new URL(text);
    if (!['http:', 'https:'].includes(url.protocol)) return null;
    url.username = '';
    url.password = '';
    return url.toString().slice(0, 500);
  } catch {
    return null;
  }
}

function normalizeServerSubwikiSlug(value: unknown) {
  const slug = String(value ?? '').trim().replace(/\s+/g, '_');
  return /^[A-Za-z0-9._-]{2,64}$/.test(slug) ? slug : null;
}

function serverSeasonTemplate(serverTitle: string, seasonTitle: string, summary: string, status: string) {
  return `{{문서 상태
|기준=서버 공식 위키 시즌
|상태=검토 필요
|확인일=2026.05.23. 16:04
}}

'''${serverTitle} ${seasonTitle}''' 시즌 기록이다.

== 개요 ==
${summary || '시즌 기간, 핵심 변경점, 월드/경제 초기화 여부를 정리한다.'}

== 상태 ==
${status}

== 주요 변경점 ==

== 관련 공지 ==

[[분류:서버]]
[[분류:시즌 기록]]
[[분류:서버 공식 위키]]`;
}

function normalizeCustomDomain(value: unknown) {
  const raw = String(value ?? '').trim().toLowerCase().replace(/\.$/, '');
  const domain = domainToASCII(raw);
  if (!domain) return null;
  if (net.isIP(domain) || isReservedDomainName(domain)) return null;
  if (!isValidDomainName(domain)) return null;
  return domain;
}

function isValidDomainName(domain: string) {
  if (domain.length > 253 || !domain.includes('.')) return false;
  const labels = domain.split('.');
  const tld = labels.at(-1) ?? '';
  if (!/^[a-z]{2,63}$/.test(tld)) return false;
  return labels.every((label) => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
}

function isReservedDomainName(domain: string) {
  return (
    domain === 'localhost' ||
    domain.endsWith('.localhost') ||
    domain.endsWith('.local') ||
    domain.endsWith('.internal') ||
    domain.endsWith('.test') ||
    domain.endsWith('.example') ||
    domain.endsWith('.invalid') ||
    domain.endsWith('.lan') ||
    domain.endsWith('.home')
  );
}

function normalizeCssColor(value: unknown) {
  const color = String(value ?? '').trim();
  if (!color) return null;
  return /^#[0-9a-fA-F]{6}$/.test(color) ? color.toLowerCase() : null;
}

function normalizeThemeKey(value: unknown) {
  const key = String(value ?? '').trim();
  return ['default', 'dark-server', 'rpg', 'economy', 'minimal-docs', 'pixel-classic'].includes(key) ? key : 'default';
}

function normalizeThemeBackgroundMode(value: unknown) {
  const mode = String(value ?? 'system').trim();
  return ['light', 'dark', 'system'].includes(mode) ? mode : 'system';
}

function sanitizeServerCustomCss(value: unknown) {
  const css = String(value ?? '').trim();
  if (!css) return '';
  if (css.length > 8000) return null;
  const lowered = css.toLowerCase();
  const forbidden = ['<script', '</script', '@import', 'javascript:', 'expression(', 'url(', 'iframe', 'display:none', 'position:fixed', 'position: fixed'];
  if (forbidden.some((token) => lowered.includes(token))) return null;
  return css;
}

function normalizeShortPath(value: unknown) {
  const shortPath = String(value ?? '').trim();
  if (!shortPath) return null;
  if (!/^\/[A-Za-z0-9가-힣._~/-]{2,128}$/.test(shortPath)) return null;
  const normalized = shortPath.replace(/\/+$/, '') || null;
  if (!normalized) return null;
  const firstSegment = normalized.split('/')[1]?.toLowerCase() ?? '';
  const reserved = new Set(['api', 'admin', 'assets', 'login', 'logout', 'join', 'wiki', 'file', 'category', 'search', 'special', 'revision']);
  return reserved.has(firstSegment) ? null : normalized;
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

async function tcpCheck(host: string, port: number) {
  if (!isAllowedPublicProbePort(port)) return false;
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

async function serverEndpoint(pageId: number, body: any) {
  const endpoint = await one<any>(`SELECT host, port FROM server_endpoints WHERE page_id=:pageId AND enabled=1 ORDER BY id DESC LIMIT 1`, { pageId });
  const host = normalizeServerHost(body.host ?? endpoint?.host ?? '');
  const port = normalizeServerPort(body.port ?? endpoint?.port ?? 25565) ?? 25565;
  return {
    host: host ?? '',
    port
  };
}

type JavaStatus = {
  online: boolean;
  motd?: string;
  versionName?: string;
  playersOnline?: number;
  playersMax?: number;
};

async function minecraftJavaStatus(host: string, port: number): Promise<JavaStatus> {
  if (!host) return { online: false };
  if (!isAllowedPublicProbePort(port)) return { online: false };
  const address = await publicNetworkAddress(host);
  if (!address) return { online: false };
  return new Promise<JavaStatus>((resolve) => {
    const socket = net.createConnection({ host: address.address, port, family: address.family, timeout: 3500 });
    let buffer = Buffer.alloc(0);
    let finished = false;
    const finish = (status: JavaStatus) => {
      if (finished) return;
      finished = true;
      socket.destroy();
      resolve(status);
    };
    socket.once('connect', () => {
      socket.write(javaStatusHandshake(host, port));
      socket.write(packet(Buffer.from([0x00])));
    });
    socket.on('data', (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const parsed = parseJavaStatusResponse(buffer);
      if (parsed) finish(parsed);
    });
    socket.once('timeout', () => finish({ online: false }));
    socket.once('error', () => finish({ online: false }));
    socket.once('close', () => finish(parseJavaStatusResponse(buffer) ?? { online: buffer.length > 0 }));
  });
}

function javaStatusHandshake(host: string, port: number) {
  const hostBuffer = Buffer.from(host, 'utf8');
  const body = Buffer.concat([
    writeVarInt(0x00),
    writeVarInt(761),
    writeVarInt(hostBuffer.length),
    hostBuffer,
    writeUnsignedShort(port),
    writeVarInt(1)
  ]);
  return packet(body);
}

function packet(body: Buffer) {
  return Buffer.concat([writeVarInt(body.length), body]);
}

function writeUnsignedShort(value: number) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(Math.max(0, Math.min(65535, value)));
  return buffer;
}

function writeVarInt(value: number) {
  const bytes = [];
  let next = value >>> 0;
  do {
    let temp = next & 0x7f;
    next >>>= 7;
    if (next !== 0) temp |= 0x80;
    bytes.push(temp);
  } while (next !== 0);
  return Buffer.from(bytes);
}

function readVarInt(buffer: Buffer, offset = 0) {
  let value = 0;
  let position = 0;
  let currentByte = 0;
  while (offset + position < buffer.length) {
    currentByte = buffer[offset + position];
    value |= (currentByte & 0x7f) << (7 * position);
    position += 1;
    if ((currentByte & 0x80) === 0) return { value, size: position };
    if (position > 5) return null;
  }
  return null;
}

function parseJavaStatusResponse(buffer: Buffer): JavaStatus | null {
  const packetLength = readVarInt(buffer, 0);
  if (!packetLength || buffer.length < packetLength.size + packetLength.value) return null;
  let offset = packetLength.size;
  const packetId = readVarInt(buffer, offset);
  if (!packetId || packetId.value !== 0x00) return null;
  offset += packetId.size;
  const jsonLength = readVarInt(buffer, offset);
  if (!jsonLength || buffer.length < offset + jsonLength.size + jsonLength.value) return null;
  offset += jsonLength.size;
  try {
    const payload = JSON.parse(buffer.subarray(offset, offset + jsonLength.value).toString('utf8'));
    return {
      online: true,
      motd: minecraftDescriptionText(payload.description),
      versionName: payload.version?.name,
      playersOnline: typeof payload.players?.online === 'number' ? payload.players.online : undefined,
      playersMax: typeof payload.players?.max === 'number' ? payload.players.max : undefined
    };
  } catch {
    return null;
  }
}

function minecraftDescriptionText(value: any): string {
  if (!value) return '';
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return value.map(minecraftDescriptionText).join('');
  return `${value.text ?? ''}${minecraftDescriptionText(value.extra)}`;
}

function nullablePositiveInt(value: unknown) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function canModVerify(user: any) {
  return can(user, 'mod.verify') || can(user, 'report.handle');
}

async function upsertSearchDictionary(body: any, userId: number | null) {
  const term = normalizeTitle(body.term ?? '');
  if (!term) return { ok: false, error: 'term_required' };
  const action = ['alias', 'disambiguation', 'boost', 'ignore'].includes(body.action) ? body.action : 'alias';
  const termType = ['alias', 'typo', 'synonym', 'english', 'chosung', 'common_query'].includes(body.termType)
    ? body.termType
    : action === 'boost'
      ? 'common_query'
      : 'alias';
  const targetRef = firstBodyValue(body, ['targetPageRef', 'targetPageId']);
  const targetPage = await searchTargetPageFromBody(body, ['targetPageRef', 'targetPageId']);
  if (String(targetRef ?? '').trim() && !targetPage) return { ok: false, error: 'target_not_found' };
  const targetPageId = targetPage ? Number(targetPage.id) : null;
  await exec(
    `INSERT INTO search_dictionary (term, normalized, normalized_term, replacement, action, target_page_id, term_type, weight, enabled, note, created_by, created_at)
     VALUES (:term, :normalized, :normalizedTerm, :replacement, :action, :targetPageId, :termType, :weight, :enabled, :note, :userId, NOW())
     ON DUPLICATE KEY UPDATE normalized=VALUES(normalized), normalized_term=VALUES(normalized_term), replacement=VALUES(replacement), action=VALUES(action), target_page_id=VALUES(target_page_id), term_type=VALUES(term_type), weight=VALUES(weight), enabled=VALUES(enabled), note=VALUES(note)`,
    {
      term,
      normalized: normalizeSearch(term),
      normalizedTerm: normalizeSearch(term),
      replacement: body.replacement ? normalizeTitle(body.replacement) : null,
      action,
      targetPageId,
      termType,
      weight: nullablePositiveInt(body.weight) ?? 100,
      enabled: body.enabled === false || body.enabled === '0' ? 0 : 1,
      note: body.note || null,
      userId
    }
  );
  return { ok: true };
}

function firstBodyValue(body: any, names: string[]) {
  for (const name of names) {
    const value = body?.[name];
    if (value !== undefined && value !== null && String(value).trim() !== '') return value;
  }
  return '';
}

async function searchTargetPageFromBody(body: any, names: string[]) {
  const raw = String(firstBodyValue(body, names) ?? '').trim();
  if (!raw) return null;
  const id = nullablePositiveInt(raw);
  if (id) return getPageById(id);
  const parsed = parseLinkTarget(raw);
  if (!parsed.title) return null;
  return getPageByTitle(parsed.namespace as NamespaceCode, parsed.title);
}

await ensureCoreData();
await syncPageSpaces();

if (process.env.NODE_ENV !== 'test') {
  await app.listen({ host: config.host, port: config.port });
}

export { app };
