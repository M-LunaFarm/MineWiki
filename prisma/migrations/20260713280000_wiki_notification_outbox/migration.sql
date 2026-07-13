CREATE TABLE `wiki_notification_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `event_key` VARCHAR(191) NOT NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `payload_json` JSON NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `attempts` INTEGER NOT NULL DEFAULT 0,
  `available_at` DATETIME(3) NOT NULL,
  `locked_at` DATETIME(3) NULL,
  `locked_by` VARCHAR(128) NULL,
  `processed_at` DATETIME(3) NULL,
  `last_error` VARCHAR(1000) NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `wiki_notification_events_event_key_key` (`event_key`),
  INDEX `idx_wiki_notification_events_pending` (`status`, `available_at`, `id`),
  INDEX `idx_wiki_notification_events_locked` (`locked_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `wiki_discussion_subscriptions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `thread_id` BIGINT UNSIGNED NOT NULL,
  `profile_id` BIGINT UNSIGNED NOT NULL,
  `muted` BOOLEAN NOT NULL DEFAULT false,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uk_wiki_discussion_subscriptions_thread_profile` (`thread_id`, `profile_id`),
  INDEX `idx_wiki_discussion_subscriptions_profile` (`profile_id`, `updated_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
