CREATE TABLE `wiki_file_versions` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `file_page_id` BIGINT UNSIGNED NOT NULL,
  `page_revision_id` BIGINT UNSIGNED NOT NULL,
  `uploaded_file_id` CHAR(36) NOT NULL,
  `version_no` INT UNSIGNED NOT NULL,
  `is_current` BOOLEAN NOT NULL DEFAULT FALSE,
  `created_by_account_id` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `wiki_file_versions_page_revision_id_key` (`page_revision_id`),
  UNIQUE INDEX `wiki_file_versions_uploaded_file_id_key` (`uploaded_file_id`),
  UNIQUE INDEX `wiki_file_versions_file_page_id_version_no_key` (`file_page_id`, `version_no`),
  INDEX `wiki_file_versions_file_page_id_is_current_idx` (`file_page_id`, `is_current`),
  CONSTRAINT `wiki_file_versions_uploaded_file_id_fkey`
    FOREIGN KEY (`uploaded_file_id`) REFERENCES `uploaded_files` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `wiki_file_versions_file_page_id_fkey`
    FOREIGN KEY (`file_page_id`) REFERENCES `pages` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `wiki_file_versions_page_revision_id_fkey`
    FOREIGN KEY (`page_revision_id`) REFERENCES `page_revisions` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `wiki_file_versions` (
  `file_page_id`, `page_revision_id`, `uploaded_file_id`, `version_no`, `is_current`, `created_by_account_id`, `created_at`
)
SELECT
  p.`id`, p.`current_revision_id`, f.`id`, 1, TRUE, f.`owner_account_id`, f.`created_at`
FROM `uploaded_files` f
INNER JOIN `namespaces` n ON n.`code` = 'file'
INNER JOIN `pages` p
  ON p.`namespace_id` = n.`id`
 AND p.`title` = f.`wiki_filename`
WHERE f.`usage_context` = 'wiki_editor'
  AND f.`wiki_filename` IS NOT NULL
  AND p.`current_revision_id` IS NOT NULL;
