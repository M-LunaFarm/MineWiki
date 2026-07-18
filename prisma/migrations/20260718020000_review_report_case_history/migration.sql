DROP INDEX `ReviewReport_reviewId_accountId_key` ON `ReviewReport`;

CREATE INDEX `ReviewReport_reviewId_accountId_status_idx`
  ON `ReviewReport`(`reviewId`, `accountId`, `status`);
