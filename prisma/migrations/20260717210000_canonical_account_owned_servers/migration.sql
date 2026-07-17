-- Account sessions resolve to the canonical account id. Keep server authority
-- records on that same id so linking an OAuth account cannot orphan management.
UPDATE `Server` AS server_row
INNER JOIN `Account` AS owner_account
  ON owner_account.`id` = server_row.`ownerAccountId`
SET server_row.`ownerAccountId` = COALESCE(owner_account.`canonicalAccountId`, owner_account.`id`)
WHERE server_row.`ownerAccountId` <> COALESCE(owner_account.`canonicalAccountId`, owner_account.`id`);

UPDATE `Server` AS server_row
INNER JOIN `Account` AS registrant_account
  ON registrant_account.`id` = server_row.`registrantAccountId`
SET server_row.`registrantAccountId` = COALESCE(registrant_account.`canonicalAccountId`, registrant_account.`id`)
WHERE server_row.`registrantAccountId` <> COALESCE(registrant_account.`canonicalAccountId`, registrant_account.`id`);

UPDATE `ServerClaimMethod` AS claim_method
INNER JOIN `Account` AS claim_account
  ON claim_account.`id` = claim_method.`accountId`
SET claim_method.`accountId` = COALESCE(claim_account.`canonicalAccountId`, claim_account.`id`)
WHERE claim_method.`accountId` <> COALESCE(claim_account.`canonicalAccountId`, claim_account.`id`);

-- A canonical account group may retain several Minecraft identities, but it
-- must expose exactly one primary identity. Prefer a primary already attached
-- to the canonical account, then any existing primary, then the oldest row.
CREATE TEMPORARY TABLE `_CanonicalMinecraftPrimary` (
  `canonical_account_id` VARCHAR(191) NOT NULL,
  `identity_id` BIGINT UNSIGNED NOT NULL,
  PRIMARY KEY (`canonical_account_id`),
  UNIQUE KEY `_CanonicalMinecraftPrimary_identity_id_key` (`identity_id`)
);

INSERT INTO `_CanonicalMinecraftPrimary` (`canonical_account_id`, `identity_id`)
SELECT ranked.`canonical_account_id`, ranked.`identity_id`
FROM (
  SELECT
    COALESCE(account_row.`canonicalAccountId`, account_row.`id`) AS `canonical_account_id`,
    identity_row.`id` AS `identity_id`,
    ROW_NUMBER() OVER (
      PARTITION BY COALESCE(account_row.`canonicalAccountId`, account_row.`id`)
      ORDER BY
        CASE
          WHEN identity_row.`isPrimary` = TRUE
            AND identity_row.`accountId` = COALESCE(account_row.`canonicalAccountId`, account_row.`id`) THEN 0
          WHEN identity_row.`isPrimary` = TRUE THEN 1
          WHEN identity_row.`accountId` = COALESCE(account_row.`canonicalAccountId`, account_row.`id`) THEN 2
          ELSE 3
        END,
        identity_row.`id` ASC
    ) AS `identity_rank`
  FROM `MinecraftIdentity` AS identity_row
  INNER JOIN `Account` AS account_row
    ON account_row.`id` = identity_row.`accountId`
) AS ranked
WHERE ranked.`identity_rank` = 1;

UPDATE `MinecraftIdentity` AS identity_row
INNER JOIN `Account` AS account_row
  ON account_row.`id` = identity_row.`accountId`
INNER JOIN `_CanonicalMinecraftPrimary` AS primary_row
  ON primary_row.`canonical_account_id` = COALESCE(account_row.`canonicalAccountId`, account_row.`id`)
SET identity_row.`isPrimary` = IF(identity_row.`id` = primary_row.`identity_id`, TRUE, FALSE)
WHERE identity_row.`isPrimary` <> IF(identity_row.`id` = primary_row.`identity_id`, TRUE, FALSE);

DROP TEMPORARY TABLE `_CanonicalMinecraftPrimary`;
