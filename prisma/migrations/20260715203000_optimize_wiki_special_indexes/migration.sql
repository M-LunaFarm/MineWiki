DROP INDEX `idx_pages_special_old` ON `pages`;
DROP INDEX `idx_pages_special_size` ON `pages`;
DROP INDEX `idx_pages_special_category` ON `pages`;

CREATE INDEX `idx_pages_special_old`
  ON `pages` (`updated_at`, `id`);
CREATE INDEX `idx_pages_special_old_namespace`
  ON `pages` (`namespace_id`, `updated_at`, `id`);
CREATE INDEX `idx_pages_special_size`
  ON `pages` (`current_content_size`, `id`);
CREATE INDEX `idx_pages_special_size_namespace`
  ON `pages` (`namespace_id`, `current_content_size`, `id`);
CREATE INDEX `idx_pages_special_category`
  ON `pages` (`current_category_count`, `updated_at`, `id`);
CREATE INDEX `idx_pages_special_category_namespace`
  ON `pages` (`namespace_id`, `current_category_count`, `updated_at`, `id`);
