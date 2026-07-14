CREATE TABLE `wiki_discussion_moderation_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `thread_id` BIGINT UNSIGNED NOT NULL,
  `comment_id` BIGINT UNSIGNED NOT NULL,
  `actor_profile_id` BIGINT UNSIGNED NOT NULL,
  `action` VARCHAR(32) NOT NULL,
  `reason` VARCHAR(1000) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_wiki_comment_moderation_comment` (`comment_id`, `id`),
  INDEX `idx_wiki_comment_moderation_thread` (`thread_id`, `id`),
  INDEX `idx_wiki_comment_moderation_actor` (`actor_profile_id`, `created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
