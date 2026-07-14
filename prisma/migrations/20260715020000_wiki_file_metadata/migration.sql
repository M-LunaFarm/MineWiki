ALTER TABLE `uploaded_files`
  ADD COLUMN `license` VARCHAR(64) NULL AFTER `visibility`,
  ADD COLUMN `source_url` VARCHAR(1024) NULL AFTER `license`,
  ADD COLUMN `source_text` VARCHAR(255) NULL AFTER `source_url`;
