ALTER TABLE `recent_changes`
  ADD COLUMN `previous_public_revision_id` BIGINT UNSIGNED NULL AFTER `revision_id`,
  ADD COLUMN `space_id` BIGINT UNSIGNED NULL AFTER `actor_id`,
  ADD COLUMN `local_path` VARCHAR(500) NULL AFTER `title`,
  ADD COLUMN `size_delta` INTEGER NULL AFTER `summary`,
  ADD COLUMN `event_audience` VARCHAR(16) NOT NULL DEFAULT 'restricted' AFTER `size_delta`,
  ADD INDEX `idx_recent_changes_space_id` (`space_id`, `id`),
  ADD INDEX `idx_recent_changes_space_type_id` (`space_id`, `change_type`, `id`);

-- Historical rows predate the immutable audience snapshot. Keep them restricted;
-- visibility must never be inferred from a page's later state.
UPDATE `recent_changes`
SET `event_audience` = 'restricted'
WHERE `event_audience` <> 'restricted';
