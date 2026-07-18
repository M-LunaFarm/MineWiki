ALTER TABLE `uploaded_files`
  ADD COLUMN `deleted_at` DATETIME(3) NULL AFTER `status`,
  ADD COLUMN `retained_until` DATETIME(3) NULL AFTER `deleted_at`,
  ADD INDEX `uploaded_files_status_retained_until_idx` (`status`, `retained_until`);
