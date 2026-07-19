UPDATE `Server` AS `server`
JOIN (
  SELECT
    `serverId`,
    MIN(`accountId`) AS `accountId`
  FROM `ServerClaimMethod`
  WHERE `status` = 'verified'
    AND `accountId` IS NOT NULL
  GROUP BY `serverId`
  HAVING COUNT(DISTINCT `accountId`) = 1
) AS `verified_claim`
  ON `verified_claim`.`serverId` = `server`.`id`
SET
  `server`.`ownerAccountId` = `verified_claim`.`accountId`,
  `server`.`registrantAccountId` = NULL,
  `server`.`registration_lease_expires_at` = NULL,
  `server`.`listingStatus` = CASE
    WHEN `server`.`listingStatus` = 'pending' THEN 'active'
    ELSE `server`.`listingStatus`
  END
WHERE `server`.`ownerAccountId` IS NULL
  AND (
    `server`.`registrantAccountId` IS NULL
    OR `server`.`registrantAccountId` = `verified_claim`.`accountId`
  );
