ALTER TABLE `Account`
  ADD COLUMN `canonicalAccountId` VARCHAR(191) NULL;

CREATE INDEX `Account_canonicalAccountId_idx`
  ON `Account`(`canonicalAccountId`);

-- Existing account components are pinned lazily on their next authenticated login.
-- New accounts and newly linked components are pinned immediately by the API.
