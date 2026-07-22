ALTER TABLE `server_wiki_release_candidates`
  ADD COLUMN `snapshot_version` INT UNSIGNED NOT NULL DEFAULT 1 AFTER `release_snapshot`;

ALTER TABLE `server_wiki_releases`
  ADD COLUMN `snapshot_version` INT UNSIGNED NOT NULL DEFAULT 1 AFTER `candidate_id`;

ALTER TABLE `server_wiki_release_items`
  ADD COLUMN `public_read_allowed` BOOLEAN NOT NULL DEFAULT FALSE AFTER `search_vector`;

CREATE TABLE `server_wiki_release_includes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `release_id` BIGINT UNSIGNED NOT NULL,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `space_id` BIGINT UNSIGNED NOT NULL,
  `source_page_id` BIGINT UNSIGNED NOT NULL,
  `source_revision_id` BIGINT UNSIGNED NOT NULL,
  `target_namespace_id` INT UNSIGNED NOT NULL,
  `target_namespace_code` VARCHAR(32) NOT NULL,
  `target_slug` VARCHAR(255) NOT NULL,
  `target_page_id` BIGINT UNSIGNED NOT NULL,
  `target_space_id` BIGINT UNSIGNED NOT NULL,
  `target_revision_id` BIGINT UNSIGNED NOT NULL,
  `target_local_path` VARCHAR(500) NOT NULL,
  `target_title` VARCHAR(255) NOT NULL,
  `target_protection_level` VARCHAR(32) NOT NULL,
  `target_page_status` VARCHAR(32) NOT NULL,
  `target_created_by` BIGINT UNSIGNED NULL,
  `target_owner_profile_id` BIGINT UNSIGNED NULL,
  `content_hash` CHAR(64) NOT NULL,
  `content_size` INT UNSIGNED NOT NULL,
  `public_read_allowed` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_server_wiki_release_include` (`release_id`, `source_page_id`, `target_namespace_code`, `target_slug`),
  INDEX `idx_server_wiki_release_include_source` (`release_id`, `source_page_id`),
  INDEX `idx_server_wiki_release_include_target` (`target_page_id`, `target_revision_id`),
  CONSTRAINT `server_wiki_release_includes_release_id_fkey`
    FOREIGN KEY (`release_id`) REFERENCES `server_wiki_releases` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `server_wiki_release_assets` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `release_id` BIGINT UNSIGNED NOT NULL,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `space_id` BIGINT UNSIGNED NOT NULL,
  `wiki_filename` VARCHAR(255) NOT NULL,
  `uploaded_file_id` CHAR(36) NOT NULL,
  `wiki_file_version_id` BIGINT UNSIGNED NULL,
  `sha256` CHAR(64) NOT NULL,
  `public_path` VARCHAR(1024) NOT NULL,
  `mime_type` VARCHAR(128) NOT NULL,
  `original_name` VARCHAR(255) NOT NULL,
  `size_bytes` INT UNSIGNED NOT NULL,
  `width` INT UNSIGNED NULL,
  `height` INT UNSIGNED NULL,
  `license` VARCHAR(64) NULL,
  `source_url` VARCHAR(1024) NULL,
  `source_text` VARCHAR(255) NULL,
  `public_read_allowed` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_server_wiki_release_asset` (`release_id`, `wiki_filename`),
  INDEX `idx_server_wiki_release_asset_file` (`uploaded_file_id`),
  INDEX `idx_server_wiki_release_asset_version` (`wiki_file_version_id`),
  CONSTRAINT `server_wiki_release_assets_release_id_fkey`
    FOREIGN KEY (`release_id`) REFERENCES `server_wiki_releases` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `server_wiki_release_assets_uploaded_file_id_fkey`
    FOREIGN KEY (`uploaded_file_id`) REFERENCES `uploaded_files` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `server_wiki_release_assets_wiki_file_version_id_fkey`
    FOREIGN KEY (`wiki_file_version_id`) REFERENCES `wiki_file_versions` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

UPDATE `server_wiki_release_candidates`
SET `status` = 'superseded'
WHERE `snapshot_version` = 1 AND `status` = 'pending_review';
