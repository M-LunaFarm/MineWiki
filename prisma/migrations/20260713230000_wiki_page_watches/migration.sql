CREATE TABLE `wiki_page_watches` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `profile_id` BIGINT UNSIGNED NOT NULL,
  `page_id` BIGINT UNSIGNED NOT NULL,
  `last_seen_revision_id` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uk_wiki_page_watches_profile_page`(`profile_id`, `page_id`),
  INDEX `idx_wiki_page_watches_profile`(`profile_id`, `updated_at`),
  INDEX `idx_wiki_page_watches_page`(`page_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
