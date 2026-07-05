CREATE TABLE IF NOT EXISTS `plugin_sync_replay_guards` (
  `id` CHAR(36) NOT NULL,
  `server_id` VARCHAR(32) NOT NULL,
  `nonce` VARCHAR(128) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `plugin_sync_replay_guards_server_id_nonce_key` (`server_id`, `nonce`),
  KEY `plugin_sync_replay_guards_expires_at_idx` (`expires_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `plugin_sync_cooldowns` (
  `server_id` VARCHAR(32) NOT NULL,
  `last_seen_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`server_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
