ALTER TABLE `server_wikis`
  ADD COLUMN `navigation_order` JSON NULL,
  ADD COLUMN `navigation_version` INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `navigation_updated_at` DATETIME(3) NULL,
  ADD COLUMN `navigation_updated_by` BIGINT UNSIGNED NULL;
