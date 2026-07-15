CREATE TABLE `wiki_push_subscriptions` (
  `id` CHAR(36) NOT NULL,
  `session_id` CHAR(36) NOT NULL,
  `profile_id` BIGINT UNSIGNED NOT NULL,
  `endpoint_hash` CHAR(64) NOT NULL,
  `endpoint_ciphertext` TEXT NOT NULL,
  `p256dh_ciphertext` TEXT NOT NULL,
  `auth_ciphertext` TEXT NOT NULL,
  `content_encoding` VARCHAR(16) NOT NULL DEFAULT 'aes128gcm',
  `expiration_time` DATETIME(3) NULL,
  `disabled_at` DATETIME(3) NULL,
  `last_success_at` DATETIME(3) NULL,
  `last_failure_at` DATETIME(3) NULL,
  `failure_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uk_wiki_push_subscriptions_session` (`session_id`),
  UNIQUE INDEX `uk_wiki_push_subscriptions_endpoint` (`endpoint_hash`),
  INDEX `idx_wiki_push_subscriptions_profile` (`profile_id`, `disabled_at`),
  INDEX `idx_wiki_push_subscriptions_expiration` (`expiration_time`),
  PRIMARY KEY (`id`),
  CONSTRAINT `wiki_push_subscriptions_session_id_fkey`
    FOREIGN KEY (`session_id`) REFERENCES `Session`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `wiki_push_subscriptions_profile_id_fkey`
    FOREIGN KEY (`profile_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `wiki_push_deliveries` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `notification_id` BIGINT UNSIGNED NOT NULL,
  `subscription_id` CHAR(36) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `attempts` INT UNSIGNED NOT NULL DEFAULT 0,
  `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `locked_at` DATETIME(3) NULL,
  `locked_by` VARCHAR(128) NULL,
  `delivered_at` DATETIME(3) NULL,
  `last_error` VARCHAR(500) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `uk_wiki_push_deliveries_notification_subscription` (`notification_id`, `subscription_id`),
  INDEX `idx_wiki_push_deliveries_pending` (`status`, `available_at`, `id`),
  INDEX `idx_wiki_push_deliveries_locked` (`locked_at`),
  INDEX `idx_wiki_push_deliveries_subscription` (`subscription_id`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `wiki_push_deliveries_notification_id_fkey`
    FOREIGN KEY (`notification_id`) REFERENCES `wiki_notifications`(`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `wiki_push_deliveries_subscription_id_fkey`
    FOREIGN KEY (`subscription_id`) REFERENCES `wiki_push_subscriptions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
