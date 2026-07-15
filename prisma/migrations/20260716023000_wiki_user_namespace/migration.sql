ALTER TABLE `pages`
  ADD COLUMN `owner_profile_id` BIGINT UNSIGNED NULL AFTER `created_by`,
  ADD INDEX `idx_pages_user_owner_path` (`owner_profile_id`, `local_path`);

ALTER TABLE `wiki_edit_requests`
  ADD COLUMN `target_owner_profile_id` BIGINT UNSIGNED NULL AFTER `target_page_type`,
  ADD INDEX `idx_wiki_edit_requests_user_owner` (`target_namespace_id`, `target_owner_profile_id`, `target_slug`, `status`);

INSERT INTO `namespaces` (`code`, `display_name`, `path_prefix`, `is_content`)
VALUES ('user', '사용자', '/user', FALSE)
ON DUPLICATE KEY UPDATE
  `display_name` = VALUES(`display_name`),
  `path_prefix` = VALUES(`path_prefix`),
  `is_content` = VALUES(`is_content`);

INSERT INTO `wiki_spaces` (
  `code`, `space_key`, `name`, `title`, `slug`, `space_type`,
  `root_namespace_code`, `root_path`, `description`, `status`,
  `created_at`, `updated_at`
)
VALUES (
  'user', 'user', '사용자', '사용자', 'user', 'basic',
  'user', '/user', 'MineWiki 사용자 문서 공간', 'active',
  UTC_TIMESTAMP(3), UTC_TIMESTAMP(3)
)
ON DUPLICATE KEY UPDATE
  `space_key` = VALUES(`space_key`),
  `name` = VALUES(`name`),
  `title` = VALUES(`title`),
  `slug` = VALUES(`slug`),
  `space_type` = VALUES(`space_type`),
  `root_namespace_code` = VALUES(`root_namespace_code`),
  `root_path` = VALUES(`root_path`),
  `description` = VALUES(`description`),
  `status` = VALUES(`status`),
  `updated_at` = VALUES(`updated_at`);
