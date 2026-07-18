CREATE TABLE `server_wiki_release_approvals` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `space_id` BIGINT UNSIGNED NOT NULL,
  `candidate_token` CHAR(64) NOT NULL,
  `reviewer_profile_id` BIGINT UNSIGNED NOT NULL,
  `approved_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_server_wiki_release_approval` (`server_wiki_id`, `candidate_token`, `reviewer_profile_id`),
  INDEX `idx_server_wiki_release_approval_candidate` (`server_wiki_id`, `candidate_token`, `revoked_at`),
  INDEX `idx_server_wiki_release_approval_reviewer` (`space_id`, `reviewer_profile_id`, `approved_at`),
  CONSTRAINT `server_wiki_release_approvals_server_wiki_id_fkey`
    FOREIGN KEY (`server_wiki_id`) REFERENCES `server_wikis` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
