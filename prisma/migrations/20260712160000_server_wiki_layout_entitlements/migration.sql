ALTER TABLE `server_wikis`
  ADD COLUMN `layout_key` VARCHAR(32) NOT NULL DEFAULT 'docs',
  ADD COLUMN `layout_updated_at` DATETIME(3) NULL,
  ADD COLUMN `layout_updated_by` BIGINT UNSIGNED NULL;

CREATE TABLE `server_wiki_layout_entitlements` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `layout_key` VARCHAR(32) NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'active',
  `source` VARCHAR(32) NOT NULL DEFAULT 'manual',
  `external_reference` VARCHAR(191) NULL,
  `starts_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` DATETIME(3) NULL,
  `created_by` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `server_wiki_layout_entitlements_external_reference_key` (`external_reference`),
  INDEX `idx_server_wiki_layout_entitlement` (`server_wiki_id`, `layout_key`, `status`),
  INDEX `idx_server_wiki_layout_expiry` (`expires_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
