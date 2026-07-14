ALTER TABLE `ReviewReport`
  ADD COLUMN `reason` VARCHAR(500) NULL,
  ADD COLUMN `status` ENUM('open', 'in_review', 'resolved', 'dismissed') NOT NULL DEFAULT 'open',
  ADD COLUMN `assigneeAccountId` VARCHAR(191) NULL,
  ADD COLUMN `resolution` VARCHAR(1000) NULL,
  ADD COLUMN `assignedAt` DATETIME(3) NULL,
  ADD COLUMN `statusUpdatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD COLUMN `resolvedAt` DATETIME(3) NULL,
  ADD COLUMN `dismissedAt` DATETIME(3) NULL,
  ADD COLUMN `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3);

UPDATE `ReviewReport`
SET `reason` = '기존 신고 데이터 이관'
WHERE `reason` IS NULL;

UPDATE `ServerReview` AS review
LEFT JOIN (
  SELECT report.`reviewId`, COUNT(*) AS report_count
  FROM `ReviewReport` AS report
  GROUP BY report.`reviewId`
) AS counted ON counted.`reviewId` = review.`id`
SET review.`reports` = COALESCE(counted.report_count, 0)
WHERE review.`reports` <> COALESCE(counted.report_count, 0);

ALTER TABLE `ReviewReport`
  MODIFY COLUMN `reason` VARCHAR(500) NOT NULL,
  ADD CONSTRAINT `ReviewReport_assigneeAccountId_fkey`
    FOREIGN KEY (`assigneeAccountId`) REFERENCES `Account`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

CREATE INDEX `ReviewReport_status_createdAt_idx`
  ON `ReviewReport`(`status`, `createdAt`);
CREATE INDEX `ReviewReport_assigneeAccountId_status_idx`
  ON `ReviewReport`(`assigneeAccountId`, `status`);
CREATE INDEX `ReviewReport_reviewId_status_idx`
  ON `ReviewReport`(`reviewId`, `status`);
