const { ulid } = require('ulid');
const { query } = require('../db');
const { toKstIso } = require('../utils');
const { pushEventToServers } = require('./pushService');
const { sendBotEvent } = require('./botService');

async function createSession({ guildId, discordUserId, channelId, ttlMinutes }) {
  const sessionId = ulid();
  await query(
    `INSERT INTO verify_sessions
      (session_id, guild_id, discord_user_id, channel_id, status, expires_at, created_at)
     VALUES (?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL ? MINUTE), NOW())`,
    [sessionId, guildId, discordUserId, channelId || null, ttlMinutes]
  );
  return sessionId;
}

async function getSession(sessionId) {
  const rows = await query(
    'SELECT * FROM verify_sessions WHERE session_id = ?',
    [sessionId]
  );
  return rows[0];
}

async function loadSettings(guildId, channelId) {
  let channelSettings = null;
  if (channelId) {
    const channelRows = await query(
      'SELECT verified_role_id, log_channel_id, nickname_format, bot_message_template, bot_message_payload, verify_reply_payload, policy_json FROM guild_channel_settings WHERE guild_id = ? AND channel_id = ?',
      [guildId, channelId]
    );
    if (channelRows.length > 0) {
      channelSettings = channelRows[0];
    }
  }

  const guildRows = await query(
    'SELECT verified_role_id, log_channel_id, nickname_format, bot_message_template, bot_message_payload, verify_reply_payload, policy_json FROM guilds WHERE guild_id = ?',
    [guildId]
  );
  const guildSettings = guildRows[0] || {};

  if (!channelSettings) {
    return guildSettings;
  }

  if (channelSettings.bot_message_template == null && guildSettings.bot_message_template != null) {
    channelSettings.bot_message_template = guildSettings.bot_message_template;
  }
  if (channelSettings.bot_message_payload == null && guildSettings.bot_message_payload != null) {
    channelSettings.bot_message_payload = guildSettings.bot_message_payload;
  }
  if (channelSettings.verify_reply_payload == null && guildSettings.verify_reply_payload != null) {
    channelSettings.verify_reply_payload = guildSettings.verify_reply_payload;
  }

  return channelSettings;
}

async function loadPolicy(guildId, channelId) {
  const settings = await loadSettings(guildId, channelId);
  if (!settings.policy_json) {
    return { link_policy: 'strict' };
  }
  if (typeof settings.policy_json === 'string') {
    try {
      return JSON.parse(settings.policy_json);
    } catch (err) {
      return { link_policy: 'strict' };
    }
  }
  return settings.policy_json;
}

async function enforceLinkPolicy({ guildId, discordUserId, mcUuid, channelId }) {
  const policy = await loadPolicy(guildId, channelId);
  const linkPolicy = policy?.link_policy || 'strict';

  const existingByDiscord = await query(
    'SELECT mc_uuid FROM account_links WHERE discord_user_id = ?',
    [discordUserId]
  );
  const existingByUuid = await query(
    'SELECT discord_user_id FROM account_links WHERE mc_uuid = ?',
    [mcUuid]
  );

  if (linkPolicy === 'deny') {
    if (existingByDiscord.length > 0 || existingByUuid.length > 0) {
      throw new Error('link_policy_denied');
    }
  }

  if (linkPolicy === 'strict') {
    if (existingByUuid.length > 0 && existingByUuid[0].discord_user_id !== discordUserId) {
      throw new Error('uuid_already_linked');
    }
    if (existingByDiscord.length > 0 && existingByDiscord[0].mc_uuid !== mcUuid) {
      throw new Error('discord_already_linked');
    }
  }

  if (linkPolicy === 'overwrite') {
    if (existingByUuid.length > 0 && existingByUuid[0].discord_user_id !== discordUserId) {
      await query('DELETE FROM account_links WHERE discord_user_id = ?', [existingByUuid[0].discord_user_id]);
    }
  }
}

async function completeSession({ sessionId, mcUuid, mcIgn, entitlements }) {
  const session = await getSession(sessionId);
  if (!session) {
    throw new Error('session_not_found');
  }
  if (session.status === 'completed') {
    return { event_id: null, already_completed: true };
  }
  if (new Date(session.expires_at).getTime() < Date.now()) {
    throw new Error('session_expired');
  }

  await enforceLinkPolicy({
    guildId: session.guild_id,
    discordUserId: session.discord_user_id,
    mcUuid,
    channelId: session.channel_id
  });

  const existingVerificationRows = await query(
    'SELECT status, mc_uuid FROM guild_verifications WHERE guild_id = ? AND discord_user_id = ? LIMIT 1',
    [session.guild_id, session.discord_user_id]
  );
  const isReverified = existingVerificationRows.length > 0;
  const eventType = isReverified ? 'verification.reverified' : 'verification.completed';

  await query(
    `UPDATE verify_sessions
     SET status = 'completed', completed_at = NOW()
     WHERE session_id = ?`,
    [sessionId]
  );

  await query(
    `INSERT INTO account_links (discord_user_id, mc_uuid, mc_ign, last_verified_at, updated_at)
     VALUES (?, ?, ?, NOW(), NOW())
     ON DUPLICATE KEY UPDATE
       discord_user_id = VALUES(discord_user_id),
       mc_uuid = VALUES(mc_uuid),
       mc_ign = VALUES(mc_ign),
       last_verified_at = NOW(),
       updated_at = NOW()`,
    [session.discord_user_id, mcUuid, mcIgn]
  );

  await query(
    `INSERT INTO guild_verifications (guild_id, discord_user_id, mc_uuid, status, verified_at)
     VALUES (?, ?, ?, 'verified', NOW())
     ON DUPLICATE KEY UPDATE status = 'verified', verified_at = NOW()`,
    [session.guild_id, session.discord_user_id, mcUuid]
  );

  const eventId = ulid();
  const occurredAt = toKstIso();

  await query(
    `INSERT INTO events
      (event_id, event_type, guild_id, channel_id, discord_user_id, mc_uuid, mc_ign, occurred_at, payload_json, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      eventId,
      eventType,
      session.guild_id,
      session.channel_id,
      session.discord_user_id,
      mcUuid,
      mcIgn,
      occurredAt,
      JSON.stringify({
        session_id: sessionId,
        entitlements_count: Array.isArray(entitlements) ? entitlements.length : null
      })
    ]
  );

  if (Array.isArray(entitlements)) {
    await query(
      `INSERT INTO minecraft_entitlements_log
        (event_id, guild_id, discord_user_id, mc_uuid, entitlements_json, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        eventId,
        session.guild_id,
        session.discord_user_id,
        mcUuid,
        JSON.stringify(entitlements)
      ]
    );
  }

  const eventPayload = {
    event_id: eventId,
    event_type: eventType,
    guild_id: session.guild_id,
    channel_id: session.channel_id,
    discord_user_id: session.discord_user_id,
    mc_uuid: mcUuid,
    mc_ign: mcIgn,
    occurred_at: occurredAt
  };

  await pushEventToServers(eventPayload);
  await sendBotEvent(await enrichBotEvent(eventPayload));

  return { event_id: eventId, already_completed: false };
}

async function enrichBotEvent(eventPayload) {
  const settings = await loadSettings(eventPayload.guild_id, eventPayload.channel_id);
  return {
    ...eventPayload,
    verified_role_id: settings.verified_role_id || null,
    log_channel_id: settings.log_channel_id || null,
    nickname_format: settings.nickname_format || null,
    bot_message_template: settings.bot_message_template || null,
    bot_message_payload: settings.bot_message_payload || null
  };
}

async function revokeLink({ guildId, discordUserId, reason }) {
  const rows = await query(
    'SELECT mc_uuid, mc_ign FROM account_links WHERE discord_user_id = ?',
    [discordUserId]
  );
  if (rows.length === 0) {
    throw new Error('link_not_found');
  }

  const link = rows[0];
  const eventId = ulid();
  const occurredAt = toKstIso();

  await query(
    `INSERT INTO events
      (event_id, event_type, guild_id, channel_id, discord_user_id, mc_uuid, mc_ign, occurred_at, payload_json, created_at)
     VALUES (?, 'verification.revoked', ?, ?, ?, ?, ?, ?, ?, NOW())`,
    [
      eventId,
      guildId,
      null,
      discordUserId,
      link.mc_uuid,
      link.mc_ign,
      occurredAt,
      JSON.stringify({ reason: reason || 'manual' })
    ]
  );

  await query(
    `UPDATE guild_verifications
     SET status = 'revoked'
     WHERE guild_id = ? AND discord_user_id = ?`,
    [guildId, discordUserId]
  );

  const eventPayload = {
    event_id: eventId,
    event_type: 'verification.revoked',
    guild_id: guildId,
    channel_id: null,
    discord_user_id: discordUserId,
    mc_uuid: link.mc_uuid,
    mc_ign: link.mc_ign,
    occurred_at: occurredAt
  };

  await pushEventToServers(eventPayload);
  await sendBotEvent(await enrichBotEvent(eventPayload));

  return { event_id: eventId };
}

module.exports = {
  createSession,
  completeSession,
  revokeLink,
  getSession,
  loadSettings
};
