ALTER TABLE `vote_cooldown_claims`
  ADD COLUMN `serverId` VARCHAR(191) NULL AFTER `identityKey`;

UPDATE `vote_cooldown_claims` AS claim
INNER JOIN `Vote` AS vote ON vote.`id` = claim.`voteId`
SET claim.`serverId` = vote.`serverId`;

DELETE FROM `vote_cooldown_claims`
WHERE `serverId` IS NULL;

ALTER TABLE `vote_cooldown_claims`
  MODIFY COLUMN `serverId` VARCHAR(191) NOT NULL,
  DROP PRIMARY KEY,
  DROP INDEX `vote_cooldown_claims_kstDay_idx`,
  ADD PRIMARY KEY (`identityType`, `identityKey`, `serverId`, `kstDay`),
  ADD INDEX `vote_cooldown_claims_serverId_kstDay_idx` (`serverId`, `kstDay`);
