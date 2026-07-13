CREATE TABLE `wiki_user_block_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `target_profile_id` BIGINT UNSIGNED NOT NULL,
  `actor_profile_id` BIGINT UNSIGNED NOT NULL,
  `action` VARCHAR(16) NOT NULL,
  `previous_status` VARCHAR(32) NOT NULL,
  `new_status` VARCHAR(32) NOT NULL,
  `reason` VARCHAR(1000) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idx_wiki_user_block_events_target` (`target_profile_id`, `id`),
  INDEX `idx_wiki_user_block_events_actor` (`actor_profile_id`, `created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
