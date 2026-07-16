-- Keep the original edit summary immutable while allowing moderators to redact
-- only its public presentation. The version column provides an optimistic
-- concurrency guard; moderator metadata remains nullable for pre-migration rows.
ALTER TABLE `page_revisions`
  ADD COLUMN `edit_summary_hidden` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN `edit_summary_moderation_version` INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `edit_summary_moderated_by` BIGINT UNSIGNED NULL,
  ADD COLUMN `edit_summary_moderated_at` DATETIME(3) NULL,
  ADD COLUMN `edit_summary_moderation_reason` VARCHAR(500) NULL;
