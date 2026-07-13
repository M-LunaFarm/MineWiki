CREATE TABLE `page_links` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `source_page_id` BIGINT UNSIGNED NOT NULL,
  `source_revision_id` BIGINT UNSIGNED NOT NULL,
  `target_namespace_code` VARCHAR(32) NOT NULL,
  `target_slug` VARCHAR(255) NOT NULL,
  `link_type` VARCHAR(32) NOT NULL DEFAULT 'link',
  `created_at` DATETIME(3) NOT NULL,

  UNIQUE INDEX `uk_page_links_source_target`(`source_page_id`, `target_namespace_code`, `target_slug`, `link_type`),
  INDEX `idx_page_links_target`(`target_namespace_code`, `target_slug`, `id`),
  INDEX `idx_page_links_revision`(`source_revision_id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE INDEX `recent_changes_actor_id_created_at_idx`
  ON `recent_changes`(`actor_id`, `created_at`);
