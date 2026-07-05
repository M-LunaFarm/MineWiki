const { query } = require('../db');

async function logAudit({ guildId, actorId, action, diff }) {
  await query(
    'INSERT INTO audit_logs (guild_id, actor_discord_id, action, diff_json, created_at) VALUES (?, ?, ?, ?, NOW())',
    [guildId, actorId, action, JSON.stringify(diff || {})]
  );
}

module.exports = {
  logAudit
};
