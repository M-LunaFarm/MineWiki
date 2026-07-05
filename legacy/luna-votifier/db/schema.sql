CREATE TABLE IF NOT EXISTS guilds (
  guild_id VARCHAR(32) PRIMARY KEY,
  verified_role_id VARCHAR(32),
  log_channel_id VARCHAR(32),
  nickname_format VARCHAR(128),
  bot_message_template VARCHAR(512),
  bot_message_payload JSON,
  verify_reply_payload JSON,
  policy_json JSON,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS guild_channel_settings (
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
);

CREATE TABLE IF NOT EXISTS guild_permissions (
  guild_id VARCHAR(32) NOT NULL,
  discord_user_id VARCHAR(32) NOT NULL,
  permission VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (guild_id, discord_user_id),
  INDEX idx_guild_permissions_guild (guild_id),
  INDEX idx_guild_permissions_user (discord_user_id)
);

CREATE TABLE IF NOT EXISTS guild_servers (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  server_id VARCHAR(32) NOT NULL UNIQUE,
  server_name VARCHAR(100) NOT NULL,
  server_host VARCHAR(255) NOT NULL,
  server_port INT NOT NULL,
  endpoint_url VARCHAR(512) NULL,
  server_secret VARCHAR(128) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  last_seen_at DATETIME NULL,
  INDEX idx_guild_servers_guild (guild_id)
);

CREATE TABLE IF NOT EXISTS verify_sessions (
  session_id VARCHAR(32) PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  discord_user_id VARCHAR(32) NOT NULL,
  channel_id VARCHAR(32),
  status VARCHAR(16) NOT NULL DEFAULT 'pending',
  expires_at DATETIME NOT NULL,
  created_at DATETIME NOT NULL,
  completed_at DATETIME NULL,
  INDEX idx_verify_sessions_guild (guild_id),
  INDEX idx_verify_sessions_channel (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS account_links (
  discord_user_id VARCHAR(32) PRIMARY KEY,
  mc_uuid CHAR(36) NOT NULL,
  mc_ign VARCHAR(16) NOT NULL,
  last_verified_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  UNIQUE KEY uniq_account_links_uuid (mc_uuid)
);

CREATE TABLE IF NOT EXISTS guild_verifications (
  guild_id VARCHAR(32) NOT NULL,
  discord_user_id VARCHAR(32) NOT NULL,
  mc_uuid CHAR(36) NOT NULL,
  status VARCHAR(16) NOT NULL,
  verified_at DATETIME NOT NULL,
  PRIMARY KEY (guild_id, discord_user_id),
  INDEX idx_guild_verifications_uuid (mc_uuid)
);

CREATE TABLE IF NOT EXISTS routing_rules (
  guild_id VARCHAR(32) PRIMARY KEY,
  rules_json JSON,
  updated_at DATETIME NOT NULL
);

CREATE TABLE IF NOT EXISTS routing_rules_channels (
  guild_id VARCHAR(32) NOT NULL,
  channel_id VARCHAR(32) NOT NULL,
  rules_json JSON,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (guild_id, channel_id),
  INDEX idx_routing_rules_channels_guild (guild_id)
);

CREATE TABLE IF NOT EXISTS action_profiles (
  profile_id VARCHAR(32) PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  channel_id VARCHAR(32),
  name VARCHAR(64) NOT NULL,
  trigger_event VARCHAR(64) NOT NULL,
  targets_json JSON,
  actions_json JSON,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  updated_at DATETIME NOT NULL,
  INDEX idx_action_profiles_guild (guild_id),
  INDEX idx_action_profiles_channel (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS events (
  event_id VARCHAR(32) PRIMARY KEY,
  event_type VARCHAR(64) NOT NULL,
  guild_id VARCHAR(32) NOT NULL,
  channel_id VARCHAR(32),
  discord_user_id VARCHAR(32) NOT NULL,
  mc_uuid CHAR(36) NOT NULL,
  mc_ign VARCHAR(16) NOT NULL,
  occurred_at VARCHAR(40) NOT NULL,
  payload_json JSON,
  created_at DATETIME NOT NULL,
  INDEX idx_events_guild (guild_id),
  INDEX idx_events_channel (guild_id, channel_id)
);

CREATE TABLE IF NOT EXISTS push_deliveries (
  delivery_id VARCHAR(64) PRIMARY KEY,
  event_id VARCHAR(32) NOT NULL,
  guild_id VARCHAR(32) NOT NULL,
  server_id VARCHAR(32) NOT NULL,
  status VARCHAR(16) NOT NULL,
  attempt_count INT NOT NULL DEFAULT 0,
  next_retry_at DATETIME NULL,
  last_error VARCHAR(255),
  last_http_status INT,
  last_latency_ms INT,
  payload_json JSON,
  updated_at DATETIME NOT NULL,
  INDEX idx_push_deliveries_event (event_id)
);

CREATE TABLE IF NOT EXISTS audit_logs (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  guild_id VARCHAR(32) NOT NULL,
  actor_discord_id VARCHAR(32) NOT NULL,
  action VARCHAR(64) NOT NULL,
  diff_json JSON,
  created_at DATETIME NOT NULL,
  INDEX idx_audit_logs_guild (guild_id)
);

CREATE TABLE IF NOT EXISTS oauth_states (
  state VARCHAR(64) PRIMARY KEY,
  session_id VARCHAR(32) NOT NULL,
  created_at DATETIME NOT NULL,
  expires_at DATETIME NOT NULL,
  INDEX idx_oauth_states_session (session_id)
);

CREATE TABLE IF NOT EXISTS user_guild_links (
  guild_id VARCHAR(32) NOT NULL,
  user_id VARCHAR(32) NOT NULL,
  linked_at DATETIME NOT NULL,
  PRIMARY KEY (guild_id, user_id),
  INDEX idx_user_guild_links_user (user_id)
);

CREATE TABLE IF NOT EXISTS privacy_consents (
  discord_user_id VARCHAR(32) NOT NULL,
  consent_type VARCHAR(32) NOT NULL,
  consented_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  PRIMARY KEY (discord_user_id, consent_type),
  INDEX idx_privacy_consents_type (consent_type)
);

CREATE TABLE IF NOT EXISTS minecraft_entitlements_log (
  id BIGINT AUTO_INCREMENT PRIMARY KEY,
  event_id VARCHAR(32) NOT NULL,
  guild_id VARCHAR(32) NOT NULL,
  discord_user_id VARCHAR(32) NOT NULL,
  mc_uuid CHAR(36) NOT NULL,
  entitlements_json JSON,
  created_at DATETIME NOT NULL,
  UNIQUE KEY uniq_entitlements_event (event_id),
  INDEX idx_entitlements_guild (guild_id)
);
