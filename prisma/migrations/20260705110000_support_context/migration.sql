ALTER TABLE `SupportTicket`
  ADD COLUMN `pageId` VARCHAR(64) NULL,
  ADD COLUMN `verifySessionId` VARCHAR(64) NULL,
  ADD COLUMN `pluginServerId` VARCHAR(64) NULL,
  ADD COLUMN `fileId` VARCHAR(64) NULL;

CREATE INDEX `SupportTicket_pageId_idx` ON `SupportTicket`(`pageId`);
CREATE INDEX `SupportTicket_verifySessionId_idx` ON `SupportTicket`(`verifySessionId`);
CREATE INDEX `SupportTicket_pluginServerId_idx` ON `SupportTicket`(`pluginServerId`);
CREATE INDEX `SupportTicket_fileId_idx` ON `SupportTicket`(`fileId`);
