CREATE TABLE `vote_cooldown_claims` (
  `identityType` VARCHAR(16) NOT NULL,
  `identityKey` VARCHAR(255) NOT NULL,
  `kstDay` DATE NOT NULL,
  `voteId` VARCHAR(191) NOT NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  INDEX `vote_cooldown_claims_voteId_idx` (`voteId`),
  INDEX `vote_cooldown_claims_kstDay_idx` (`kstDay`),
  PRIMARY KEY (`identityType`, `identityKey`, `kstDay`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `vote_cooldown_claims`
  (`identityType`, `identityKey`, `kstDay`, `voteId`, `createdAt`)
SELECT
  CASE
    WHEN `minecraftUuid` IS NOT NULL THEN 'minecraft'
    WHEN `accountId` IS NOT NULL THEN 'account'
    ELSE 'username'
  END,
  CASE
    WHEN `minecraftUuid` IS NOT NULL THEN CONCAT('uuid:', `minecraftUuid`)
    WHEN `accountId` IS NOT NULL THEN CONCAT('acct:', `accountId`)
    ELSE CONCAT('user:', `usernameNormalized`)
  END,
  DATE(DATE_ADD(`votedAt`, INTERVAL 9 HOUR)),
  `id`,
  `createdAt`
FROM `Vote`
WHERE `status` = 'valid'
ORDER BY `votedAt` ASC;

INSERT IGNORE INTO `vote_cooldown_claims`
  (`identityType`, `identityKey`, `kstDay`, `voteId`, `createdAt`)
SELECT
  'ip',
  `ipAddress`,
  DATE(DATE_ADD(`votedAt`, INTERVAL 9 HOUR)),
  `id`,
  `createdAt`
FROM `Vote`
WHERE `status` = 'valid' AND `ipAddress` IS NOT NULL
ORDER BY `votedAt` ASC;
