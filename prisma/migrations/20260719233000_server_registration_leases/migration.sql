ALTER TABLE `Server`
  ADD COLUMN `registration_lease_expires_at` DATETIME(3) NULL AFTER `registrantAccountId`,
  ADD INDEX `idx_server_registration_lease` (`listingStatus`, `registration_lease_expires_at`);

UPDATE `Server`
SET `registration_lease_expires_at` = DATE_ADD(`createdAt`, INTERVAL 24 HOUR)
WHERE `ownerAccountId` IS NULL
  AND `registrantAccountId` IS NOT NULL
  AND `listingStatus` = 'pending';
