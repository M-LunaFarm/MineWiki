CREATE TABLE `wiki_notifications` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `profile_id` BIGINT UNSIGNED NOT NULL,
  `type` VARCHAR(32) NOT NULL,
  `page_id` BIGINT UNSIGNED NULL,
  `actor_profile_id` BIGINT UNSIGNED NULL,
  `source_type` VARCHAR(32) NOT NULL,
  `source_id` VARCHAR(64) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `message` VARCHAR(500) NULL,
  `href` VARCHAR(1000) NOT NULL,
  `dedupe_key` VARCHAR(191) NOT NULL,
  `read_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uk_wiki_notifications_dedupe`(`dedupe_key`),
  INDEX `idx_wiki_notifications_inbox`(`profile_id`, `read_at`, `id`),
  INDEX `idx_wiki_notifications_profile`(`profile_id`, `id`),
  INDEX `idx_wiki_notifications_page`(`page_id`, `id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
