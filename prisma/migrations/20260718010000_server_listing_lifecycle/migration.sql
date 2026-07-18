ALTER TABLE `Server`
  ADD COLUMN `listingStatus` ENUM('pending', 'active', 'suspended') NOT NULL DEFAULT 'pending';

-- Servers visible before this migration are explicitly grandfathered as
-- legacy-approved listings. New registrations retain the pending default.
UPDATE `Server`
SET `listingStatus` = 'active';

CREATE INDEX `Server_listingStatus_idx` ON `Server`(`listingStatus`);
