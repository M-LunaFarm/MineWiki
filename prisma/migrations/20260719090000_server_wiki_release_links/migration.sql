CREATE TABLE `server_wiki_release_links` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `release_id` BIGINT UNSIGNED NOT NULL,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `space_id` BIGINT UNSIGNED NOT NULL,
  `source_page_id` BIGINT UNSIGNED NOT NULL,
  `source_revision_id` BIGINT UNSIGNED NOT NULL,
  `target_namespace_code` VARCHAR(32) NOT NULL,
  `target_slug` VARCHAR(255) NOT NULL,
  `link_type` VARCHAR(32) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_server_wiki_release_link` (`release_id`, `source_page_id`, `target_namespace_code`, `target_slug`, `link_type`),
  INDEX `idx_server_wiki_release_link_source` (`release_id`, `source_page_id`),
  INDEX `idx_server_wiki_release_link_wiki` (`server_wiki_id`, `release_id`),
  INDEX `idx_server_wiki_release_link_space` (`space_id`, `release_id`),
  INDEX `idx_server_wiki_release_link_target` (`target_namespace_code`, `target_slug`, `link_type`),
  CONSTRAINT `server_wiki_release_links_release_id_fkey`
    FOREIGN KEY (`release_id`) REFERENCES `server_wiki_releases` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
