ALTER TABLE `server_wikis`
  ADD COLUMN `contribution_policy_source` TEXT NULL,
  ADD COLUMN `edit_help_source` TEXT NULL,
  ADD COLUMN `top_notice_source` TEXT NULL,
  ADD COLUMN `bottom_notice_source` TEXT NULL,
  ADD COLUMN `require_contribution_policy_ack` BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN `contribution_policy_version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `content_settings_version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `content_settings_updated_at` DATETIME(3) NULL,
  ADD COLUMN `content_settings_updated_by` BIGINT UNSIGNED NULL;

ALTER TABLE `wiki_edit_requests`
  ADD COLUMN `contribution_policy_version` INTEGER NULL;
