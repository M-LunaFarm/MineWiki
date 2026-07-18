ALTER TABLE `page_lifecycle_events`
  ADD COLUMN `source_revision_id` BIGINT UNSIGNED NULL AFTER `actor_profile_id`,
  ADD INDEX `idx_page_lifecycle_source_revision` (`source_revision_id`);
