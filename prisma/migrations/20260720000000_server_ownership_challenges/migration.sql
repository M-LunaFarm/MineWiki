ALTER TABLE `Server`
  ADD COLUMN `ownership_verification_failures` INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN `ownership_challenge_started_at` DATETIME(3) NULL,
  ADD COLUMN `ownership_challenge_expires_at` DATETIME(3) NULL,
  ADD COLUMN `ownership_challenge_suspended_at` DATETIME(3) NULL,
  ADD COLUMN `ownership_last_failure_at` DATETIME(3) NULL;

CREATE INDEX `Server_ownership_challenge_expires_at_idx`
  ON `Server`(`ownership_challenge_expires_at`);
