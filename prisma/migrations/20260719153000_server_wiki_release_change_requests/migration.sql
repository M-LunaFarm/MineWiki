CREATE UNIQUE INDEX `uq_server_wiki_release_candidate_tenant_token`
  ON `server_wiki_release_candidates` (`id`, `server_wiki_id`, `space_id`, `token`);

CREATE TABLE `server_wiki_release_change_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `candidate_id` BIGINT UNSIGNED NOT NULL,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `space_id` BIGINT UNSIGNED NOT NULL,
  `candidate_token` CHAR(64) NOT NULL,
  `note` VARCHAR(1000) NOT NULL,
  `reviewer_profile_id` BIGINT UNSIGNED NOT NULL,
  `decided_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `server_wiki_release_change_requests_candidate_id_key` (`candidate_id`),
  UNIQUE INDEX `uq_server_wiki_release_change_request_tenant` (`candidate_id`, `server_wiki_id`, `space_id`, `candidate_token`),
  INDEX `idx_server_wiki_release_change_request_tenant` (`server_wiki_id`, `space_id`, `decided_at`),
  INDEX `idx_server_wiki_release_change_request_reviewer` (`reviewer_profile_id`, `decided_at`),
  CONSTRAINT `server_wiki_release_change_requests_candidate_tenant_fkey`
    FOREIGN KEY (`candidate_id`, `server_wiki_id`, `space_id`, `candidate_token`)
    REFERENCES `server_wiki_release_candidates` (`id`, `server_wiki_id`, `space_id`, `token`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
