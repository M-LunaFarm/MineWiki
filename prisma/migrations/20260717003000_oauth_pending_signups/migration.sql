CREATE TABLE `oauth_pending_signups` (
  `id` CHAR(64) NOT NULL,
  `provider` ENUM('discord', 'naver') NOT NULL,
  `payload_encrypted` TEXT NOT NULL,
  `return_to` VARCHAR(2048) NULL,
  `browser_binding_hash` CHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_oauth_pending_signups_expires` (`expires_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
