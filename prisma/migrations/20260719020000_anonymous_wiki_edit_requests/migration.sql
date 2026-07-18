ALTER TABLE `wiki_edit_requests`
  MODIFY `created_by` BIGINT UNSIGNED NULL,
  ADD COLUMN `submitter_type` VARCHAR(16) NOT NULL DEFAULT 'user' AFTER `created_by`,
  ADD COLUMN `submitter_ip_hash` CHAR(64) NULL AFTER `submitter_type`,
  ADD INDEX `idx_wiki_edit_requests_ip` (`submitter_ip_hash`, `status`, `created_at`),
  ADD CONSTRAINT `chk_wiki_edit_request_submitter`
    CHECK (
      (`submitter_type` = 'user' AND `created_by` IS NOT NULL AND `submitter_ip_hash` IS NULL)
      OR
      (`submitter_type` = 'ip' AND `created_by` IS NULL AND `submitter_ip_hash` IS NOT NULL)
    );
