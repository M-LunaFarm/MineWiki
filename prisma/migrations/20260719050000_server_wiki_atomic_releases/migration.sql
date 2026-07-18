CREATE TABLE `server_wiki_releases` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `version` INTEGER UNSIGNED NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `presentation_snapshot` JSON NOT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `published_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_server_wiki_release_version` (`server_wiki_id`, `version`),
  INDEX `idx_server_wiki_release_published` (`server_wiki_id`, `published_at`),
  CONSTRAINT `server_wiki_releases_server_wiki_id_fkey`
    FOREIGN KEY (`server_wiki_id`) REFERENCES `server_wikis` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `server_wiki_release_items` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `release_id` BIGINT UNSIGNED NOT NULL,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `space_id` BIGINT UNSIGNED NOT NULL,
  `namespace_id` INTEGER UNSIGNED NOT NULL,
  `page_id` BIGINT UNSIGNED NOT NULL,
  `revision_id` BIGINT UNSIGNED NOT NULL,
  `local_path` VARCHAR(500) NOT NULL,
  `slug` VARCHAR(255) NOT NULL,
  `title` VARCHAR(255) NOT NULL,
  `display_title` VARCHAR(255) NOT NULL,
  `page_type` VARCHAR(32) NOT NULL,
  `protection_level` VARCHAR(32) NOT NULL,
  `page_status` VARCHAR(32) NOT NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `owner_profile_id` BIGINT UNSIGNED NULL,
  `page_updated_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_server_wiki_release_page` (`release_id`, `page_id`),
  UNIQUE INDEX `uq_server_wiki_release_path` (`release_id`, `local_path`),
  INDEX `idx_server_wiki_release_item_wiki` (`server_wiki_id`, `release_id`),
  INDEX `idx_server_wiki_release_item_space` (`space_id`, `release_id`),
  INDEX `idx_server_wiki_release_item_revision` (`revision_id`, `page_id`),
  CONSTRAINT `server_wiki_release_items_release_id_fkey`
    FOREIGN KEY (`release_id`) REFERENCES `server_wiki_releases` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `server_wiki_release_items_page_id_fkey`
    FOREIGN KEY (`page_id`) REFERENCES `pages` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `server_wiki_release_items_revision_id_page_id_fkey`
    FOREIGN KEY (`revision_id`, `page_id`) REFERENCES `page_revisions` (`id`, `page_id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `server_wikis`
  ADD COLUMN `published_release_id` BIGINT UNSIGNED NULL AFTER `publication_updated_by`,
  ADD UNIQUE INDEX `server_wikis_published_release_id_key` (`published_release_id`),
  ADD CONSTRAINT `server_wikis_published_release_id_fkey`
    FOREIGN KEY (`published_release_id`) REFERENCES `server_wiki_releases` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
