INSERT INTO `namespaces` (`code`, `display_name`, `path_prefix`, `is_content`)
VALUES ('category', '분류', '/wiki/category', FALSE)
ON DUPLICATE KEY UPDATE
  `display_name` = VALUES(`display_name`),
  `path_prefix` = VALUES(`path_prefix`),
  `is_content` = VALUES(`is_content`);

INSERT INTO `wiki_spaces` (
  `code`, `space_key`, `name`, `title`, `space_type`,
  `root_namespace_code`, `root_path`, `description`, `status`,
  `created_at`, `updated_at`
)
VALUES (
  'category', 'category', '분류', '분류', 'root',
  'category', '/wiki/category', '위키 분류 문서와 상하위 분류 계층', 'active',
  CURRENT_TIMESTAMP(3), CURRENT_TIMESTAMP(3)
)
ON DUPLICATE KEY UPDATE
  `space_key` = VALUES(`space_key`),
  `name` = VALUES(`name`),
  `title` = VALUES(`title`),
  `space_type` = VALUES(`space_type`),
  `root_namespace_code` = VALUES(`root_namespace_code`),
  `root_path` = VALUES(`root_path`),
  `description` = VALUES(`description`),
  `status` = VALUES(`status`),
  `updated_at` = VALUES(`updated_at`);
