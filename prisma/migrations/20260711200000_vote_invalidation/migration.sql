ALTER TABLE `Vote`
  ADD COLUMN `status` VARCHAR(16) NOT NULL DEFAULT 'valid',
  ADD COLUMN `invalidated_at` DATETIME(3) NULL,
  ADD COLUMN `invalidated_by` VARCHAR(191) NULL,
  ADD COLUMN `invalidation_reason` VARCHAR(500) NULL;

CREATE INDEX `Vote_status_votedAt_idx` ON `Vote`(`status`, `votedAt`);
