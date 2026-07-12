CREATE TABLE `review_submission_gates` (
  `serverId` VARCHAR(191) NOT NULL,
  `authorAccountId` VARCHAR(191) NOT NULL,
  `lastSubmittedAt` DATETIME(3) NOT NULL,
  INDEX `review_submission_gates_lastSubmittedAt_idx` (`lastSubmittedAt`),
  PRIMARY KEY (`serverId`, `authorAccountId`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
