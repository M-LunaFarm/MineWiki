ALTER TABLE `wiki_edit_requests`
  ADD COLUMN `request_kind` VARCHAR(16) NOT NULL DEFAULT 'edit' AFTER `id`,
  MODIFY COLUMN `page_id` BIGINT UNSIGNED NULL,
  MODIFY COLUMN `base_revision_id` BIGINT UNSIGNED NULL,
  ADD COLUMN `target_namespace_id` INT UNSIGNED NULL AFTER `base_revision_id`,
  ADD COLUMN `target_namespace_code` VARCHAR(32) NULL AFTER `target_namespace_id`,
  ADD COLUMN `target_space_id` BIGINT UNSIGNED NULL AFTER `target_namespace_code`,
  ADD COLUMN `target_title` VARCHAR(255) NULL AFTER `target_space_id`,
  ADD COLUMN `target_slug` VARCHAR(255) NULL AFTER `target_title`,
  ADD COLUMN `target_display_title` VARCHAR(255) NULL AFTER `target_slug`,
  ADD COLUMN `target_page_type` VARCHAR(32) NULL AFTER `target_display_title`,
  ADD INDEX `idx_wiki_edit_requests_target` (`target_namespace_id`, `target_slug`, `status`, `created_at`),
  ADD INDEX `idx_wiki_edit_requests_target_space` (`target_space_id`, `status`, `created_at`),
  ADD CONSTRAINT `chk_wiki_edit_requests_target_shape` CHECK (
    (`request_kind` = 'edit' AND `page_id` IS NOT NULL AND `base_revision_id` IS NOT NULL)
    OR
    (`request_kind` = 'create' AND `base_revision_id` IS NULL AND
      `target_namespace_id` IS NOT NULL AND `target_namespace_code` IS NOT NULL AND
      `target_space_id` IS NOT NULL AND `target_title` IS NOT NULL AND
      `target_slug` IS NOT NULL AND `target_display_title` IS NOT NULL AND
      `target_page_type` IS NOT NULL)
  );
