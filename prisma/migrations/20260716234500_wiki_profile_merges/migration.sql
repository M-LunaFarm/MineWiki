ALTER TABLE `users`
  ADD COLUMN `merged_into_profile_id` BIGINT UNSIGNED NULL AFTER `status`,
  ADD COLUMN `merged_at` DATETIME(3) NULL AFTER `merged_into_profile_id`,
  ADD INDEX `idx_users_merged_into` (`merged_into_profile_id`),
  ADD CONSTRAINT `users_merged_into_profile_id_fkey`
    FOREIGN KEY (`merged_into_profile_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE `wiki_profile_merge_requests` (
  `id` CHAR(36) NOT NULL,
  `canonical_account_id` CHAR(36) NOT NULL,
  `source_profile_id` BIGINT UNSIGNED NOT NULL,
  `target_profile_id` BIGINT UNSIGNED NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `requested_by_account_id` CHAR(36) NOT NULL,
  `requested_by_profile_id` BIGINT UNSIGNED NOT NULL,
  `approved_by_profile_id` BIGINT UNSIGNED NULL,
  `reason` VARCHAR(1000) NULL,
  `preview_json` JSON NOT NULL,
  `active_key` VARCHAR(191) NULL,
  `error_code` VARCHAR(64) NULL,
  `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `approved_at` DATETIME(3) NULL,
  `completed_at` DATETIME(3) NULL,
  `rejected_at` DATETIME(3) NULL,
  `version` INT NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `wiki_profile_merge_requests_active_key_key` (`active_key`),
  INDEX `idx_wiki_profile_merges_account` (`canonical_account_id`, `status`, `requested_at`),
  INDEX `idx_wiki_profile_merges_admin` (`status`, `requested_at`),
  INDEX `idx_wiki_profile_merges_source` (`source_profile_id`, `status`),
  INDEX `idx_wiki_profile_merges_target` (`target_profile_id`, `status`),
  PRIMARY KEY (`id`),
  CONSTRAINT `wiki_profile_merges_source_profile_id_fkey`
    FOREIGN KEY (`source_profile_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `wiki_profile_merges_target_profile_id_fkey`
    FOREIGN KEY (`target_profile_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `wiki_profile_merges_requested_by_profile_id_fkey`
    FOREIGN KEY (`requested_by_profile_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `wiki_profile_merges_approved_by_profile_id_fkey`
    FOREIGN KEY (`approved_by_profile_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `wiki_profile_aliases` (
  `source_profile_id` BIGINT UNSIGNED NOT NULL,
  `target_profile_id` BIGINT UNSIGNED NOT NULL,
  `merge_request_id` CHAR(36) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `wiki_profile_aliases_merge_request_id_key` (`merge_request_id`),
  INDEX `idx_wiki_profile_aliases_target` (`target_profile_id`, `source_profile_id`),
  PRIMARY KEY (`source_profile_id`),
  CONSTRAINT `wiki_profile_aliases_source_profile_id_fkey`
    FOREIGN KEY (`source_profile_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `wiki_profile_aliases_target_profile_id_fkey`
    FOREIGN KEY (`target_profile_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `wiki_profile_aliases_merge_request_id_fkey`
    FOREIGN KEY (`merge_request_id`) REFERENCES `wiki_profile_merge_requests`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
