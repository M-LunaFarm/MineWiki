CREATE TABLE IF NOT EXISTS `plugin_servers` (
  `id` CHAR(36) NOT NULL,
  `minewiki_server_id` VARCHAR(191) NULL,
  `guild_id` VARCHAR(32) NOT NULL,
  `plugin_server_id` VARCHAR(32) NOT NULL,
  `server_name` VARCHAR(100) NOT NULL,
  `host` VARCHAR(255) NOT NULL,
  `port` INT NOT NULL,
  `endpoint_url` VARCHAR(512) NULL,
  `server_secret` VARCHAR(128) NOT NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT TRUE,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  `last_seen_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `plugin_servers_plugin_server_id_key` (`plugin_server_id`),
  KEY `plugin_servers_minewiki_server_id_idx` (`minewiki_server_id`),
  KEY `plugin_servers_guild_id_idx` (`guild_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `plugin_servers` (
  `id`,
  `minewiki_server_id`,
  `guild_id`,
  `plugin_server_id`,
  `server_name`,
  `host`,
  `port`,
  `endpoint_url`,
  `server_secret`,
  `enabled`,
  `created_at`,
  `updated_at`,
  `last_seen_at`
)
SELECT
  UUID(),
  NULL,
  `guild_id`,
  `server_id`,
  `server_name`,
  `server_host`,
  `server_port`,
  `endpoint_url`,
  `server_secret`,
  `enabled`,
  `created_at`,
  `updated_at`,
  `last_seen_at`
FROM `guild_servers`;
