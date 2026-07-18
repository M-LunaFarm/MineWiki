ALTER TABLE `users`
  ADD COLUMN `username_changed_at` DATETIME(3) NULL AFTER `merged_at`;

CREATE TABLE `wiki_username_aliases` (
  `old_username` VARCHAR(64) NOT NULL,
  `profile_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`old_username`),
  INDEX `idx_wiki_username_aliases_profile` (`profile_id`, `created_at`),
  CONSTRAINT `fk_wiki_username_aliases_profile`
    FOREIGN KEY (`profile_id`) REFERENCES `users`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
