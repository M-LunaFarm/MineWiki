ALTER TABLE `Server`
  ADD COLUMN `registrantAccountId` VARCHAR(191) NULL AFTER `ownerAccountId`,
  ADD INDEX `Server_registrantAccountId_idx` (`registrantAccountId`),
  ADD CONSTRAINT `Server_registrantAccountId_fkey`
    FOREIGN KEY (`registrantAccountId`) REFERENCES `Account`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
