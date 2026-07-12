ALTER TABLE `ServerReview`
  ADD COLUMN `evidenceMinecraftUuid` VARCHAR(191) NULL,
  ADD COLUMN `evidenceVoteId` VARCHAR(191) NULL,
  ADD COLUMN `evidenceVerifiedAt` DATETIME(3) NULL,
  ADD COLUMN `evidencePolicyVersion` VARCHAR(32) NULL;

CREATE INDEX `ServerReview_evidenceMinecraftUuid_idx`
  ON `ServerReview`(`evidenceMinecraftUuid`);
