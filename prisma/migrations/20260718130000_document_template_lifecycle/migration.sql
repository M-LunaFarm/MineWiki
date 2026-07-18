ALTER TABLE `document_templates`
  ADD COLUMN `updated_by` BIGINT UNSIGNED NULL AFTER `created_by`,
  ADD COLUMN `version` INT UNSIGNED NOT NULL DEFAULT 1 AFTER `status`;
