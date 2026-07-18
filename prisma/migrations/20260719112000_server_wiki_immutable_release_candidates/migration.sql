CREATE TABLE `server_wiki_release_candidates` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `space_id` BIGINT UNSIGNED NOT NULL,
  `baseline_release_id` BIGINT UNSIGNED NULL,
  `source_publication_version` INT UNSIGNED NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending_review',
  `token` CHAR(64) NOT NULL,
  `site_slug` VARCHAR(80) NOT NULL,
  `content_slug` VARCHAR(255) NOT NULL,
  `required_approvals` INT UNSIGNED NOT NULL DEFAULT 0,
  `submission_reason` VARCHAR(500) NOT NULL,
  `manifest_snapshot` JSON NOT NULL,
  `release_snapshot` JSON NOT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `submitted_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_server_wiki_release_candidate_token` (`server_wiki_id`, `token`),
  INDEX `idx_server_wiki_release_candidate_space` (`space_id`, `created_at`),
  INDEX `idx_server_wiki_release_candidate_status` (`server_wiki_id`, `status`, `submitted_at`),
  INDEX `idx_server_wiki_release_candidate_baseline` (`server_wiki_id`, `baseline_release_id`, `created_at`),
  CONSTRAINT `fk_server_wiki_release_candidate_wiki`
    FOREIGN KEY (`server_wiki_id`) REFERENCES `server_wikis` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `server_wiki_release_approvals`
  ADD COLUMN `candidate_id` BIGINT UNSIGNED NULL AFTER `candidate_token`,
  ADD UNIQUE INDEX `uq_server_wiki_release_approval_candidate_id` (`candidate_id`, `reviewer_profile_id`),
  ADD CONSTRAINT `fk_server_wiki_release_approval_candidate`
    FOREIGN KEY (`candidate_id`) REFERENCES `server_wiki_release_candidates` (`id`) ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE `server_wiki_releases`
  ADD COLUMN `candidate_id` BIGINT UNSIGNED NULL AFTER `published_at`,
  ADD UNIQUE INDEX `server_wiki_releases_candidate_id_key` (`candidate_id`),
  ADD CONSTRAINT `fk_server_wiki_release_candidate`
    FOREIGN KEY (`candidate_id`) REFERENCES `server_wiki_release_candidates` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE;
