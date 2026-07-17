ALTER TABLE `MinecraftIdentity`
  ADD COLUMN `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  ADD COLUMN `isPrimary` BOOLEAN NOT NULL DEFAULT FALSE,
  ADD INDEX `MinecraftIdentity_accountId_isPrimary_idx` (`accountId`, `isPrimary`),
  DROP PRIMARY KEY,
  ADD PRIMARY KEY (`id`);

-- Before this migration every account could own at most one row, so every
-- existing identity is the primary identity for its account.
UPDATE `MinecraftIdentity` SET `isPrimary` = TRUE;
