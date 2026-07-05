const net = require('net');
const config = require('../config');
const { query } = require('../db');
const { getRoutingRules, filterServersByRule } = require('./routingService');
const { hmacSha256Hex, randomId } = require('../utils');

async function loadEnabledServers(guildId) {
  return query(
    'SELECT server_id, server_name, server_host, server_port, server_secret, enabled FROM guild_servers WHERE guild_id = ? AND enabled = 1',
    [guildId]
  );
}

async function fetchActionRows(guildId, eventType, channelId) {
  return query(
    'SELECT actions_json FROM action_profiles WHERE guild_id = ? AND trigger_event = ? AND enabled = 1 AND channel_id <=> ?',
    [guildId, eventType, channelId || null]
  );
}

async function loadActions(guildId, eventType, channelId) {
  let rows = [];
  if (channelId) {
    rows = await fetchActionRows(guildId, eventType, channelId);
    if (rows.length === 0) {
      rows = await fetchActionRows(guildId, eventType, null);
    }
  } else {
    rows = await fetchActionRows(guildId, eventType, null);
  }

  const actions = [];
  for (const row of rows) {
    if (!row.actions_json) {
      continue;
    }
    try {
      const parsed = Array.isArray(row.actions_json)
        ? row.actions_json
        : typeof row.actions_json === 'string'
          ? JSON.parse(row.actions_json)
          : row.actions_json;
      if (Array.isArray(parsed)) {
        actions.push(...parsed);
      }
    } catch (err) {
      // Ignore malformed actions.
    }
  }
  return actions;
}

async function createDelivery(eventId, guildId, serverId, payload) {
  const deliveryId = randomId().replace(/-/g, '');
  await query(
    `INSERT INTO push_deliveries
      (delivery_id, event_id, guild_id, server_id, status, attempt_count, payload_json, updated_at)
     VALUES (?, ?, ?, ?, 'pending', 0, ?, NOW())`,
    [deliveryId, eventId, guildId, serverId, JSON.stringify(payload)]
  );
  return deliveryId;
}

async function updateDeliverySuccess(deliveryId, httpStatus, latencyMs) {
  await query(
    `UPDATE push_deliveries
     SET status = 'success', attempt_count = attempt_count + 1, last_http_status = ?, last_latency_ms = ?, updated_at = NOW()
     WHERE delivery_id = ?`,
    [httpStatus, latencyMs, deliveryId]
  );
}

async function updateDeliveryFailure(deliveryId, httpStatus, errorMessage) {
  await query(
    `UPDATE push_deliveries
     SET status = 'failed', attempt_count = attempt_count + 1, last_http_status = ?, last_error = ?, updated_at = NOW()
     WHERE delivery_id = ?`,
    [httpStatus || null, errorMessage || null, deliveryId]
  );
}

async function pushEventToServers(event, options = {}) {
  const servers = await loadEnabledServers(event.guild_id);
  const routingRules = await getRoutingRules(event.guild_id, event.channel_id || null);
  const rule = routingRules[event.event_type];
  const routedServers = options.bypassRouting ? servers : filterServersByRule(servers, rule);
  const targetServers = options.serverIds
    ? routedServers.filter((server) => options.serverIds.includes(server.server_id))
    : routedServers;
  const actions = options.actionsOverride ?? (options.skipActions ? [] : await loadActions(event.guild_id, event.event_type, event.channel_id || null));

  const payload = {
    event_id: event.event_id,
    event_type: event.event_type,
    guild_id: event.guild_id,
    channel_id: event.channel_id || null,
    discord_user_id: event.discord_user_id,
    mc_uuid: event.mc_uuid,
    mc_ign: event.mc_ign,
    occurred_at: event.occurred_at,
    actions
  };

  const results = await Promise.all(targetServers.map(async (server) => {
    const deliveryId = await createDelivery(event.event_id, event.guild_id, server.server_id, payload);
    const timestamp = Math.floor(Date.now() / 1000).toString();
    const nonce = randomId();
    const body = JSON.stringify({ timestamp, nonce, payload });
    const signature = hmacSha256Hex(server.server_secret, body);
    const packet = JSON.stringify({
      timestamp,
      nonce,
      signature,
      payload
    });

    const startedAt = Date.now();
    try {
      const status = await sendTcpPayload(server, `${packet}\n`, config.pushTimeoutMs);
      const latencyMs = Date.now() - startedAt;
      if (status === 'ok') {
        await updateDeliverySuccess(deliveryId, 200, latencyMs);
        await query('UPDATE guild_servers SET last_seen_at = NOW() WHERE server_id = ?', [server.server_id]);
      } else {
        await updateDeliveryFailure(deliveryId, null, status || 'tcp_error');
      }
      return { server_id: server.server_id, status };
    } catch (err) {
      const latencyMs = Date.now() - startedAt;
      await updateDeliveryFailure(deliveryId, null, err.message);
      return { server_id: server.server_id, status: 'error', error: err.message, latency_ms: latencyMs };
    }
  }));

  return results;
}

module.exports = {
  pushEventToServers
};

function sendTcpPayload(server, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const host = server.server_host;
    const port = Number.parseInt(server.server_port, 10);
    if (!host || Number.isNaN(port)) {
      reject(new Error('missing_server_address'));
      return;
    }

    const socket = new net.Socket();
    let settled = false;
    const finish = (err, status) => {
      if (settled) {
        return;
      }
      settled = true;
      socket.destroy();
      if (err) {
        reject(err);
        return;
      }
      resolve(status || 'ok');
    };

    socket.setTimeout(timeoutMs || 5000);
    socket.on('timeout', () => finish(new Error('timeout')));
    socket.on('error', (err) => finish(err));
    socket.on('data', (data) => {
      const text = data.toString().trim();
      if (!text) {
        return;
      }
      if (text.toLowerCase() === 'ok') {
        finish(null, 'ok');
        return;
      }
      finish(null, text);
    });
    socket.on('close', (hadError) => {
      if (!hadError) {
        finish(null, 'ok');
      }
    });

    socket.connect(port, host, () => {
      socket.write(payload, (err) => {
        if (err) {
          finish(err);
          return;
        }
        socket.end();
      });
    });
  });
}
