const mysql = require('mysql2/promise');
const path = require('path');
require('dotenv').config({ path: process.env.WEB_ENV_FILE || path.resolve(process.cwd(), '.env') });

const dbConfig = {
  host: process.env.DB_HOST || '127.0.0.1',
  port: Number(process.env.DB_PORT || 3306),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'lunaf_verify'
};

async function tableExists(conn, tableName) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS count FROM information_schema.tables WHERE table_schema = ? AND table_name = ?',
    [dbConfig.database, tableName]
  );
  return rows[0]?.count > 0;
}

async function columnExists(conn, tableName, columnName) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS count FROM information_schema.columns WHERE table_schema = ? AND table_name = ? AND column_name = ?',
    [dbConfig.database, tableName, columnName]
  );
  return rows[0]?.count > 0;
}

async function indexExists(conn, tableName, indexName) {
  const [rows] = await conn.query(
    'SELECT COUNT(*) AS count FROM information_schema.statistics WHERE table_schema = ? AND table_name = ? AND index_name = ?',
    [dbConfig.database, tableName, indexName]
  );
  return rows[0]?.count > 0;
}

async function ensureColumn(conn, tableName, columnName, columnDef) {
  const exists = await columnExists(conn, tableName, columnName);
  if (!exists) {
    await conn.query(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${columnDef}`);
    // eslint-disable-next-line no-console
    console.log(`Added column ${tableName}.${columnName}`);
  }
}

async function ensureIndex(conn, tableName, indexName, indexSql) {
  const exists = await indexExists(conn, tableName, indexName);
  if (!exists) {
    await conn.query(indexSql);
    // eslint-disable-next-line no-console
    console.log(`Added index ${indexName} on ${tableName}`);
  }
}

async function ensureTable(conn, tableName, createSql) {
  const exists = await tableExists(conn, tableName);
  if (!exists) {
    await conn.query(createSql);
    // eslint-disable-next-line no-console
    console.log(`Created table ${tableName}`);
  }
}

async function run() {
  const conn = await mysql.createConnection(dbConfig);

  await ensureTable(
    conn,
    'guild_channel_settings',
    `CREATE TABLE guild_channel_settings (
      guild_id VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32) NOT NULL,
      verified_role_id VARCHAR(32),
      log_channel_id VARCHAR(32),
      nickname_format VARCHAR(128),
      bot_message_template VARCHAR(512),
      bot_message_payload JSON,
      verify_reply_payload JSON,
      policy_json JSON,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (guild_id, channel_id),
      INDEX idx_channel_settings_guild (guild_id)
    )`
  );

  await ensureTable(
    conn,
    'routing_rules_channels',
    `CREATE TABLE routing_rules_channels (
      guild_id VARCHAR(32) NOT NULL,
      channel_id VARCHAR(32) NOT NULL,
      rules_json JSON,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (guild_id, channel_id),
      INDEX idx_routing_rules_channels_guild (guild_id)
    )`
  );

  await ensureTable(
    conn,
    'user_guild_links',
    `CREATE TABLE user_guild_links (
      guild_id VARCHAR(32) NOT NULL,
      user_id VARCHAR(32) NOT NULL,
      linked_at DATETIME NOT NULL,
      PRIMARY KEY (guild_id, user_id),
      INDEX idx_user_guild_links_user (user_id)
    )`
  );

  await ensureTable(
    conn,
    'guild_permissions',
    `CREATE TABLE guild_permissions (
      guild_id VARCHAR(32) NOT NULL,
      discord_user_id VARCHAR(32) NOT NULL,
      permission VARCHAR(32) NOT NULL,
      created_at DATETIME NOT NULL,
      updated_at DATETIME NOT NULL,
      PRIMARY KEY (guild_id, discord_user_id),
      INDEX idx_guild_permissions_guild (guild_id),
      INDEX idx_guild_permissions_user (discord_user_id)
    )`
  );

  await ensureTable(
    conn,
    'minecraft_entitlements_log',
    `CREATE TABLE minecraft_entitlements_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      event_id VARCHAR(32) NOT NULL,
      guild_id VARCHAR(32) NOT NULL,
      discord_user_id VARCHAR(32) NOT NULL,
      mc_uuid CHAR(36) NOT NULL,
      entitlements_json JSON,
      created_at DATETIME NOT NULL,
      UNIQUE KEY uniq_entitlements_event (event_id),
      INDEX idx_entitlements_guild (guild_id)
    )`
  );

  await ensureColumn(conn, 'verify_sessions', 'channel_id', 'VARCHAR(32) NULL');
  await ensureIndex(conn, 'verify_sessions', 'idx_verify_sessions_channel', 'ALTER TABLE verify_sessions ADD INDEX idx_verify_sessions_channel (guild_id, channel_id)');

  await ensureColumn(conn, 'guilds', 'bot_message_template', 'VARCHAR(512) NULL');
  await ensureColumn(conn, 'guilds', 'bot_message_payload', 'JSON NULL');
  await ensureColumn(conn, 'guilds', 'verify_reply_payload', 'JSON NULL');
  await ensureColumn(conn, 'guilds', 'policy_json', 'JSON NULL');
  await ensureColumn(conn, 'guild_channel_settings', 'bot_message_template', 'VARCHAR(512) NULL');
  await ensureColumn(conn, 'guild_channel_settings', 'bot_message_payload', 'JSON NULL');
  await ensureColumn(conn, 'guild_channel_settings', 'verify_reply_payload', 'JSON NULL');

  await ensureColumn(conn, 'action_profiles', 'channel_id', 'VARCHAR(32) NULL');
  await ensureIndex(conn, 'action_profiles', 'idx_action_profiles_channel', 'ALTER TABLE action_profiles ADD INDEX idx_action_profiles_channel (guild_id, channel_id)');

  await ensureColumn(conn, 'events', 'channel_id', 'VARCHAR(32) NULL');
  await ensureIndex(conn, 'events', 'idx_events_channel', 'ALTER TABLE events ADD INDEX idx_events_channel (guild_id, channel_id)');

  await ensureColumn(conn, 'push_deliveries', 'payload_json', 'JSON NULL');
  await ensureColumn(conn, 'guild_servers', 'endpoint_url', 'VARCHAR(512) NULL');
  await conn.query('ALTER TABLE guild_servers MODIFY COLUMN endpoint_url VARCHAR(512) NULL');
  await conn.query('ALTER TABLE push_deliveries MODIFY COLUMN delivery_id VARCHAR(64) NOT NULL');

  await conn.end();
}

run().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('Migration failed:', err.message);
  process.exit(1);
});
