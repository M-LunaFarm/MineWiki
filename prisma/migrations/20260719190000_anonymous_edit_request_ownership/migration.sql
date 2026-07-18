CREATE TABLE `wiki_anonymous_contributor_sessions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `token_digest` CHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `last_used_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `revoked_at` DATETIME(3) NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `wiki_anonymous_contributor_sessions_token_digest_key` (`token_digest`),
  INDEX `idx_wiki_anonymous_contributor_sessions_expiry` (`expires_at`, `revoked_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `wiki_edit_requests`
  ADD COLUMN `anonymous_owner_id` BIGINT UNSIGNED NULL AFTER `submitter_ip_hash`,
  ADD INDEX `idx_wiki_edit_requests_anonymous_owner` (`anonymous_owner_id`, `status`, `created_at`),
  ADD CONSTRAINT `wiki_edit_requests_anonymous_owner_id_fkey`
    FOREIGN KEY (`anonymous_owner_id`) REFERENCES `wiki_anonymous_contributor_sessions`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Legacy anonymous requests deliberately remain unclaimable: IP hashes are abuse
-- prevention data, not identity. New submissions receive an owner in the service.
