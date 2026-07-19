ALTER TABLE `wiki_discussion_threads`
  MODIFY COLUMN `created_by` BIGINT UNSIGNED NULL,
  ADD COLUMN `anonymous_owner_id` BIGINT UNSIGNED NULL,
  ADD COLUMN `actor_ip_hash` CHAR(64) NULL,
  ADD INDEX `idx_wiki_threads_anonymous_owner` (`anonymous_owner_id`, `created_at`),
  ADD INDEX `idx_wiki_threads_actor_ip` (`actor_ip_hash`, `created_at`),
  ADD CONSTRAINT `fk_wiki_threads_anonymous_owner`
    FOREIGN KEY (`anonymous_owner_id`) REFERENCES `wiki_anonymous_contributor_sessions` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `chk_wiki_threads_actor_shape` CHECK (
    (`created_by` IS NOT NULL AND `anonymous_owner_id` IS NULL AND `actor_ip_hash` IS NULL)
    OR
    (`created_by` IS NULL AND `anonymous_owner_id` IS NOT NULL AND `actor_ip_hash` IS NOT NULL)
  );

ALTER TABLE `wiki_discussion_comments`
  MODIFY COLUMN `created_by` BIGINT UNSIGNED NULL,
  ADD COLUMN `anonymous_owner_id` BIGINT UNSIGNED NULL,
  ADD COLUMN `actor_ip_hash` CHAR(64) NULL,
  ADD INDEX `idx_wiki_comments_anonymous_owner` (`anonymous_owner_id`, `created_at`),
  ADD INDEX `idx_wiki_comments_actor_ip` (`actor_ip_hash`, `created_at`),
  ADD CONSTRAINT `fk_wiki_comments_anonymous_owner`
    FOREIGN KEY (`anonymous_owner_id`) REFERENCES `wiki_anonymous_contributor_sessions` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `chk_wiki_comments_actor_shape` CHECK (
    (`created_by` IS NOT NULL AND `anonymous_owner_id` IS NULL AND `actor_ip_hash` IS NULL)
    OR
    (`created_by` IS NULL AND `anonymous_owner_id` IS NOT NULL AND `actor_ip_hash` IS NOT NULL)
  );
