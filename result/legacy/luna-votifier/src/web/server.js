const path = require('path');
const crypto = require('crypto');
const express = require('express');
const session = require('express-session');
const MySQLStore = require('express-mysql-session')(session);
const { ulid } = require('ulid');
const compression = require('compression');
const config = require('./config');
const { pool, query } = require('./db');
const { randomId, hmacSha256Hex } = require('./utils');
const { createSession, completeSession, revokeLink, getSession, loadSettings } = require('./services/verifyService');
const {
  getDiscordAuthorizeUrl,
  exchangeDiscordCode,
  fetchDiscordUser,
  fetchDiscordGuilds,
  filterManagedGuilds,
  fetchBotGuildPresence,
  fetchBotGuildInfo,
  fetchGuildChannels,
  fetchGuildRoles,
  fetchGuildMembers,
  searchGuildMembers,
  fetchGuildMember,
  classifyGuildAccess
} = require('./services/discordService');
const { getMicrosoftAuthorizeUrl, verifyMinecraftOwnership } = require('./services/microsoftService');
const { logAudit } = require('./services/auditService');
const { getRoutingRules, saveRoutingRules } = require('./services/routingService');
const { pushEventToServers } = require('./services/pushService');

const app = express();
const sessionStore = new MySQLStore({}, pool);
const isSecurePublicBaseUrl = String(config.publicBaseUrl || '').startsWith('https://');

const MANAGE_SETTINGS_PERMISSION = 'manage_settings';
const PLUGIN_SYNC_SKEW_SECONDS = 300;
const PLUGIN_SYNC_COOLDOWN_SECONDS = 30;
const PLUGIN_SYNC_PATH = '/api/v1/plugin/sync-9b4f7d2c6a5e4f3aa1d8b9a7c6e5d4f3';
const pluginSyncLastSeen = new Map();
const GUILD_CONTEXT_CACHE_TTL_MS = 15000;
const guildContextCache = new Map();
const consentCopy = {
  discord: {
    title: '디스코드 로그인',
    description: '디스코드 로그인을 시작하기 전에 개인정보 처리방침에 동의해야 합니다.',
    buttonLabel: '동의하고 Discord로 로그인'
  },
  microsoft: {
    title: '마인크래프트 계정 인증',
    description: 'Minecraft 계정 인증을 시작하기 전에 개인정보 처리방침에 동의해야 합니다.',
    buttonLabel: '동의하고 Microsoft로 로그인'
  }
};

const eventTypes = [
  { key: 'verification.completed', slug: 'verification_completed', label: '인증 완료' },
  { key: 'verification.revoked', slug: 'verification_revoked', label: '인증 해제' },
  { key: 'verification.reverified', slug: 'verification_reverified', label: '재인증 완료' }
];
const allowedEventTypeKeys = new Set(eventTypes.map((eventType) => eventType.key));

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));
if (isSecurePublicBaseUrl) {
  app.set('trust proxy', 1);
}
if (!config.sessionSecret || config.sessionSecret === 'change-me') {
  throw new Error('SESSION_SECRET must be configured with a strong random value.');
}

app.use(compression());
const publicDirs = [path.join(__dirname, 'public'), path.join(process.cwd(), 'public')];
const staticAssetPolicy = {
  maxAge: '1d',
  fallthrough: true,
  setHeaders(res, assetPath) {
    if (/\.(?:woff2?|ttf|otf|eot)$/i.test(assetPath)) {
      res.setHeader('Cache-Control', 'public, max-age=2592000, immutable');
      return;
    }
    if (/\.(?:css|js)$/i.test(assetPath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
      return;
    }
    if (/\.(?:svg|png|jpe?g|gif|webp|ico)$/i.test(assetPath)) {
      res.setHeader('Cache-Control', 'public, max-age=604800');
    }
  }
};
for (const dir of publicDirs) {
  app.use('/public', express.static(dir, staticAssetPolicy));
}
app.use((req, res, next) => {
  if (req.path.startsWith('/public/')) {
    return next();
  }
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  res.setHeader('CDN-Cache-Control', 'no-store');
  res.setHeader('Surrogate-Control', 'no-store');
  res.setHeader('Pragma', 'no-cache');
  res.setHeader('Expires', '0');
  next();
});
app.get('/favicon.ico', (req, res) => {
  res.set('Cache-Control', 'public, max-age=86400');
  res.redirect(301, '/public/favicon.ico');
});
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
app.use(
  session({
    key: 'mw_legacy_session',
    secret: config.sessionSecret,
    resave: false,
    saveUninitialized: false,
    store: sessionStore,
    cookie: {
      httpOnly: true,
      sameSite: 'lax',
      secure: isSecurePublicBaseUrl ? 'auto' : false
    }
  })
);

app.use((req, res, next) => {
  if (!req.session.csrfToken) {
    req.session.csrfToken = randomId();
  }
  res.locals.csrfToken = req.session.csrfToken;
  res.locals.user = req.session.user || null;
  res.locals.guilds = req.session.guilds || [];
  res.locals.currentGuild = req.session.currentGuild || null;
  res.locals.publicBaseUrl = config.publicBaseUrl;
  res.locals.assetVersion = config.assetVersion;
  res.locals.allowMockMsLogin = config.allowMockMsLogin;
  res.locals.channelQuery = '';
  res.locals.channelOptions = [];
  res.locals.selectedChannelId = '';
  res.locals.botPresent = false;
  res.locals.actionPath = req.path;
  res.locals.allowAllChannels = true;
  res.locals.botInviteUrl = '';
  res.locals.botInviteUrlBase = getBotInviteUrl();
  res.locals.selectedTab = 'linked';
  res.locals.canManageSettings = false;
  res.locals.isGuildOwner = false;
  res.locals.flash = req.session.flash || null;
  delete req.session.flash;
  next();
});

function setFlash(req, type, message) {
  req.session.flash = { type, message };
}

function getConsentState(req) {
  if (!req.session.privacyConsent) {
    req.session.privacyConsent = {};
  }
  return req.session.privacyConsent;
}

function hasConsent(req, flow) {
  const consent = getConsentState(req);
  return Boolean(consent[flow]);
}

function isValidConsentRedirect(flow, redirectPath) {
  if (!redirectPath || typeof redirectPath !== 'string') {
    return false;
  }
  if (!redirectPath.startsWith('/') || redirectPath.startsWith('//')) {
    return false;
  }
  if (redirectPath.includes('://')) {
    return false;
  }
  if (flow === 'discord') {
    return redirectPath.startsWith('/auth/discord') || redirectPath.startsWith('/guilds');
  }
  if (flow === 'microsoft') {
    return redirectPath.startsWith('/auth/microsoft');
  }
  return false;
}

async function hasConsentInDb(discordUserId, flow) {
  if (!discordUserId || !flow) {
    return false;
  }
  const rows = await query(
    'SELECT consented_at FROM privacy_consents WHERE discord_user_id = ? AND consent_type = ? LIMIT 1',
    [discordUserId, flow]
  );
  return rows.length > 0;
}

async function recordConsentInDb(discordUserId, flow) {
  if (!discordUserId || !flow) {
    return;
  }
  await query(
    `INSERT INTO privacy_consents (discord_user_id, consent_type, consented_at, updated_at)
     VALUES (?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE updated_at = NOW()`,
    [discordUserId, flow]
  );
}

function mapMicrosoftErrorMessage(err) {
  const message = err?.message || '';
  if (message.includes('minecraft_entitlements_missing')) {
    return '해당 Microsoft 계정에 Minecraft 소유권이 없습니다.';
  }
  if (message.startsWith('minecraft_entitlements_failed:403') || message.startsWith('minecraft_profile_failed:403')) {
    return 'Minecraft API 사용 권한 승인이 필요합니다. 관리자에게 문의해주세요.';
  }
  if (message.startsWith('minecraft_entitlements_failed')) {
    return 'Minecraft 소유권 확인 중 오류가 발생했습니다. 잠시 후 다시 시도하세요.';
  }
  if (message.startsWith('minecraft_profile_not_found')) {
    return 'Minecraft 프로필을 찾을 수 없습니다. 계정 상태를 확인해주세요.';
  }
  if (message.startsWith('minecraft_profile_failed')) {
    return 'Minecraft 프로필 조회에 실패했습니다. 잠시 후 다시 시도하세요.';
  }
  if (message.startsWith('xbox_auth_failed') || message.startsWith('xsts_auth_failed')) {
    const match = message.match(/^xsts_auth_failed:\d+:(\d+)/);
    if (match) {
      return `Xbox Live 인증에 실패했습니다. (코드: ${match[1]}) Xbox 프로필/연령 제한/약관 동의를 확인해주세요.`;
    }
    return 'Xbox Live 인증에 실패했습니다. 잠시 후 다시 시도하세요.';
  }
  if (message.startsWith('xbox_claims_missing') || message.startsWith('xsts_claims_missing')) {
    return 'Xbox Live 인증 정보가 부족합니다. 다른 계정으로 다시 시도하세요.';
  }
  if (message.startsWith('mc_login_failed')) {
    return 'Minecraft 서비스 로그인에 실패했습니다.';
  }
  if (message.startsWith('discord_already_linked')) {
    return '이미 다른 마인크래프트 계정과 연결되어 있습니다. 기존 계정으로 로그인하거나 관리자에게 문의해주세요.';
  }
  if (message.startsWith('uuid_already_linked')) {
    return '이미 다른 디스코드 계정과 연결된 마인크래프트 계정입니다. 다른 계정으로 로그인해주세요.';
  }
  if (message.startsWith('link_policy_denied')) {
    return '이미 연결된 계정이 있어 인증이 차단되었습니다. 관리자에게 문의해주세요.';
  }
  if (message.startsWith('session_expired')) {
    return '인증 시간이 만료되었습니다. 다시 인증 링크를 받아주세요.';
  }
  if (message.startsWith('session_not_found')) {
    return '인증 세션을 찾을 수 없습니다. 다시 인증 링크를 받아주세요.';
  }
  if (message.startsWith('ms_token_failed')) {
    return 'Microsoft 로그인 토큰 발급에 실패했습니다.';
  }
  return '인증에 실패했습니다. 잠시 후 다시 시도해주세요.';
}

function buildSignatureBody(timestamp, nonce, payload) {
  return `{"timestamp":${JSON.stringify(timestamp)},"nonce":${JSON.stringify(nonce)},"payload":${JSON.stringify(payload)}}`;
}

function safeEquals(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') {
    return false;
  }
  if (a.length !== b.length) {
    return false;
  }
  const bufferA = Buffer.from(a, 'utf8');
  const bufferB = Buffer.from(b, 'utf8');
  return crypto.timingSafeEqual(bufferA, bufferB);
}

function requireInternalKey(req, res, next) {
  if (!config.internalApiKey) {
    return res.status(500).json({ error: 'internal_key_not_configured' });
  }
  const providedKey = String(req.get('x-internal-key') || '');
  if (!safeEquals(providedKey, config.internalApiKey)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function requireAdminKey(req, res, next) {
  if (!config.adminApiKey) {
    return res.status(500).json({ error: 'admin_key_not_configured' });
  }
  const providedKey = String(req.get('x-admin-key') || '');
  if (!safeEquals(providedKey, config.adminApiKey)) {
    return res.status(403).json({ error: 'forbidden' });
  }
  next();
}

function requireCsrf(req, res, next) {
  if (req.body.csrf_token !== req.session.csrfToken) {
    return res.status(403).render('pages/error', { title: 'Forbidden', message: 'Invalid CSRF token.' });
  }
  next();
}

async function ensureLoggedIn(req, res, next) {
  if (!req.session.user) {
    return res.redirect('/');
  }
  try {
    if (!hasConsent(req, 'discord')) {
      const hasDbConsent = await hasConsentInDb(req.session.user.id, 'discord');
      if (!hasDbConsent) {
        const redirectPath = req.originalUrl || '/guilds';
        return res.redirect(`/consent?flow=discord&redirect=${encodeURIComponent(redirectPath)}`);
      }
      const consent = getConsentState(req);
      consent.discord = Date.now();
    }
  } catch (err) {
    // Allow login flow even if consent check fails.
  }
  next();
}

async function hasGuildPermission(guildId, userId, permission) {
  if (!guildId || !userId || !permission) {
    return false;
  }
  try {
    const rows = await query(
      'SELECT permission FROM guild_permissions WHERE guild_id = ? AND discord_user_id = ?',
      [guildId, userId]
    );
    return rows.some((row) => row.permission === permission);
  } catch (err) {
    return false;
  }
}

async function ensureGuildAccess(req, res, next) {
  const guildId = req.params.guildId;
  const guild = (req.session.guilds || []).find((item) => item.id === guildId);
  if (!guild) {
    return res.status(403).render('pages/error', { title: 'Access denied', message: 'Guild access denied.' });
  }
  req.session.currentGuild = guild;
  res.locals.currentGuild = guild;
  try {
    const userId = req.session.user?.id || null;
    const isOwner = Boolean(guild?.owner || guild?.access_info?.key === 'owner');
    const canManageSettings = isOwner || await hasGuildPermission(guildId, userId, MANAGE_SETTINGS_PERMISSION);
    res.locals.isGuildOwner = isOwner;
    res.locals.canManageSettings = canManageSettings;
    next();
  } catch (err) {
    next(err);
  }
}

function ensureGuildManageSettings(req, res, next) {
  if (!res.locals.canManageSettings) {
    return res.status(403).render('pages/error', { title: 'Access denied', message: '권한이 없습니다.' });
  }
  next();
}

function ensureGuildOwner(req, res, next) {
  if (!res.locals.isGuildOwner) {
    return res.status(403).render('pages/error', { title: 'Access denied', message: 'Owner 권한이 필요합니다.' });
  }
  next();
}

function normalizeArray(value) {
  if (!value) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function buildInClause(items) {
  return items.map(() => '?').join(', ');
}

function policyToText(policyJson) {
  if (!policyJson) {
    return '';
  }
  if (typeof policyJson === 'string') {
    try {
      return JSON.stringify(JSON.parse(policyJson), null, 2);
    } catch (err) {
      return policyJson;
    }
  }
  return JSON.stringify(policyJson, null, 2);
}

function jsonToText(jsonValue) {
  if (!jsonValue) {
    return '';
  }
  if (typeof jsonValue === 'string') {
    try {
      return JSON.stringify(JSON.parse(jsonValue), null, 2);
    } catch (err) {
      return jsonValue;
    }
  }
  return JSON.stringify(jsonValue, null, 2);
}

function parseJsonValue(value) {
  if (!value) {
    return null;
  }
  if (typeof value === 'string') {
    try {
      return JSON.parse(value);
    } catch (err) {
      return null;
    }
  }
  if (typeof value === 'object') {
    return value;
  }
  return null;
}

function resolveMessagePayload(template, key) {
  if (!template || typeof template !== 'object') {
    return null;
  }
  if (template.content || template.embeds || template.components) {
    return template;
  }
  if (key && Object.prototype.hasOwnProperty.call(template, key)) {
    return template[key];
  }
  if (template.default) {
    return template.default;
  }
  return null;
}

function formatKstTimestamp(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const formatter = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
  return formatter.format(date).replace(',', '');
}

function formatKstTimestampDots(value) {
  if (!value) {
    return '-';
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value);
  }
  const parts = new Intl.DateTimeFormat('ko-KR', {
    timeZone: 'Asia/Seoul',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  }).formatToParts(date);
  const getPart = (type) => parts.find((part) => part.type === type)?.value || '';
  return `${getPart('year')}.${getPart('month')}.${getPart('day')}. ${getPart('hour')}:${getPart('minute')}:${getPart('second')}`;
}

function extractMessageFields(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      content: '',
      embed_title: '',
      embed_description: '',
      embed_color: '',
      button_label: '',
      button_url: ''
    };
  }
  const embed = Array.isArray(payload.embeds) ? payload.embeds[0] : null;
  const componentRow = Array.isArray(payload.components) ? payload.components[0] : null;
  const button = componentRow && Array.isArray(componentRow.components) ? componentRow.components[0] : null;
  let embedColor = '';
  if (embed && embed.color !== undefined && embed.color !== null) {
    if (typeof embed.color === 'number') {
      embedColor = `#${embed.color.toString(16).padStart(6, '0')}`;
    } else if (typeof embed.color === 'string') {
      embedColor = embed.color.startsWith('#') ? embed.color : `#${embed.color}`;
    }
  }
  return {
    content: payload.content || '',
    embed_title: embed?.title || '',
    embed_description: embed?.description || '',
    embed_color: embedColor,
    button_label: button?.label || '',
    button_url: button?.url || ''
  };
}

function parseHexColor(value) {
  if (!value) {
    return null;
  }
  const trimmed = String(value).trim();
  if (!trimmed) {
    return null;
  }
  const hex = trimmed.startsWith('#') ? trimmed.slice(1) : trimmed;
  const parsed = Number.parseInt(hex, 16);
  if (Number.isNaN(parsed)) {
    return null;
  }
  return parsed;
}

function buildEndpointUrl(host, port) {
  const trimmed = String(host || '').trim();
  if (!trimmed) {
    return '';
  }
  if (/^https?:\/\//i.test(trimmed)) {
    return trimmed;
  }
  if (port) {
    return `http://${trimmed}:${port}`;
  }
  return `http://${trimmed}`;
}

function buildMessagePayload(fields) {
  const content = (fields.content || '').trim();
  const embedTitle = (fields.embed_title || '').trim();
  const embedDescription = (fields.embed_description || '').trim();
  const embedColor = parseHexColor(fields.embed_color);
  const buttonLabel = (fields.button_label || '').trim();
  const buttonUrl = (fields.button_url || '').trim();

  if (!content && !embedTitle && !embedDescription && !embedColor && !buttonLabel && !buttonUrl) {
    return null;
  }

  const payload = {};
  if (content) {
    payload.content = content;
  }
  if (embedTitle || embedDescription || embedColor !== null) {
    const embed = {};
    if (embedTitle) {
      embed.title = embedTitle;
    }
    if (embedDescription) {
      embed.description = embedDescription;
    }
    if (embedColor !== null) {
      embed.color = embedColor;
    }
    payload.embeds = [embed];
  }
  if (buttonLabel && buttonUrl) {
    payload.components = [
      {
        type: 1,
        components: [
          {
            type: 2,
            style: 5,
            label: buttonLabel,
            url: buttonUrl
          }
        ]
      }
    ];
  }
  return payload;
}

function readMessageFields(body, prefix) {
  const get = (suffix) => (body[`${prefix}_${suffix}`] || '').trim();
  return {
    content: get('content'),
    embed_title: get('embed_title'),
    embed_description: get('embed_description'),
    embed_color: get('embed_color'),
    button_label: get('button_label'),
    button_url: get('button_url')
  };
}

async function attachBotPresence(guilds, userId) {
  if (!config.discordBotToken) {
    return (guilds || []).map((guild) => ({
      ...guild,
      bot_present: false,
      bot_member_count: null,
      bot_presence_count: null,
      access_info: classifyGuildAccess(guild, userId, null)
    }));
  }
  const results = await Promise.all(
    (guilds || []).map(async (guild) => {
      const info = await fetchBotGuildInfo(guild.id).catch(() => ({ present: false, ownerId: null }));
      return {
        ...guild,
        bot_present: info.present,
        bot_member_count: info.memberCount ?? null,
        bot_presence_count: info.presenceCount ?? null,
        access_info: classifyGuildAccess(guild, userId, info.ownerId)
      };
    })
  );
  return results;
}

function normalizeChannelSelection(channels, selectedId) {
  if (!selectedId) {
    return { selectedId: '', selectedName: '길드 기본값' };
  }
  if (selectedId === '__all') {
    return { selectedId: '__all', selectedName: '모든 채널' };
  }
  const match = channels.find((channel) => channel.id === selectedId);
  if (!match) {
    return { selectedId: '', selectedName: 'Guild Default' };
  }
  return { selectedId: match.id, selectedName: match.name };
}

function getBotInviteUrl(guildId) {
  if (!config.discordBotClientId) {
    return '';
  }
  const params = new URLSearchParams({
    client_id: config.discordBotClientId,
    scope: 'bot applications.commands',
    permissions: config.botInvitePermissions
  });
  if (guildId) {
    params.set('guild_id', guildId);
    params.set('disable_guild_select', 'true');
  }
  return `https://discord.com/oauth2/authorize?${params.toString()}`;
}

async function applyChannelContext(req, res, guildId, options = {}) {
  let botPresent = false;
  try {
    botPresent = await fetchBotGuildPresence(guildId);
  } catch (err) {
    botPresent = false;
  }
  let channels = [];
  let roles = [];
  if (botPresent) {
    const cached = guildContextCache.get(guildId);
    const isCacheValid = cached && Date.now() - cached.at < GUILD_CONTEXT_CACHE_TTL_MS;

    if (isCacheValid) {
      channels = cached.channels;
      roles = cached.roles;
    } else {
      const [rawChannels, rawRoles] = await Promise.all([
        fetchGuildChannels(guildId),
        fetchGuildRoles(guildId)
      ]);
      channels = (rawChannels || [])
        .filter((channel) => channel.type === 0 || channel.type === 5)
        .sort((a, b) => (a.position || 0) - (b.position || 0))
        .map((channel) => ({ id: channel.id, name: channel.name }));
      roles = (rawRoles || [])
        .sort((a, b) => (b.position || 0) - (a.position || 0))
        .map((role) => ({ id: role.id, name: role.name, color: role.color }));
      guildContextCache.set(guildId, { at: Date.now(), channels, roles });
    }
  }

  const requested = req.query.channel_id || req.body.channel_id || req.session.currentChannelId || '';
  const normalized = options.allowAll === false && requested === '__all'
    ? normalizeChannelSelection(channels, '')
    : normalizeChannelSelection(channels, requested);

  req.session.currentChannelId = normalized.selectedId;
  res.locals.channelOptions = channels;
  res.locals.selectedChannelId = normalized.selectedId;
  res.locals.currentChannelName = normalized.selectedName;
  res.locals.botPresent = botPresent;
  res.locals.roleOptions = roles;
  res.locals.botInviteUrl = getBotInviteUrl(guildId);
  res.locals.channelQuery = normalized.selectedId ? `?channel_id=${normalized.selectedId}` : '';

  return { selectedChannelId: normalized.selectedId, botPresent };
}

async function ensureUserGuildLink(guildId, userId) {
  if (!userId) {
    return;
  }
  await query(
    'INSERT INTO user_guild_links (guild_id, user_id, linked_at) VALUES (?, ?, NOW()) ON DUPLICATE KEY UPDATE linked_at = linked_at',
    [guildId, userId]
  );
}

async function listUserGuildLinks(userId) {
  if (!userId) {
    return [];
  }
  return query('SELECT guild_id, linked_at FROM user_guild_links WHERE user_id = ?', [userId]);
}

async function fetchUserVerificationLinks(userId, guildMap) {
  if (!userId) {
    return { links: [] };
  }

  const verificationRows = await query(
    "SELECT guild_id, status, verified_at, mc_uuid FROM guild_verifications WHERE discord_user_id = ? AND status = 'verified' ORDER BY verified_at DESC",
    [userId]
  );

  if (verificationRows.length === 0) {
    return { links: [] };
  }

  const latestEvents = await query(
    `SELECT e.guild_id, e.mc_uuid, e.mc_ign, e.occurred_at, e.created_at
     FROM events e
     JOIN (
       SELECT guild_id, MAX(created_at) AS max_created
       FROM events
       WHERE discord_user_id = ? AND event_type IN ('verification.completed', 'verification.reverified')
       GROUP BY guild_id
     ) latest
     ON e.guild_id = latest.guild_id AND e.created_at = latest.max_created
     WHERE e.discord_user_id = ?`,
    [userId, userId]
  );

  const eventMap = latestEvents.reduce((acc, row) => {
    acc[row.guild_id] = row;
    return acc;
  }, {});

  const guildIds = [...new Set(verificationRows.map((row) => row.guild_id))];
  const serverMap = {};
  if (guildIds.length > 0) {
    const placeholders = buildInClause(guildIds);
    const servers = await query(
      `SELECT guild_id, server_name FROM guild_servers WHERE guild_id IN (${placeholders}) AND enabled = 1`,
      guildIds
    );
    for (const server of servers) {
      if (!serverMap[server.guild_id]) {
        serverMap[server.guild_id] = [];
      }
      serverMap[server.guild_id].push(server.server_name);
    }
  }

  const missingGuildIds = guildIds.filter((guildId) => !guildMap[guildId]?.name);
  const botInfoMap = {};
  if (config.discordBotToken && missingGuildIds.length > 0) {
    const botInfos = await Promise.all(
      missingGuildIds.map(async (guildId) => ({
        guildId,
        info: await fetchBotGuildInfo(guildId).catch(() => null)
      }))
    );
    botInfos.forEach(({ guildId, info }) => {
      if (info && info.present) {
        botInfoMap[guildId] = info;
      }
    });
  }

  const links = verificationRows.map((row) => {
    const guildInfo = guildMap[row.guild_id];
    const fallbackInfo = botInfoMap[row.guild_id];
    const eventInfo = eventMap[row.guild_id] || {};
    const verifiedAt = row.verified_at || eventInfo.occurred_at;
    const fallbackName = (serverMap[row.guild_id] || [])[0] || '알 수 없는 서버';
    return {
      guild_id: row.guild_id,
      guild_name: guildInfo?.name || fallbackInfo?.name || fallbackName,
      guild_icon: guildInfo?.icon || fallbackInfo?.icon || null,
      status: row.status,
      verified_at: verifiedAt,
      verified_at_display: formatKstTimestampDots(verifiedAt),
      mc_uuid: eventInfo.mc_uuid || row.mc_uuid,
      mc_ign: eventInfo.mc_ign || null,
      servers: serverMap[row.guild_id] || [],
      has_access: Boolean(guildInfo),
      bot_present: guildInfo?.bot_present || fallbackInfo?.present || false,
      access_info: guildInfo?.access_info || null
    };
  });

  return { links };
}

async function createOAuthState(sessionId) {
  const state = randomId().replace(/-/g, '');
  await query(
    'INSERT INTO oauth_states (state, session_id, created_at, expires_at) VALUES (?, ?, NOW(), DATE_ADD(NOW(), INTERVAL 10 MINUTE))',
    [state, sessionId]
  );
  return state;
}

async function consumeOAuthState(state) {
  const rows = await query(
    'SELECT session_id, expires_at FROM oauth_states WHERE state = ?',
    [state]
  );
  await query('DELETE FROM oauth_states WHERE state = ?', [state]);
  if (rows.length === 0) {
    return null;
  }
  if (new Date(rows[0].expires_at).getTime() < Date.now()) {
    return null;
  }
  return rows[0];
}

function cacheMicrosoftOAuthState(req, state, sessionId) {
  req.session.msOauthState = state;
  req.session.msSessionId = sessionId;
  req.session.msStateExpiresAt = Date.now() + 10 * 60 * 1000;
}

function clearMicrosoftOAuthState(req) {
  req.session.msOauthState = null;
  req.session.msSessionId = null;
  req.session.msStateExpiresAt = null;
}

async function recoverSessionFromMicrosoftState(req, state) {
  const cachedState = req.session.msOauthState;
  const cachedSessionId = req.session.msSessionId;
  const expiresAt = req.session.msStateExpiresAt;
  if (!cachedState || !cachedSessionId) {
    return null;
  }
  if (cachedState !== state) {
    return null;
  }
  if (expiresAt && Date.now() > expiresAt) {
    return null;
  }
  return getSession(cachedSessionId);
}

app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// Landing / Guild list
app.get('/', (req, res) => {
  if (!req.session.user) {
    return res.render('pages/home', { title: 'LunaF Verify', managedGuilds: [] });
  }
  req.session.currentGuild = null;
  return res.redirect('/guilds');
});

app.get('/guilds', ensureLoggedIn, (req, res) => {
  req.session.currentGuild = null;
  const botInviteUrlBase = getBotInviteUrl();
  Promise.all([
    attachBotPresence(req.session.guilds || [], req.session.user.id)
  ])
    .then(async ([updated]) => {
      req.session.guilds = updated;
      const guildMap = updated.reduce((acc, guild) => {
        acc[guild.id] = guild;
        return acc;
      }, {});
      const userLinks = await fetchUserVerificationLinks(req.session.user.id, guildMap);
      res.render('pages/guilds', {
        title: 'Select Guild',
        managedGuilds: req.session.guilds || [],
        userLinks: userLinks || { account: null, links: [] },
        botInviteUrlBase,
        selectedTab: 'linked'
      });
    })
    .catch(() => {
      res.render('pages/guilds', {
        title: 'Select Guild',
        managedGuilds: req.session.guilds || [],
        userLinks: { account: null, links: [] },
        botInviteUrlBase,
        selectedTab: 'linked'
      });
    });
});

app.get('/guilds/select', ensureLoggedIn, (req, res) => {
  req.session.currentGuild = null;
  const botInviteUrlBase = getBotInviteUrl();
  Promise.all([
    attachBotPresence(req.session.guilds || [], req.session.user.id)
  ])
    .then(async ([updated]) => {
      req.session.guilds = updated;
      const guildMap = updated.reduce((acc, guild) => {
        acc[guild.id] = guild;
        return acc;
      }, {});
      const userLinks = await fetchUserVerificationLinks(req.session.user.id, guildMap);
      res.render('pages/guilds-select', {
        title: 'Select Guild',
        managedGuilds: req.session.guilds || [],
        userLinks,
        botInviteUrlBase,
        selectedTab: 'managed'
      });
    })
    .catch(() => {
      res.render('pages/guilds-select', {
        title: 'Select Guild',
        managedGuilds: req.session.guilds || [],
        userLinks: { account: null, links: [] },
        botInviteUrlBase,
        selectedTab: 'managed'
      });
    });
});

app.get('/guilds/:guildId', ensureLoggedIn, ensureGuildAccess, async (req, res) => {
  const guildId = req.params.guildId;
  await ensureUserGuildLink(guildId, req.session.user.id);
  const verifiedCount = await query(
    "SELECT COUNT(*) AS count FROM guild_verifications WHERE guild_id = ? AND status = 'verified'",
    [guildId]
  );
  const eventCount = await query(
    'SELECT COUNT(*) AS count FROM events WHERE guild_id = ?',
    [guildId]
  );
  const failedDeliveries = await query(
    "SELECT COUNT(*) AS count FROM push_deliveries WHERE guild_id = ? AND status = 'failed'",
    [guildId]
  );
  const recentEvents = await query(
    'SELECT event_id, event_type, discord_user_id, mc_ign, occurred_at FROM events WHERE guild_id = ? ORDER BY created_at DESC LIMIT 5',
    [guildId]
  );
  const formattedEvents = (recentEvents || []).map((event) => ({
    ...event,
    occurred_at_display: formatKstTimestamp(event.occurred_at)
  }));
  res.render('pages/guild-overview', {
    title: 'Dashboard',
    stats: {
      verified: verifiedCount[0]?.count || 0,
      events: eventCount[0]?.count || 0,
      failed: failedDeliveries[0]?.count || 0
    },
    recentEvents: formattedEvents
  });
});

// Discord OAuth
app.get('/auth/discord', (req, res) => {
  if (!config.discordOAuth.clientId || !config.discordOAuth.clientSecret || !config.discordOAuth.redirectUri) {
    return res.status(500).render('pages/error', { title: 'Discord OAuth', message: 'Discord OAuth is not configured.' });
  }
  const state = randomId();
  req.session.discordOauthState = state;
  const url = getDiscordAuthorizeUrl(state);
  res.redirect(url);
});

app.get('/auth/discord/callback', async (req, res) => {
  const { code, state } = req.query;
  if (!code || state !== req.session.discordOauthState) {
    return res.status(400).render('pages/error', {
      title: 'Login failed',
      message: '로그인 상태가 만료되었거나 여러 탭에서 동시에 진행되어 검증에 실패했습니다. 쿠키를 허용한 뒤 다시 로그인해주세요.'
    });
  }

  try {
    const tokens = await exchangeDiscordCode(String(code));
    const user = await fetchDiscordUser(tokens.access_token);
    const guilds = await fetchDiscordGuilds(tokens.access_token);
    const managedGuilds = filterManagedGuilds(guilds);
    const guildsWithPresence = await attachBotPresence(managedGuilds, user.id);

    req.session.user = {
      id: user.id,
      username: user.username,
      avatar: user.avatar
    };
    req.session.guilds = guildsWithPresence;
    req.session.discordOauthState = null;
    const hasDbConsent = await hasConsentInDb(user.id, 'discord');
    if (!hasDbConsent) {
      const consent = getConsentState(req);
      if (consent.discord) {
        await recordConsentInDb(user.id, 'discord');
      } else {
        return res.redirect('/consent?flow=discord&redirect=%2Fguilds');
      }
    }
    res.redirect('/guilds');
  } catch (err) {
    res.status(500).render('pages/error', { title: 'Login failed', message: 'Discord OAuth failed.' });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/');
  });
});

app.get('/info', (req, res) => {
  res.render('pages/info', { title: 'Service Introduction' });
});

app.get('/privacy', (req, res) => {
  res.render('pages/privacy', { title: 'Privacy' });
});

app.get('/terms', (req, res) => {
  res.render('pages/terms', { title: 'Terms' });
});

// Verification flow
app.get('/verify/:sessionId', async (req, res) => {
  const sessionRow = await getSession(req.params.sessionId);
  if (!sessionRow) {
    return res.status(404).render('pages/verify', { title: 'Verify', session: null, status: 'not_found' });
  }

  if (sessionRow.status === 'completed') {
    return res.render('pages/verify', { title: 'Verify', session: sessionRow, status: 'completed' });
  }

  if (new Date(sessionRow.expires_at).getTime() < Date.now()) {
    return res.render('pages/verify', { title: 'Verify', session: sessionRow, status: 'expired' });
  }

  res.render('pages/verify', { title: 'Verify', session: sessionRow, status: 'pending' });
});

app.get('/auth/microsoft', async (req, res) => {
  const sessionId = req.query.session_id;
  if (!sessionId) {
    return res.status(400).render('pages/error', { title: 'Invalid session', message: 'Session id missing.' });
  }

  const sessionRow = await getSession(String(sessionId));
  if (!sessionRow) {
    return res.status(404).render('pages/error', { title: 'Invalid session', message: 'Session not found.' });
  }

  const hasDbConsent = await hasConsentInDb(sessionRow.discord_user_id, 'microsoft');
  if (!hasDbConsent && !hasConsent(req, 'microsoft')) {
    const redirectPath = `/auth/microsoft?session_id=${encodeURIComponent(sessionRow.session_id)}`;
    return res.redirect(`/consent?flow=microsoft&redirect=${encodeURIComponent(redirectPath)}`);
  }
  if (!hasDbConsent && hasConsent(req, 'microsoft')) {
    await recordConsentInDb(sessionRow.discord_user_id, 'microsoft');
  }

  if (!config.microsoftOAuth.clientId || !config.microsoftOAuth.clientSecret || !config.microsoftOAuth.redirectUri) {
    return res.status(500).render('pages/error', { title: 'Microsoft OAuth', message: 'Microsoft OAuth is not configured.' });
  }

  const state = await createOAuthState(sessionRow.session_id);
  cacheMicrosoftOAuthState(req, state, sessionRow.session_id);
  const url = getMicrosoftAuthorizeUrl(state);
  res.redirect(url);
});

function stashMicrosoftResult(req, result) {
  req.session.msAuthResult = result;
  req.session.msAuthError = null;
}

function stashMicrosoftError(req, title, message, status = 400) {
  req.session.msAuthError = { title, message, status };
  req.session.msAuthResult = null;
}

async function handleMicrosoftCallback(req, res) {
  const code = req.body.code || req.query.code;
  const state = req.body.state || req.query.state;
  const error = req.body.error || req.query.error;
  const errorDescription = req.body.error_description || req.query.error_description;

  if (error) {
    const message = errorDescription ? String(errorDescription) : `Microsoft 로그인에 실패했습니다. (${error})`;
    stashMicrosoftError(req, 'Login failed', message);
    clearMicrosoftOAuthState(req);
    return res.redirect('/auth/microsoft/result');
  }

  if (!code || !state) {
    stashMicrosoftError(req, 'Login failed', 'Missing OAuth code.');
    clearMicrosoftOAuthState(req);
    return res.redirect('/auth/microsoft/result');
  }

  try {
    let oauthState = await consumeOAuthState(String(state));
    if (!oauthState) {
      const fallbackSession = await recoverSessionFromMicrosoftState(req, String(state));
      if (fallbackSession) {
        oauthState = { session_id: fallbackSession.session_id };
      } else {
        clearMicrosoftOAuthState(req);
        stashMicrosoftError(req, 'Login failed', '인증 정보가 만료되었습니다. 다시 시도해주세요.');
        return res.redirect('/auth/microsoft/result');
      }
    }
    clearMicrosoftOAuthState(req);

    const profile = await verifyMinecraftOwnership(String(code));
    await completeSession({
      sessionId: oauthState.session_id,
      mcUuid: profile.mc_uuid,
      mcIgn: profile.mc_ign,
      entitlements: profile.entitlements
    });

    stashMicrosoftResult(req, { mc_uuid: profile.mc_uuid, mc_ign: profile.mc_ign });
    return res.redirect('/auth/microsoft/result');
  } catch (err) {
    console.error('Microsoft OAuth verification failed', err);
    stashMicrosoftError(req, 'Verification failed', mapMicrosoftErrorMessage(err));
    return res.redirect('/auth/microsoft/result');
  }
}

app.get('/auth/microsoft/callback', handleMicrosoftCallback);
app.post('/auth/microsoft/callback', handleMicrosoftCallback);

app.get('/auth/microsoft/result', (req, res) => {
  const result = req.session.msAuthResult || null;
  const error = req.session.msAuthError || null;
  req.session.msAuthResult = null;
  req.session.msAuthError = null;

  if (result) {
    return res.render('pages/verify-result', {
      title: 'Verification Complete',
      result
    });
  }

  if (error) {
    return res.status(error.status || 400).render('pages/error', {
      title: error.title || 'Verification failed',
      message: error.message || '인증에 실패했습니다.'
    });
  }

  return res.redirect('/');
});

app.get('/verify/:sessionId/mock-complete', async (req, res) => {
  if (!config.allowMockMsLogin) {
    return res.status(403).render('pages/error', { title: 'Mock login disabled', message: 'Mock login is disabled.' });
  }
  const { uuid, ign } = req.query;
  if (!uuid || !ign) {
    return res.status(400).render('pages/error', { title: 'Missing data', message: 'Missing uuid or ign.' });
  }
  try {
    await completeSession({
      sessionId: req.params.sessionId,
      mcUuid: String(uuid),
      mcIgn: String(ign)
    });
    res.render('pages/verify-result', {
      title: 'Verification Complete',
      result: { mc_uuid: String(uuid), mc_ign: String(ign) }
    });
  } catch (err) {
    res.status(400).render('pages/error', { title: 'Verification failed', message: err.message });
  }
});

// Dashboard: Settings
app.get('/guilds/:guildId/settings', ensureLoggedIn, ensureGuildAccess, async (req, res) => {
  const { selectedChannelId } = await applyChannelContext(req, res, req.params.guildId);
  const isAllChannels = selectedChannelId === '__all';
  let settings = {};
  if (!isAllChannels && selectedChannelId) {
    const rows = await query(
      'SELECT * FROM guild_channel_settings WHERE guild_id = ? AND channel_id = ?',
      [req.params.guildId, selectedChannelId]
    );
    settings = rows[0] || {};
  } else if (!isAllChannels) {
    const rows = await query('SELECT * FROM guilds WHERE guild_id = ?', [req.params.guildId]);
    settings = rows[0] || {};
  }
  const policyValue = parseJsonValue(settings.policy_json) || {};
  const selectedLinkPolicy = policyValue.link_policy || 'strict';
  let channelSettings = [];
  if (isAllChannels) {
    channelSettings = await query(
      'SELECT channel_id, verified_role_id, log_channel_id, nickname_format, bot_message_template, policy_json, bot_message_payload, verify_reply_payload FROM guild_channel_settings WHERE guild_id = ?',
      [req.params.guildId]
    );
  }
  res.render('pages/settings', {
    title: 'Guild Settings',
    settings,
    selectedLinkPolicy,
    isAllChannels,
    channelSettings
  });
});

app.post('/guilds/:guildId/settings', ensureLoggedIn, ensureGuildAccess, requireCsrf, async (req, res) => {
  const {
    verified_role_id,
    log_channel_id,
    nickname_format,
    link_policy,
    channel_id
  } = req.body;
  const channelId = channel_id === '__all' ? null : channel_id;

  const allowedPolicies = new Set(['strict', 'deny', 'overwrite']);
  const normalizedLinkPolicy = allowedPolicies.has(link_policy) ? link_policy : 'strict';
  const policyValue = { link_policy: normalizedLinkPolicy };

  if (channelId) {
    const existingRows = await query(
      'SELECT channel_id FROM guild_channel_settings WHERE guild_id = ? AND channel_id = ?',
      [req.params.guildId, channelId]
    );
    if (existingRows.length > 0) {
      await query(
        `UPDATE guild_channel_settings
         SET verified_role_id = ?, log_channel_id = ?, nickname_format = ?, policy_json = ?, updated_at = NOW()
         WHERE guild_id = ? AND channel_id = ?`,
        [
          verified_role_id || null,
          log_channel_id || null,
          nickname_format || null,
          JSON.stringify(policyValue),
          req.params.guildId,
          channelId
        ]
      );
    } else {
      const baseRows = await query(
        'SELECT bot_message_template, bot_message_payload, verify_reply_payload FROM guilds WHERE guild_id = ?',
        [req.params.guildId]
      );
      const base = baseRows[0] || {};
      const baseBotPayload = base.bot_message_payload;
      const baseVerifyPayload = base.verify_reply_payload;
      await query(
        `INSERT INTO guild_channel_settings
          (guild_id, channel_id, verified_role_id, log_channel_id, nickname_format, bot_message_template, bot_message_payload, verify_reply_payload, policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          req.params.guildId,
          channelId,
          verified_role_id || null,
          log_channel_id || null,
          nickname_format || null,
          base.bot_message_template || null,
          baseBotPayload == null ? null : (typeof baseBotPayload === 'string' ? baseBotPayload : JSON.stringify(baseBotPayload)),
          baseVerifyPayload == null ? null : (typeof baseVerifyPayload === 'string' ? baseVerifyPayload : JSON.stringify(baseVerifyPayload)),
          JSON.stringify(policyValue)
        ]
      );
    }
  } else {
    await query(
      `INSERT INTO guilds (guild_id, verified_role_id, log_channel_id, nickname_format, policy_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         verified_role_id = VALUES(verified_role_id),
         log_channel_id = VALUES(log_channel_id),
         nickname_format = VALUES(nickname_format),
         policy_json = VALUES(policy_json),
         updated_at = NOW()`,
      [
        req.params.guildId,
        verified_role_id || null,
        log_channel_id || null,
        nickname_format || null,
        JSON.stringify(policyValue)
      ]
    );
  }

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'guild.settings.update',
    diff: {
      channel_id: channelId || null,
      verified_role_id,
      log_channel_id,
      nickname_format,
      link_policy: normalizedLinkPolicy
    }
  });

  setFlash(req, 'success', 'Settings saved.');
  const redirectQuery = channelId ? `?channel_id=${channelId}` : '';
  res.redirect(`/guilds/${req.params.guildId}/settings${redirectQuery}`);
});

// Dashboard: Messages
app.get('/guilds/:guildId/messages', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, async (req, res) => {
  res.locals.allowAllChannels = false;
  const { selectedChannelId } = await applyChannelContext(req, res, req.params.guildId, { allowAll: false });
  const settings = await loadSettings(req.params.guildId, selectedChannelId || null);
  const botPayload = parseJsonValue(settings.bot_message_payload);
  const verifyPayload = parseJsonValue(settings.verify_reply_payload);
  const verifyStartPayload = resolveMessagePayload(verifyPayload, 'verify.start')
    || resolveMessagePayload(verifyPayload, 'verify.success');
  const botMessageFields = {
    default: extractMessageFields(resolveMessagePayload(botPayload, 'default')),
    verification_completed: extractMessageFields(resolveMessagePayload(botPayload, 'verification.completed')),
    verification_revoked: extractMessageFields(resolveMessagePayload(botPayload, 'verification.revoked')),
    verification_reverified: extractMessageFields(resolveMessagePayload(botPayload, 'verification.reverified')),
    dm_verification_completed: extractMessageFields(resolveMessagePayload(botPayload, 'dm.verification.completed'))
  };
  if (!botMessageFields.default.content && settings.bot_message_template) {
    botMessageFields.default.content = settings.bot_message_template;
  }
  const verifyMessageFields = {
    start: extractMessageFields(verifyStartPayload),
    error_forbidden: extractMessageFields(resolveMessagePayload(verifyPayload, 'verify.error.forbidden')),
    error_server: extractMessageFields(resolveMessagePayload(verifyPayload, 'verify.error.server')),
    error_unreachable: extractMessageFields(resolveMessagePayload(verifyPayload, 'verify.error.unreachable')),
    error_default: extractMessageFields(resolveMessagePayload(verifyPayload, 'verify.error.default'))
  };
  res.render('pages/messages', {
    title: 'Messages',
    botMessageFields,
    verifyMessageFields
  });
});

app.post('/guilds/:guildId/messages', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  const { channel_id } = req.body;
  const channelId = channel_id === '__all' ? null : channel_id;

  const defaultMessageFields = readMessageFields(req.body, 'log_default');
  const botMessagePayloadValue = {};
  const defaultPayload = buildMessagePayload(defaultMessageFields);
  if (defaultPayload) {
    botMessagePayloadValue.default = defaultPayload;
  }
  const completedPayload = buildMessagePayload(readMessageFields(req.body, 'log_verification_completed'));
  if (completedPayload) {
    botMessagePayloadValue['verification.completed'] = completedPayload;
  }
  const revokedPayload = buildMessagePayload(readMessageFields(req.body, 'log_verification_revoked'));
  if (revokedPayload) {
    botMessagePayloadValue['verification.revoked'] = revokedPayload;
  }
  const reverifiedPayload = buildMessagePayload(readMessageFields(req.body, 'log_verification_reverified'));
  if (reverifiedPayload) {
    botMessagePayloadValue['verification.reverified'] = reverifiedPayload;
  }
  const dmCompletedPayload = buildMessagePayload(readMessageFields(req.body, 'dm_verification_completed'));
  if (dmCompletedPayload) {
    botMessagePayloadValue['dm.verification.completed'] = dmCompletedPayload;
  }
  const finalBotMessagePayload = Object.keys(botMessagePayloadValue).length ? botMessagePayloadValue : null;

  const verifyReplyPayloadValue = {};
  const verifyStartPayload = buildMessagePayload(readMessageFields(req.body, 'verify_start'));
  if (verifyStartPayload) {
    verifyReplyPayloadValue['verify.start'] = verifyStartPayload;
  }
  const verifyForbiddenPayload = buildMessagePayload(readMessageFields(req.body, 'verify_error_forbidden'));
  if (verifyForbiddenPayload) {
    verifyReplyPayloadValue['verify.error.forbidden'] = verifyForbiddenPayload;
  }
  const verifyServerPayload = buildMessagePayload(readMessageFields(req.body, 'verify_error_server'));
  if (verifyServerPayload) {
    verifyReplyPayloadValue['verify.error.server'] = verifyServerPayload;
  }
  const verifyUnreachablePayload = buildMessagePayload(readMessageFields(req.body, 'verify_error_unreachable'));
  if (verifyUnreachablePayload) {
    verifyReplyPayloadValue['verify.error.unreachable'] = verifyUnreachablePayload;
  }
  const verifyDefaultPayload = buildMessagePayload(readMessageFields(req.body, 'verify_error_default'));
  if (verifyDefaultPayload) {
    verifyReplyPayloadValue['verify.error.default'] = verifyDefaultPayload;
  }
  const finalVerifyReplyPayload = Object.keys(verifyReplyPayloadValue).length ? verifyReplyPayloadValue : null;

  const bot_message_template = defaultMessageFields.content || null;
  const botMessagePayloadJson = finalBotMessagePayload ? JSON.stringify(finalBotMessagePayload) : null;
  const verifyReplyPayloadJson = finalVerifyReplyPayload ? JSON.stringify(finalVerifyReplyPayload) : null;

  if (channelId) {
    const existingRows = await query(
      'SELECT channel_id FROM guild_channel_settings WHERE guild_id = ? AND channel_id = ?',
      [req.params.guildId, channelId]
    );
    if (existingRows.length > 0) {
      await query(
        `UPDATE guild_channel_settings
         SET bot_message_template = ?, bot_message_payload = ?, verify_reply_payload = ?, updated_at = NOW()
         WHERE guild_id = ? AND channel_id = ?`,
        [
          bot_message_template || null,
          botMessagePayloadJson,
          verifyReplyPayloadJson,
          req.params.guildId,
          channelId
        ]
      );
    } else {
      const baseRows = await query(
        'SELECT verified_role_id, log_channel_id, nickname_format, policy_json FROM guilds WHERE guild_id = ?',
        [req.params.guildId]
      );
      const base = baseRows[0] || {};
      const basePolicy = base.policy_json;
      await query(
        `INSERT INTO guild_channel_settings
          (guild_id, channel_id, verified_role_id, log_channel_id, nickname_format, bot_message_template, bot_message_payload, verify_reply_payload, policy_json, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())`,
        [
          req.params.guildId,
          channelId,
          base.verified_role_id || null,
          base.log_channel_id || null,
          base.nickname_format || null,
          bot_message_template || null,
          botMessagePayloadJson,
          verifyReplyPayloadJson,
          basePolicy == null ? null : (typeof basePolicy === 'string' ? basePolicy : JSON.stringify(basePolicy))
        ]
      );
    }
  } else {
    await query(
      `INSERT INTO guilds (guild_id, bot_message_template, bot_message_payload, verify_reply_payload, created_at, updated_at)
       VALUES (?, ?, ?, ?, NOW(), NOW())
       ON DUPLICATE KEY UPDATE
         bot_message_template = VALUES(bot_message_template),
         bot_message_payload = VALUES(bot_message_payload),
         verify_reply_payload = VALUES(verify_reply_payload),
         updated_at = NOW()`,
      [
        req.params.guildId,
        bot_message_template || null,
        botMessagePayloadJson,
        verifyReplyPayloadJson
      ]
    );
  }

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'guild.messages.update',
    diff: {
      channel_id: channelId || null,
      bot_message_template,
      bot_message_payload: finalBotMessagePayload ? true : false,
      verify_reply_payload: finalVerifyReplyPayload ? true : false
    }
  });

  setFlash(req, 'success', 'Messages saved.');
  const redirectQuery = channelId ? `?channel_id=${channelId}` : '';
  res.redirect(`/guilds/${req.params.guildId}/messages${redirectQuery}`);
});

// Dashboard: Servers
app.get('/guilds/:guildId/servers', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, async (req, res) => {
  await applyChannelContext(req, res, req.params.guildId);
  const serversRaw = await query(
    'SELECT server_id, server_name, server_host, server_port, enabled, last_seen_at FROM guild_servers WHERE guild_id = ?',
    [req.params.guildId]
  );
  const servers = (serversRaw || []).map((server) => ({
    ...server,
    last_seen_at_display: formatKstTimestampDots(server.last_seen_at)
  }));
  res.render('pages/servers', { title: 'Servers', servers });
});

app.post('/guilds/:guildId/servers', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  await applyChannelContext(req, res, req.params.guildId);
  const { server_name, server_host, server_port } = req.body;
  const portValue = Number.parseInt(server_port, 10);
  if (!server_name || !server_host || Number.isNaN(portValue)) {
    setFlash(req, 'error', 'Server name, host, and port are required.');
    return res.redirect(`/guilds/${req.params.guildId}/servers`);
  }
  if (portValue < 1 || portValue > 65535) {
    setFlash(req, 'error', 'Server port must be between 1 and 65535.');
    return res.redirect(`/guilds/${req.params.guildId}/servers`);
  }

  const serverId = ulid();
  const serverSecret = randomId().replace(/-/g, '');

  const endpointUrl = buildEndpointUrl(server_host, portValue);
  await query(
    `INSERT INTO guild_servers
      (guild_id, server_id, server_name, server_host, server_port, endpoint_url, server_secret, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
    [req.params.guildId, serverId, server_name, server_host.trim(), portValue, endpointUrl, serverSecret]
  );

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'guild.server.create',
    diff: { server_id: serverId, server_name, server_host: server_host.trim(), server_port: portValue }
  });

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  res.render('pages/server-secret', {
    title: 'Server Secret',
    server: { server_id: serverId, server_name, server_host: server_host.trim(), server_port: portValue, server_secret: serverSecret }
  });
});

app.post('/guilds/:guildId/servers/:serverId/toggle', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  await applyChannelContext(req, res, req.params.guildId);
  const action = req.body.action;
  const rows = await query(
    'SELECT enabled FROM guild_servers WHERE guild_id = ? AND server_id = ?',
    [req.params.guildId, req.params.serverId]
  );
  if (rows.length === 0) {
    setFlash(req, 'error', 'Server not found.');
    return res.redirect(`/guilds/${req.params.guildId}/servers`);
  }

  const enabled = action === 'enable' ? 1 : action === 'disable' ? 0 : rows[0].enabled ? 0 : 1;
  await query(
    'UPDATE guild_servers SET enabled = ?, updated_at = NOW() WHERE guild_id = ? AND server_id = ?',
    [enabled, req.params.guildId, req.params.serverId]
  );

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'guild.server.toggle',
    diff: { server_id: req.params.serverId, enabled }
  });

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  setFlash(req, 'success', 'Server updated.');
  res.redirect(`/guilds/${req.params.guildId}/servers`);
});

app.post('/guilds/:guildId/servers/:serverId/rotate', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  await applyChannelContext(req, res, req.params.guildId);
  const serverSecret = randomId().replace(/-/g, '');
  await query(
    'UPDATE guild_servers SET server_secret = ?, updated_at = NOW() WHERE guild_id = ? AND server_id = ?',
    [serverSecret, req.params.guildId, req.params.serverId]
  );

  const rows = await query(
    'SELECT server_name, server_host, server_port FROM guild_servers WHERE guild_id = ? AND server_id = ?',
    [req.params.guildId, req.params.serverId]
  );
  const serverInfo = rows[0] || {};

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'guild.server.rotate',
    diff: { server_id: req.params.serverId }
  });

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  res.render('pages/server-secret', {
    title: 'Server Secret',
    server: {
      server_id: req.params.serverId,
      server_name: serverInfo.server_name,
      server_host: serverInfo.server_host,
      server_port: serverInfo.server_port,
      server_secret: serverSecret
    }
  });
});

app.post('/guilds/:guildId/servers/:serverId/delete', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  await applyChannelContext(req, res, req.params.guildId);
  const rows = await query(
    'SELECT server_name FROM guild_servers WHERE guild_id = ? AND server_id = ?',
    [req.params.guildId, req.params.serverId]
  );
  if (rows.length === 0) {
    setFlash(req, 'error', 'Server not found.');
    return res.redirect(`/guilds/${req.params.guildId}/servers`);
  }

  await query('DELETE FROM guild_servers WHERE guild_id = ? AND server_id = ?', [
    req.params.guildId,
    req.params.serverId
  ]);
  await query('DELETE FROM push_deliveries WHERE server_id = ?', [req.params.serverId]);

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'guild.server.delete',
    diff: { server_id: req.params.serverId, server_name: rows[0].server_name }
  });

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  setFlash(req, 'success', 'Server removed.');
  res.redirect(`/guilds/${req.params.guildId}/servers`);
});

app.post('/guilds/:guildId/servers/:serverId/test', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  await applyChannelContext(req, res, req.params.guildId);
  const eventId = ulid();
  const payload = {
    event_id: eventId,
    event_type: 'test.ping',
    guild_id: req.params.guildId,
    discord_user_id: '0',
    mc_uuid: '00000000-0000-0000-0000-000000000000',
    mc_ign: 'TestUser',
    occurred_at: new Date().toISOString(),
    actions: []
  };

  await query(
    `INSERT INTO events
      (event_id, event_type, guild_id, discord_user_id, mc_uuid, mc_ign, occurred_at, payload_json, created_at)
     VALUES (?, 'test.ping', ?, ?, ?, ?, ?, ?, NOW())`,
    [eventId, req.params.guildId, '0', payload.mc_uuid, payload.mc_ign, payload.occurred_at, JSON.stringify({ test: true })]
  );

  await pushEventToServers(payload, { serverIds: [req.params.serverId], skipActions: true, bypassRouting: true });

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  setFlash(req, 'success', 'Test push dispatched.');
  res.redirect(`/guilds/${req.params.guildId}/servers`);
});

// Dashboard: Action profiles
app.get('/guilds/:guildId/actions', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, async (req, res) => {
  const { selectedChannelId } = await applyChannelContext(req, res, req.params.guildId);
  let profiles = [];
  let showChannelColumn = false;
  let channelNameMap = {};
  if (selectedChannelId === '__all') {
    profiles = await query(
      'SELECT profile_id, name, trigger_event, enabled, updated_at, channel_id FROM action_profiles WHERE guild_id = ?',
      [req.params.guildId]
    );
    showChannelColumn = true;
    channelNameMap = res.locals.channelOptions.reduce((acc, channel) => {
      acc[channel.id] = channel.name;
      return acc;
    }, {});
  } else {
    profiles = await query(
      'SELECT profile_id, name, trigger_event, enabled, updated_at FROM action_profiles WHERE guild_id = ? AND channel_id <=> ?',
      [req.params.guildId, selectedChannelId || null]
    );
  }
  profiles = (profiles || []).map((profile) => ({
    ...profile,
    updated_at_display: formatKstTimestampDots(profile.updated_at)
  }));
  res.render('pages/actions', {
    title: 'Action Profiles',
    profiles,
    showChannelColumn,
    channelNameMap
  });
});

app.get('/guilds/:guildId/actions/new', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, async (req, res) => {
  res.locals.allowAllChannels = false;
  await applyChannelContext(req, res, req.params.guildId, { allowAll: false });
  res.render('pages/action-edit', {
    title: 'New Action Profile',
    profile: null,
    eventTypes
  });
});

app.post('/guilds/:guildId/actions', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  const { name, trigger_event, actions_json, enabled, channel_id } = req.body;
  const channelId = channel_id === '__all' ? null : channel_id;
  const redirectQuery = channelId ? `?channel_id=${channelId}` : '';
  if (!name || !trigger_event) {
    setFlash(req, 'error', 'Name and event type are required.');
    return res.redirect(`/guilds/${req.params.guildId}/actions/new${redirectQuery}`);
  }
  if (!allowedEventTypeKeys.has(trigger_event)) {
    setFlash(req, 'error', 'Unsupported event type.');
    return res.redirect(`/guilds/${req.params.guildId}/actions/new${redirectQuery}`);
  }

  let actions;
  try {
    actions = actions_json ? JSON.parse(actions_json) : [];
  } catch (err) {
    setFlash(req, 'error', 'Actions JSON is invalid.');
    return res.redirect(`/guilds/${req.params.guildId}/actions/new${redirectQuery}`);
  }

  if (!Array.isArray(actions)) {
    setFlash(req, 'error', 'Actions must be a JSON array.');
    return res.redirect(`/guilds/${req.params.guildId}/actions/new${redirectQuery}`);
  }

  const profileId = ulid();
  await query(
    `INSERT INTO action_profiles
      (profile_id, guild_id, channel_id, name, trigger_event, targets_json, actions_json, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      profileId,
      req.params.guildId,
      channelId || null,
      name,
      trigger_event,
      JSON.stringify({}),
      JSON.stringify(actions),
      enabled ? 1 : 0
    ]
  );

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'action_profile.create',
    diff: { profile_id: profileId, name, trigger_event, channel_id: channelId || null }
  });

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  setFlash(req, 'success', 'Action profile created.');
  res.redirect(`/guilds/${req.params.guildId}/actions${redirectQuery}`);
});

app.get('/guilds/:guildId/actions/:profileId', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, async (req, res) => {
  const rows = await query(
    'SELECT * FROM action_profiles WHERE guild_id = ? AND profile_id = ?',
    [req.params.guildId, req.params.profileId]
  );
  if (rows.length === 0) {
    return res.status(404).render('pages/error', { title: 'Not found', message: 'Profile not found.' });
  }
  const profile = rows[0];
  req.session.currentChannelId = profile.channel_id || '';
  res.locals.allowAllChannels = false;
  await applyChannelContext(req, res, req.params.guildId, { allowAll: false });
  let actionsText = '[]';
  if (profile.actions_json) {
    try {
      const parsed = typeof profile.actions_json === 'string'
        ? JSON.parse(profile.actions_json)
        : profile.actions_json;
      actionsText = JSON.stringify(parsed, null, 2);
    } catch (err) {
      actionsText = typeof profile.actions_json === 'string'
        ? profile.actions_json
        : JSON.stringify(profile.actions_json, null, 2);
    }
  }
  res.render('pages/action-edit', {
    title: 'Edit Action Profile',
    profile,
    actionsText,
    eventTypes
  });
});

app.post('/guilds/:guildId/actions/:profileId', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  const { name, trigger_event, actions_json, enabled, channel_id } = req.body;
  const channelId = channel_id === '__all' ? null : channel_id;
  const redirectQuery = channelId ? `?channel_id=${channelId}` : '';
  if (!name || !trigger_event) {
    setFlash(req, 'error', 'Name and event type are required.');
    return res.redirect(`/guilds/${req.params.guildId}/actions/${req.params.profileId}${redirectQuery}`);
  }
  if (!allowedEventTypeKeys.has(trigger_event)) {
    setFlash(req, 'error', 'Unsupported event type.');
    return res.redirect(`/guilds/${req.params.guildId}/actions/${req.params.profileId}${redirectQuery}`);
  }

  let actions;
  try {
    actions = actions_json ? JSON.parse(actions_json) : [];
  } catch (err) {
    setFlash(req, 'error', 'Actions JSON is invalid.');
    return res.redirect(`/guilds/${req.params.guildId}/actions/${req.params.profileId}${redirectQuery}`);
  }

  if (!Array.isArray(actions)) {
    setFlash(req, 'error', 'Actions must be a JSON array.');
    return res.redirect(`/guilds/${req.params.guildId}/actions/${req.params.profileId}${redirectQuery}`);
  }

  await query(
    `UPDATE action_profiles
     SET channel_id = ?, name = ?, trigger_event = ?, actions_json = ?, enabled = ?, updated_at = NOW()
     WHERE guild_id = ? AND profile_id = ?`,
    [channelId || null, name, trigger_event, JSON.stringify(actions), enabled ? 1 : 0, req.params.guildId, req.params.profileId]
  );

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'action_profile.update',
    diff: { profile_id: req.params.profileId, name, trigger_event, enabled: enabled ? 1 : 0, channel_id: channelId || null }
  });

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  setFlash(req, 'success', 'Action profile updated.');
  res.redirect(`/guilds/${req.params.guildId}/actions${redirectQuery}`);
});

app.post('/guilds/:guildId/actions/:profileId/delete', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  const { channel_id } = req.body;
  const channelId = channel_id === '__all' ? null : channel_id;
  await query('DELETE FROM action_profiles WHERE guild_id = ? AND profile_id = ?', [
    req.params.guildId,
    req.params.profileId
  ]);

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'action_profile.delete',
    diff: { profile_id: req.params.profileId, channel_id: channelId || null }
  });

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  setFlash(req, 'success', 'Action profile deleted.');
  const redirectQuery = channelId ? `?channel_id=${channelId}` : '';
  res.redirect(`/guilds/${req.params.guildId}/actions${redirectQuery}`);
});

// Dashboard: Routing
app.get('/guilds/:guildId/routing', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, async (req, res) => {
  const { selectedChannelId } = await applyChannelContext(req, res, req.params.guildId);
  const servers = await query(
    'SELECT server_id, server_name, enabled FROM guild_servers WHERE guild_id = ?',
    [req.params.guildId]
  );
  const rules = selectedChannelId === '__all'
    ? {}
    : await getRoutingRules(req.params.guildId, selectedChannelId || null);
  let channelRules = [];
  if (selectedChannelId === '__all') {
    const rows = await query(
      'SELECT channel_id, rules_json FROM routing_rules_channels WHERE guild_id = ?',
      [req.params.guildId]
    );
    const channelNameMap = res.locals.channelOptions.reduce((acc, channel) => {
      acc[channel.id] = channel.name;
      return acc;
    }, {});
    channelRules = rows.map((row) => ({
      channel_id: row.channel_id,
      channel_name: channelNameMap[row.channel_id] || row.channel_id,
      rules_text: policyToText(row.rules_json)
    }));
  }
  res.render('pages/routing', {
    title: 'Routing Rules',
    servers,
    rules,
    eventTypes,
    isAllChannels: selectedChannelId === '__all',
    channelRules
  });
});

app.post('/guilds/:guildId/routing', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  const channelId = req.body.channel_id === '__all' ? null : req.body.channel_id || null;
  const servers = await query(
    'SELECT server_id FROM guild_servers WHERE guild_id = ?',
    [req.params.guildId]
  );
  const serverIds = servers.map((row) => row.server_id);

  const rules = {};
  for (const eventType of eventTypes) {
    const mode = req.body[`mode_${eventType.slug}`] || 'all';
    const selected = normalizeArray(req.body[`servers_${eventType.slug}`]);
    const filtered = selected.filter((id) => serverIds.includes(id));
    rules[eventType.key] = {
      mode,
      server_ids: filtered
    };
  }

  await saveRoutingRules(req.params.guildId, channelId, rules);

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'routing.update',
    diff: { channel_id: channelId, rules }
  });

  await ensureUserGuildLink(req.params.guildId, req.session.user.id);

  setFlash(req, 'success', 'Routing rules saved.');
  const redirectQuery = channelId ? `?channel_id=${channelId}` : '';
  res.redirect(`/guilds/${req.params.guildId}/routing${redirectQuery}`);
});

// Dashboard: Members
app.get('/guilds/:guildId/members', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, async (req, res) => {
  await applyChannelContext(req, res, req.params.guildId);
  const memberLimit = 20;
  const membersAfter = typeof req.query.members_after === 'string' ? req.query.members_after : '';
  const searchQuery = typeof req.query.search === 'string' ? req.query.search.trim() : '';
  let rawMembers = [];
  if (res.locals.botPresent) {
    if (searchQuery) {
      if (/^\d{17,20}$/.test(searchQuery)) {
        const member = await fetchGuildMember(req.params.guildId, searchQuery);
        rawMembers = member ? [member] : [];
      } else {
        rawMembers = await searchGuildMembers(req.params.guildId, searchQuery, memberLimit);
      }
    } else {
      rawMembers = await fetchGuildMembers(req.params.guildId, memberLimit, membersAfter || null);
    }
  }
  const members = (rawMembers || [])
    .filter((member) => !member?.user?.bot)
    .map((member) => {
    const user = member.user || {};
    const displayName = user.global_name || user.username || 'Unknown';
    const avatar = user.avatar
      ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
      : 'https://cdn.discordapp.com/embed/avatars/0.png';
    return {
      id: user.id,
      username: user.username || '',
      display_name: displayName,
      tag: user.discriminator && user.discriminator !== '0'
        ? `${user.username}#${user.discriminator}`
        : user.username || displayName,
      avatar
    };
  });
  const lastRawMemberId = rawMembers.length ? rawMembers[rawMembers.length - 1]?.user?.id : '';
  const nextMembersAfter = !searchQuery && rawMembers.length === memberLimit ? lastRawMemberId : '';

  const permissionRows = await query(
    'SELECT discord_user_id, permission FROM guild_permissions WHERE guild_id = ?',
    [req.params.guildId]
  );
  const permissionMap = permissionRows.reduce((acc, row) => {
    acc[row.discord_user_id] = row.permission;
    return acc;
  }, {});
  const permissionProfiles = res.locals.botPresent
    ? await Promise.all(
      permissionRows.map(async (row) => {
        const member = await fetchGuildMember(req.params.guildId, row.discord_user_id);
        const user = member?.user || {};
        return {
          discord_user_id: row.discord_user_id,
          display_name: user.global_name || user.username || '',
          username: user.username || '',
          tag: user.discriminator && user.discriminator !== '0'
            ? `${user.username}#${user.discriminator}`
            : user.username || '',
          avatar: user.avatar
            ? `https://cdn.discordapp.com/avatars/${user.id}/${user.avatar}.png?size=64`
            : ''
        };
      })
    )
    : [];
  const permissionProfileMap = permissionProfiles.reduce((acc, profile) => {
    acc[profile.discord_user_id] = profile;
    return acc;
  }, {});

  const verifiedPage = Math.max(1, Number.parseInt(req.query.verified_page, 10) || 1);
  const verifiedPerPage = 25;
  const verifiedOffset = (verifiedPage - 1) * verifiedPerPage;
  const verifiedTotalRows = await query(
    "SELECT COUNT(*) AS count FROM guild_verifications WHERE guild_id = ? AND status = 'verified'",
    [req.params.guildId]
  );
  const verifiedTotal = verifiedTotalRows[0]?.count || 0;
  const verifiedRows = await query(
    `SELECT gv.discord_user_id, gv.mc_uuid, gv.verified_at, al.mc_ign
     FROM guild_verifications gv
     LEFT JOIN account_links al ON al.mc_uuid = gv.mc_uuid
     WHERE gv.guild_id = ? AND gv.status = 'verified'
     ORDER BY gv.verified_at DESC
     LIMIT ? OFFSET ?`,
    [req.params.guildId, verifiedPerPage, verifiedOffset]
  );
  const verifiedLinks = (verifiedRows || []).map((row) => ({
    ...row,
    verified_at_display: formatKstTimestamp(row.verified_at)
  }));

  res.render('pages/members', {
    title: 'Members',
    members,
    membersAfter,
    nextMembersAfter,
    searchQuery,
    permissionMap,
    permissionRows,
    permissionProfileMap,
    verifiedLinks,
    verifiedPage,
    verifiedPerPage,
    verifiedTotal
  });
});

app.post('/guilds/:guildId/members/permissions', ensureLoggedIn, ensureGuildAccess, ensureGuildOwner, requireCsrf, async (req, res) => {
  const memberId = String(req.body.member_id || '').trim();
  const action = String(req.body.action || '').trim();
  const redirectParams = new URLSearchParams();
  if (req.body.channel_id) {
    redirectParams.set('channel_id', req.body.channel_id);
  }
  if (req.body.members_after) {
    redirectParams.set('members_after', req.body.members_after);
  }
  if (req.body.search) {
    redirectParams.set('search', req.body.search);
  }
  if (req.body.verified_page) {
    redirectParams.set('verified_page', req.body.verified_page);
  }
  const redirectSuffix = redirectParams.toString() ? `?${redirectParams.toString()}` : '';
  if (!memberId) {
    setFlash(req, 'error', '멤버 ID가 필요합니다.');
    return res.redirect(`/guilds/${req.params.guildId}/members${redirectSuffix}`);
  }

  if (action === 'revoke') {
    await query(
      'DELETE FROM guild_permissions WHERE guild_id = ? AND discord_user_id = ?',
      [req.params.guildId, memberId]
    );
    await logAudit({
      guildId: req.params.guildId,
      actorId: req.session.user.id,
      action: 'guild.permissions.revoke',
      diff: { discord_user_id: memberId, permission: MANAGE_SETTINGS_PERMISSION }
    });
    setFlash(req, 'success', '권한이 해제되었습니다.');
    return res.redirect(`/guilds/${req.params.guildId}/members${redirectSuffix}`);
  }

  if (action !== 'grant') {
    setFlash(req, 'error', '잘못된 요청입니다.');
    return res.redirect(`/guilds/${req.params.guildId}/members${redirectSuffix}`);
  }

  await query(
    `INSERT INTO guild_permissions (guild_id, discord_user_id, permission, created_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE permission = VALUES(permission), updated_at = NOW()`,
    [req.params.guildId, memberId, MANAGE_SETTINGS_PERMISSION]
  );

  await logAudit({
    guildId: req.params.guildId,
    actorId: req.session.user.id,
    action: 'guild.permissions.grant',
    diff: { discord_user_id: memberId, permission: MANAGE_SETTINGS_PERMISSION }
  });

  setFlash(req, 'success', '권한이 부여되었습니다.');
  res.redirect(`/guilds/${req.params.guildId}/members${redirectSuffix}`);
});

app.post('/guilds/:guildId/members/revoke', ensureLoggedIn, ensureGuildAccess, ensureGuildManageSettings, requireCsrf, async (req, res) => {
  const memberId = String(req.body.discord_user_id || '').trim();
  const redirectParams = new URLSearchParams();
  if (req.body.channel_id) {
    redirectParams.set('channel_id', req.body.channel_id);
  }
  if (req.body.members_after) {
    redirectParams.set('members_after', req.body.members_after);
  }
  if (req.body.search) {
    redirectParams.set('search', req.body.search);
  }
  if (req.body.verified_page) {
    redirectParams.set('verified_page', req.body.verified_page);
  }
  const redirectSuffix = redirectParams.toString() ? `?${redirectParams.toString()}` : '';
  if (!memberId) {
    setFlash(req, 'error', '멤버 ID가 필요합니다.');
    return res.redirect(`/guilds/${req.params.guildId}/members${redirectSuffix}`);
  }

  try {
    await revokeLink({
      guildId: req.params.guildId,
      discordUserId: memberId,
      reason: 'admin_revoked'
    });
    await logAudit({
      guildId: req.params.guildId,
      actorId: req.session.user.id,
      action: 'guild.verification.revoke',
      diff: { discord_user_id: memberId }
    });
    await ensureUserGuildLink(req.params.guildId, req.session.user.id);
    setFlash(req, 'success', '인증이 해제되었습니다.');
  } catch (err) {
    setFlash(req, 'error', '인증 해제에 실패했습니다.');
  }

  res.redirect(`/guilds/${req.params.guildId}/members${redirectSuffix}`);
});

// Dashboard: Logs
app.get('/guilds/:guildId/logs', ensureLoggedIn, ensureGuildAccess, async (req, res) => {
  const { selectedChannelId } = await applyChannelContext(req, res, req.params.guildId);
  const normalizePage = (value) => {
    const parsed = Number.parseInt(value, 10);
    return Number.isNaN(parsed) || parsed < 1 ? 1 : parsed;
  };
  const normalizeDate = (value) => {
    if (typeof value !== 'string') {
      return '';
    }
    const trimmed = value.trim();
    return /^\d{4}-\d{2}-\d{2}$/.test(trimmed) ? trimmed : '';
  };
  const rawEventType = typeof req.query.event_type === 'string' ? req.query.event_type.trim() : '';
  const eventTypeFilter = rawEventType && rawEventType !== 'all' ? rawEventType.slice(0, 120) : 'all';
  let dateFrom = normalizeDate(req.query.from);
  let dateTo = normalizeDate(req.query.to);
  if (dateFrom && dateTo && dateFrom > dateTo) {
    [dateFrom, dateTo] = [dateTo, dateFrom];
  }
  const logTabRaw = typeof req.query.log_tab === 'string' ? req.query.log_tab.trim() : '';
  const allowedLogTabs = new Set(['all', 'events', 'deliveries', 'audits', 'entitlements']);
  const logTab = allowedLogTabs.has(logTabRaw) ? logTabRaw : 'all';
  const deliveryStatusRaw = typeof req.query.delivery_status === 'string' ? req.query.delivery_status.trim() : '';
  const deliveryStatusFilter = deliveryStatusRaw && deliveryStatusRaw !== 'all' ? deliveryStatusRaw.slice(0, 40) : 'all';

  const showEvents = logTab === 'all' || logTab === 'events';
  const showDeliveries = logTab === 'all' || logTab === 'deliveries';
  const showAudits = logTab === 'all' || logTab === 'audits';
  const showEntitlements = logTab === 'all' || logTab === 'entitlements';

  const eventsPerPage = 50;
  let eventsPage = normalizePage(req.query.events_page);
  const deliveriesPerPage = 50;
  let deliveriesPage = normalizePage(req.query.deliveries_page);
  const auditsPerPage = 50;
  let auditsPage = normalizePage(req.query.audits_page);
  const entitlementsPerPage = 50;
  let entitlementsPage = normalizePage(req.query.entitlements_page);

  let events = [];
  let eventsTotal = 0;
  let eventsTotalPages = 1;
  if (showEvents) {
    const eventWhere = ['guild_id = ?'];
    const eventParams = [req.params.guildId];
    if (selectedChannelId !== '__all') {
      eventWhere.push('channel_id <=> ?');
      eventParams.push(selectedChannelId || null);
    }
    if (eventTypeFilter !== 'all') {
      eventWhere.push('event_type = ?');
      eventParams.push(eventTypeFilter);
    }
    if (dateFrom) {
      eventWhere.push('occurred_at >= ?');
      eventParams.push(`${dateFrom} 00:00:00`);
    }
    if (dateTo) {
      eventWhere.push('occurred_at <= ?');
      eventParams.push(`${dateTo} 23:59:59`);
    }
    const eventWhereSql = `WHERE ${eventWhere.join(' AND ')}`;
    const eventsCountRows = await query(
      `SELECT COUNT(*) AS count FROM events ${eventWhereSql}`,
      eventParams
    );
    eventsTotal = eventsCountRows[0]?.count || 0;
    eventsTotalPages = Math.max(1, Math.ceil(eventsTotal / eventsPerPage));
    if (eventsPage > eventsTotalPages) {
      eventsPage = eventsTotalPages;
    }
    const eventsOffset = (eventsPage - 1) * eventsPerPage;
    const eventsRaw = selectedChannelId === '__all'
      ? await query(
        `SELECT event_id, event_type, discord_user_id, mc_ign, occurred_at, channel_id
         FROM events
         ${eventWhereSql}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...eventParams, eventsPerPage, eventsOffset]
      )
      : await query(
        `SELECT event_id, event_type, discord_user_id, mc_ign, occurred_at
         FROM events
         ${eventWhereSql}
         ORDER BY created_at DESC
         LIMIT ? OFFSET ?`,
        [...eventParams, eventsPerPage, eventsOffset]
      );
    events = (eventsRaw || []).map((event) => ({
      ...event,
      occurred_at_display: formatKstTimestamp(event.occurred_at)
    }));
  }

  let deliveries = [];
  let deliveriesTotal = 0;
  let deliveriesTotalPages = 1;
  if (showDeliveries) {
    const deliveryWhere = ['d.guild_id = ?'];
    const deliveryParams = [req.params.guildId];
    if (selectedChannelId !== '__all') {
      deliveryWhere.push('e.channel_id <=> ?');
      deliveryParams.push(selectedChannelId || null);
    }
    if (deliveryStatusFilter !== 'all') {
      deliveryWhere.push('d.status = ?');
      deliveryParams.push(deliveryStatusFilter);
    }
    const deliveryWhereSql = `WHERE ${deliveryWhere.join(' AND ')}`;
    const deliveriesCountRows = selectedChannelId === '__all'
      ? await query(
        `SELECT COUNT(*) AS count
         FROM push_deliveries d
         ${deliveryStatusFilter !== 'all' ? 'WHERE d.guild_id = ? AND d.status = ?' : 'WHERE d.guild_id = ?'}`,
        deliveryStatusFilter !== 'all' ? [req.params.guildId, deliveryStatusFilter] : [req.params.guildId]
      )
      : await query(
        `SELECT COUNT(*) AS count
         FROM push_deliveries d
         LEFT JOIN events e ON e.event_id = d.event_id
         ${deliveryWhereSql}`,
        deliveryParams
      );
    deliveriesTotal = deliveriesCountRows[0]?.count || 0;
    deliveriesTotalPages = Math.max(1, Math.ceil(deliveriesTotal / deliveriesPerPage));
    if (deliveriesPage > deliveriesTotalPages) {
      deliveriesPage = deliveriesTotalPages;
    }
    const deliveriesOffset = (deliveriesPage - 1) * deliveriesPerPage;
    const deliveriesRaw = selectedChannelId === '__all'
      ? await query(
        `SELECT delivery_id, event_id, server_id, status, attempt_count, last_http_status, updated_at
         FROM push_deliveries
         WHERE guild_id = ?
         ${deliveryStatusFilter !== 'all' ? 'AND status = ?' : ''}
         ORDER BY updated_at DESC
         LIMIT ? OFFSET ?`,
        deliveryStatusFilter !== 'all'
          ? [req.params.guildId, deliveryStatusFilter, deliveriesPerPage, deliveriesOffset]
          : [req.params.guildId, deliveriesPerPage, deliveriesOffset]
      )
      : await query(
        `SELECT d.delivery_id, d.event_id, d.server_id, d.status, d.attempt_count, d.last_http_status, d.updated_at
         FROM push_deliveries d
         LEFT JOIN events e ON e.event_id = d.event_id
         ${deliveryWhereSql}
         ORDER BY d.updated_at DESC
         LIMIT ? OFFSET ?`,
        [...deliveryParams, deliveriesPerPage, deliveriesOffset]
      );
    deliveries = (deliveriesRaw || []).map((delivery) => ({
      ...delivery,
      updated_at_display: formatKstTimestamp(delivery.updated_at)
    }));
  }

  let audits = [];
  let auditsTotal = 0;
  let auditsTotalPages = 1;
  if (showAudits) {
    const auditsCountRows = await query(
      'SELECT COUNT(*) AS count FROM audit_logs WHERE guild_id = ?',
      [req.params.guildId]
    );
    auditsTotal = auditsCountRows[0]?.count || 0;
    auditsTotalPages = Math.max(1, Math.ceil(auditsTotal / auditsPerPage));
    if (auditsPage > auditsTotalPages) {
      auditsPage = auditsTotalPages;
    }
    const auditsOffset = (auditsPage - 1) * auditsPerPage;
    const auditsRaw = await query(
      'SELECT actor_discord_id, action, created_at FROM audit_logs WHERE guild_id = ? ORDER BY created_at DESC LIMIT ? OFFSET ?',
      [req.params.guildId, auditsPerPage, auditsOffset]
    );
    audits = (auditsRaw || []).map((audit) => ({
      ...audit,
      created_at_display: formatKstTimestamp(audit.created_at)
    }));
  }

  let entitlements = [];
  let entitlementsTotal = 0;
  let entitlementsTotalPages = 1;
  if (showEntitlements) {
    const entitlementsCountRows = selectedChannelId === '__all'
      ? await query(
        'SELECT COUNT(*) AS count FROM minecraft_entitlements_log WHERE guild_id = ?',
        [req.params.guildId]
      )
      : await query(
        `SELECT COUNT(*) AS count
         FROM minecraft_entitlements_log l
         JOIN events e ON e.event_id = l.event_id
         WHERE l.guild_id = ? AND e.channel_id <=> ?`,
        [req.params.guildId, selectedChannelId || null]
      );
    entitlementsTotal = entitlementsCountRows[0]?.count || 0;
    entitlementsTotalPages = Math.max(1, Math.ceil(entitlementsTotal / entitlementsPerPage));
    if (entitlementsPage > entitlementsTotalPages) {
      entitlementsPage = entitlementsTotalPages;
    }
    const entitlementsOffset = (entitlementsPage - 1) * entitlementsPerPage;
    const entitlementsRaw = selectedChannelId === '__all'
      ? await query(
        `SELECT l.event_id, l.discord_user_id, l.mc_uuid, l.created_at
         FROM minecraft_entitlements_log l
         WHERE l.guild_id = ?
         ORDER BY l.created_at DESC
         LIMIT ? OFFSET ?`,
        [req.params.guildId, entitlementsPerPage, entitlementsOffset]
      )
      : await query(
        `SELECT l.event_id, l.discord_user_id, l.mc_uuid, l.created_at
         FROM minecraft_entitlements_log l
         JOIN events e ON e.event_id = l.event_id
         WHERE l.guild_id = ? AND e.channel_id <=> ?
         ORDER BY l.created_at DESC
         LIMIT ? OFFSET ?`,
        [req.params.guildId, selectedChannelId || null, entitlementsPerPage, entitlementsOffset]
      );
    entitlements = (entitlementsRaw || []).map((row) => ({
      ...row,
      created_at_display: formatKstTimestamp(row.created_at)
    }));
  }
  const baseParams = new URLSearchParams(req.query);
  const buildQuery = (updates) => {
    const params = new URLSearchParams(baseParams);
    Object.entries(updates).forEach(([key, value]) => {
      if (value === '' || value === null || typeof value === 'undefined') {
        params.delete(key);
      } else {
        params.set(key, String(value));
      }
    });
    return params.toString();
  };
  const eventsPagination = {
    page: eventsPage,
    perPage: eventsPerPage,
    total: eventsTotal,
    totalPages: eventsTotalPages,
    prevQuery: eventsPage > 1 ? buildQuery({ events_page: eventsPage - 1 }) : '',
    nextQuery: eventsPage < eventsTotalPages ? buildQuery({ events_page: eventsPage + 1 }) : ''
  };
  const deliveriesPagination = {
    page: deliveriesPage,
    perPage: deliveriesPerPage,
    total: deliveriesTotal,
    totalPages: deliveriesTotalPages,
    prevQuery: deliveriesPage > 1 ? buildQuery({ deliveries_page: deliveriesPage - 1 }) : '',
    nextQuery: deliveriesPage < deliveriesTotalPages ? buildQuery({ deliveries_page: deliveriesPage + 1 }) : ''
  };
  const auditsPagination = {
    page: auditsPage,
    perPage: auditsPerPage,
    total: auditsTotal,
    totalPages: auditsTotalPages,
    prevQuery: auditsPage > 1 ? buildQuery({ audits_page: auditsPage - 1 }) : '',
    nextQuery: auditsPage < auditsTotalPages ? buildQuery({ audits_page: auditsPage + 1 }) : ''
  };
  const entitlementsPagination = {
    page: entitlementsPage,
    perPage: entitlementsPerPage,
    total: entitlementsTotal,
    totalPages: entitlementsTotalPages,
    prevQuery: entitlementsPage > 1 ? buildQuery({ entitlements_page: entitlementsPage - 1 }) : '',
    nextQuery: entitlementsPage < entitlementsTotalPages ? buildQuery({ entitlements_page: entitlementsPage + 1 }) : ''
  };
  const eventsClearQuery = buildQuery({ event_type: '', from: '', to: '', events_page: 1 });
  const deliveryClearQuery = buildQuery({ delivery_status: '', deliveries_page: 1 });
  const logTabQueries = {
    all: buildQuery({ log_tab: '', events_page: 1, deliveries_page: 1, audits_page: 1, entitlements_page: 1 }),
    events: buildQuery({ log_tab: 'events', events_page: 1 }),
    deliveries: buildQuery({ log_tab: 'deliveries', deliveries_page: 1 }),
    audits: buildQuery({ log_tab: 'audits', audits_page: 1 }),
    entitlements: buildQuery({ log_tab: 'entitlements', entitlements_page: 1 })
  };
  res.render('pages/logs', {
    title: 'Logs',
    events,
    deliveries,
    audits,
    entitlements,
    eventTypes,
    eventTypeFilter,
    dateFrom,
    dateTo,
    logTab,
    logTabQueries,
    deliveryStatusFilter,
    eventsPagination,
    deliveriesPagination,
    auditsPagination,
    entitlementsPagination,
    eventsClearQuery,
    deliveryClearQuery
  });
});

app.post('/guilds/:guildId/unlink', ensureLoggedIn, requireCsrf, async (req, res) => {
  try {
    await revokeLink({
      guildId: req.params.guildId,
      discordUserId: req.session.user.id,
      reason: 'user_unlink'
    });
    await query('DELETE FROM user_guild_links WHERE guild_id = ? AND user_id = ?', [
      req.params.guildId,
      req.session.user.id
    ]);
    setFlash(req, 'success', '연동이 해제되었습니다.');
  } catch (err) {
    setFlash(req, 'error', '연동 해제에 실패했습니다.');
  }
  res.redirect('/guilds');
});

app.get('/consent', (req, res) => {
  const flow = typeof req.query.flow === 'string' ? req.query.flow : '';
  const redirectPath = typeof req.query.redirect === 'string' ? req.query.redirect : '';
  const consent = consentCopy[flow];
  if (!consent || !isValidConsentRedirect(flow, redirectPath)) {
    return res.status(400).render('pages/error', {
      title: 'Invalid request',
      message: '잘못된 동의 요청입니다.'
    });
  }
  res.render('pages/consent', {
    title: '개인정보 동의',
    flow,
    redirectPath,
    consentTitle: consent.title,
    consentDescription: consent.description,
    consentButtonLabel: consent.buttonLabel
  });
});

app.post('/consent', requireCsrf, (req, res) => {
  const flow = typeof req.body.flow === 'string' ? req.body.flow : '';
  const redirectPath = typeof req.body.redirect === 'string' ? req.body.redirect : '';
  const agree = req.body.agree;
  if (!consentCopy[flow] || !isValidConsentRedirect(flow, redirectPath)) {
    return res.status(400).render('pages/error', {
      title: 'Invalid request',
      message: '잘못된 동의 요청입니다.'
    });
  }
  if (!agree) {
    return res.status(400).render('pages/error', {
      title: 'Consent required',
      message: '개인정보 처리방침에 동의해야 진행할 수 있습니다.'
    });
  }
  const consent = getConsentState(req);
  consent[flow] = Date.now();
  if (flow === 'discord' && req.session.user?.id) {
    recordConsentInDb(req.session.user.id, 'discord')
      .then(() => res.redirect(redirectPath))
      .catch(() => res.redirect(redirectPath));
    return;
  }
  res.redirect(redirectPath);
});

app.post(PLUGIN_SYNC_PATH, async (req, res) => {
  const { timestamp, nonce, signature, payload } = req.body || {};
  if (!timestamp || !nonce || !signature || !payload) {
    return res.status(400).json({ error: 'missing_fields' });
  }
  if (typeof payload !== 'object' || Array.isArray(payload)) {
    return res.status(400).json({ error: 'invalid_payload' });
  }
  const serverId = payload.server_id;
  if (!serverId) {
    return res.status(400).json({ error: 'missing_server_id' });
  }

  const rows = await query(
    'SELECT guild_id, server_secret, enabled FROM guild_servers WHERE server_id = ?',
    [serverId]
  );
  if (rows.length === 0) {
    return res.status(404).json({ error: 'server_not_found' });
  }
  const serverRow = rows[0];
  if (!serverRow.enabled) {
    return res.status(403).json({ error: 'server_disabled' });
  }
  const serverSecret = serverRow.server_secret || '';

  const now = Math.floor(Date.now() / 1000);
  const ts = Number.parseInt(timestamp, 10);
  if (Number.isNaN(ts) || Math.abs(now - ts) > PLUGIN_SYNC_SKEW_SECONDS) {
    return res.status(400).json({ error: 'stale' });
  }

  const signatureBody = buildSignatureBody(String(timestamp), String(nonce), payload);
  const expected = hmacSha256Hex(serverSecret, signatureBody);
  if (!safeEquals(expected, String(signature))) {
    return res.status(403).json({ error: 'bad_signature' });
  }

  const lastSeen = pluginSyncLastSeen.get(serverId) || 0;
  if (lastSeen && now - lastSeen < PLUGIN_SYNC_COOLDOWN_SECONDS) {
    return res.status(429).json({
      error: 'rate_limited',
      retry_after: PLUGIN_SYNC_COOLDOWN_SECONDS - (now - lastSeen)
    });
  }

  pluginSyncLastSeen.set(serverId, now);

  const entriesRaw = await query(
    `SELECT gv.mc_uuid, gv.discord_user_id, gv.verified_at, al.mc_ign
     FROM guild_verifications gv
     LEFT JOIN account_links al ON gv.mc_uuid = al.mc_uuid
     WHERE gv.guild_id = ? AND gv.status = 'verified'
     ORDER BY gv.verified_at DESC`,
    [serverRow.guild_id]
  );

  const entries = (entriesRaw || []).map((row) => ({
    mc_uuid: row.mc_uuid,
    mc_ign: row.mc_ign || null,
    discord_user_id: row.discord_user_id,
    guild_id: serverRow.guild_id,
    verified_at: row.verified_at ? new Date(row.verified_at).toISOString() : null
  }));

  res.json({
    server_id: serverId,
    guild_id: serverRow.guild_id,
    generated_at: new Date().toISOString(),
    entries
  });
});

// Internal API for bot
app.post('/api/v1/verify/sessions', requireInternalKey, async (req, res) => {
  let replyPayload = null;
  try {
    const { guild_id, discord_user_id, channel_id } = req.body || {};
    if (!guild_id || !discord_user_id) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    try {
      const settings = await loadSettings(guild_id, channel_id || null);
      if (settings?.verify_reply_payload) {
        replyPayload = typeof settings.verify_reply_payload === 'string'
          ? JSON.parse(settings.verify_reply_payload)
          : settings.verify_reply_payload;
      }
    } catch (err) {
      replyPayload = null;
    }
    const sessionId = await createSession({
      guildId: guild_id,
      discordUserId: discord_user_id,
      channelId: channel_id || null,
      ttlMinutes: config.verifySessionTtlMinutes
    });
    const verifyUrl = `${config.publicBaseUrl}/verify/${sessionId}`;
    res.json({
      session_id: sessionId,
      verify_url: verifyUrl,
      expires_in_minutes: config.verifySessionTtlMinutes,
      reply_payload: replyPayload
    });
  } catch (err) {
    res.status(500).json({ error: 'session_create_failed', reply_payload: replyPayload });
  }
});

app.post('/api/v1/verify/complete', requireInternalKey, async (req, res) => {
  try {
    const { session_id, mc_uuid, mc_ign } = req.body || {};
    if (!session_id || !mc_uuid || !mc_ign) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const result = await completeSession({
      sessionId: session_id,
      mcUuid: mc_uuid,
      mcIgn: mc_ign
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/v1/verify/revoke', requireInternalKey, async (req, res) => {
  try {
    const { guild_id, discord_user_id, reason } = req.body || {};
    if (!guild_id || !discord_user_id) {
      return res.status(400).json({ error: 'missing_fields' });
    }
    const result = await revokeLink({
      guildId: guild_id,
      discordUserId: discord_user_id,
      reason
    });
    res.json(result);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Admin API (optional)
app.put('/api/v1/guilds/:guildId/settings', requireAdminKey, async (req, res) => {
  const {
    verified_role_id,
    log_channel_id,
    nickname_format,
    bot_message_template,
    bot_message_payload,
    verify_reply_payload,
    policy_json
  } = req.body || {};
  const guildId = req.params.guildId;

  const botMessagePayloadValue = bot_message_payload ? JSON.stringify(bot_message_payload) : null;
  const verifyReplyPayloadValue = verify_reply_payload ? JSON.stringify(verify_reply_payload) : null;

  await query(
    `INSERT INTO guilds (guild_id, verified_role_id, log_channel_id, nickname_format, bot_message_template, bot_message_payload, verify_reply_payload, policy_json, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       verified_role_id = VALUES(verified_role_id),
       log_channel_id = VALUES(log_channel_id),
       nickname_format = VALUES(nickname_format),
       bot_message_template = VALUES(bot_message_template),
       bot_message_payload = VALUES(bot_message_payload),
       verify_reply_payload = VALUES(verify_reply_payload),
       policy_json = VALUES(policy_json),
       updated_at = NOW()`,
    [
      guildId,
      verified_role_id || null,
      log_channel_id || null,
      nickname_format || null,
      bot_message_template || null,
      botMessagePayloadValue,
      verifyReplyPayloadValue,
      policy_json || null
    ]
  );

  res.json({ status: 'ok' });
});

app.post('/api/v1/guilds/:guildId/servers', requireAdminKey, async (req, res) => {
  const { server_name, server_host, server_port } = req.body || {};
  const portValue = Number.parseInt(server_port, 10);
  if (!server_name || !server_host || Number.isNaN(portValue)) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const serverId = ulid();
  const serverSecret = randomId().replace(/-/g, '');
  const endpointUrl = buildEndpointUrl(server_host, portValue);

  await query(
    `INSERT INTO guild_servers
      (guild_id, server_id, server_name, server_host, server_port, endpoint_url, server_secret, enabled, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, NOW(), NOW())`,
    [req.params.guildId, serverId, server_name, server_host, portValue, endpointUrl, serverSecret]
  );

  res.json({ server_id: serverId, server_secret: serverSecret });
});

app.get('/api/v1/guilds/:guildId/servers', requireAdminKey, async (req, res) => {
  const rows = await query(
    'SELECT server_id, server_name, server_host, server_port, enabled, last_seen_at FROM guild_servers WHERE guild_id = ?',
    [req.params.guildId]
  );
  res.json({ servers: rows });
});

app.post('/api/v1/guilds/:guildId/action-profiles', requireAdminKey, async (req, res) => {
  const { name, trigger_event, actions, targets } = req.body || {};
  if (!name || !trigger_event || !Array.isArray(actions)) {
    return res.status(400).json({ error: 'missing_fields' });
  }

  const profileId = ulid();
  await query(
    `INSERT INTO action_profiles
      (profile_id, guild_id, name, trigger_event, targets_json, actions_json, enabled, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, NOW())`,
    [profileId, req.params.guildId, name, trigger_event, JSON.stringify(targets || {}), JSON.stringify(actions)]
  );

  res.json({ profile_id: profileId });
});

app.get('/api/v1/guilds/:guildId/action-profiles', requireAdminKey, async (req, res) => {
  const rows = await query(
    'SELECT profile_id, name, trigger_event, enabled, updated_at FROM action_profiles WHERE guild_id = ?',
    [req.params.guildId]
  );
  res.json({ profiles: rows });
});

app.use((err, req, res, next) => {
  // eslint-disable-next-line no-console
  console.error('Unhandled web error:', err);
  if (res.headersSent) {
    return next(err);
  }
  if (req.path.startsWith('/api/')) {
    return res.status(500).json({ error: 'internal_error' });
  }
  return res.status(500).render('pages/error', {
    title: 'Server Error',
    message: '요청을 처리하는 중 오류가 발생했습니다.'
  });
});

app.listen(config.port, () => {
  // eslint-disable-next-line no-console
  console.log(`Web API listening on ${config.port}`);
});
