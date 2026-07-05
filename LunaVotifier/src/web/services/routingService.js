const { query } = require('../db');

async function loadRulesRow(guildId, channelId) {
  const table = channelId ? 'routing_rules_channels' : 'routing_rules';
  const params = channelId ? [guildId, channelId] : [guildId];
  const rows = await query(
    `SELECT rules_json FROM ${table} WHERE guild_id = ? ${channelId ? 'AND channel_id = ?' : ''}`,
    params
  );
  return rows;
}

async function getRoutingRules(guildId, channelId) {
  let rows = [];
  if (channelId) {
    rows = await loadRulesRow(guildId, channelId);
    if (rows.length === 0) {
      rows = await loadRulesRow(guildId, null);
    }
  } else {
    rows = await loadRulesRow(guildId, null);
  }
  if (rows.length === 0 || !rows[0].rules_json) {
    return {};
  }
  try {
    return typeof rows[0].rules_json === 'string'
      ? JSON.parse(rows[0].rules_json)
      : rows[0].rules_json;
  } catch (err) {
    return {};
  }
}

async function saveRoutingRules(guildId, channelId, rules) {
  if (channelId) {
    await query(
      `INSERT INTO routing_rules_channels (guild_id, channel_id, rules_json, updated_at)
       VALUES (?, ?, ?, NOW())
       ON DUPLICATE KEY UPDATE rules_json = VALUES(rules_json), updated_at = NOW()`,
      [guildId, channelId, JSON.stringify(rules || {})]
    );
    return;
  }
  await query(
    `INSERT INTO routing_rules (guild_id, rules_json, updated_at)
     VALUES (?, ?, NOW())
     ON DUPLICATE KEY UPDATE rules_json = VALUES(rules_json), updated_at = NOW()`,
    [guildId, JSON.stringify(rules || {})]
  );
}

function filterServersByRule(servers, rule) {
  if (!rule || !rule.mode || rule.mode === 'all') {
    return servers;
  }

  if (rule.mode === 'include') {
    const set = new Set(rule.server_ids || []);
    return servers.filter((server) => set.has(server.server_id));
  }

  if (rule.mode === 'exclude') {
    const set = new Set(rule.server_ids || []);
    return servers.filter((server) => !set.has(server.server_id));
  }

  return servers;
}

module.exports = {
  getRoutingRules,
  saveRoutingRules,
  filterServersByRule
};
