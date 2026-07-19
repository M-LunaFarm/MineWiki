ALTER TABLE `server_wiki_domains`
  ADD COLUMN `tls_ready_at` DATETIME(3) NULL AFTER `activated_at`,
  ADD COLUMN `next_check_at` DATETIME(3) NULL AFTER `last_checked_at`,
  ADD COLUMN `consecutive_failures` INT UNSIGNED NOT NULL DEFAULT 0 AFTER `next_check_at`,
  ADD INDEX `idx_server_wiki_domains_recheck` (`status`, `next_check_at`);
