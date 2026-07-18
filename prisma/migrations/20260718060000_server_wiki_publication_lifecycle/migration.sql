ALTER TABLE `server_wikis`
  ADD COLUMN `publication_status` VARCHAR(16) NOT NULL DEFAULT 'draft' AFTER `status`,
  ADD COLUMN `publication_version` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `publication_status`,
  ADD COLUMN `published_at` DATETIME(3) NULL AFTER `publication_version`,
  ADD COLUMN `unpublished_at` DATETIME(3) NULL AFTER `published_at`,
  ADD COLUMN `publication_updated_at` DATETIME(3) NULL AFTER `unpublished_at`,
  ADD COLUMN `publication_updated_by` BIGINT UNSIGNED NULL AFTER `publication_updated_at`;

-- Preserve the currently live surface during rollout. Lifecycle-archived rows stay non-public.
UPDATE `server_wikis`
SET
  `publication_status` = 'published',
  `published_at` = COALESCE(`updated_at`, `created_at`),
  `publication_updated_at` = COALESCE(`updated_at`, `created_at`)
WHERE `status` = 'active';

UPDATE `server_wikis`
SET
  `publication_status` = 'unpublished',
  `unpublished_at` = COALESCE(`updated_at`, `created_at`),
  `publication_updated_at` = COALESCE(`updated_at`, `created_at`)
WHERE `status` <> 'active';

CREATE INDEX `server_wikis_publication_status_idx`
  ON `server_wikis`(`publication_status`);
