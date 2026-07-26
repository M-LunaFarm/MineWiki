ALTER TABLE `SupportTicket`
  ADD COLUMN `guestName` VARCHAR(64) NULL,
  ADD COLUMN `guestEmail` VARCHAR(120) NULL,
  ADD COLUMN `guestAccessHash` CHAR(64) NULL,
  ADD COLUMN `guestAccessExpiresAt` DATETIME(3) NULL,
  ADD INDEX `SupportTicket_guestAccessExpiresAt_idx` (`guestAccessExpiresAt`);
