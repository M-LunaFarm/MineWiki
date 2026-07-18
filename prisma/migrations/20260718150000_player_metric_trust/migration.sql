ALTER TABLE `Server`
  ADD COLUMN `playersMetricTrust` ENUM('trusted', 'self_reported', 'anomalous', 'unknown') NOT NULL DEFAULT 'unknown' AFTER `playersLastUpdatedAt`,
  ADD COLUMN `playersMetricSource` ENUM('status_ping') NULL AFTER `playersMetricTrust`,
  ADD COLUMN `playersAnomalyReason` VARCHAR(64) NULL AFTER `playersMetricSource`,
  ADD INDEX `Server_playersMetricTrust_playersOnline_idx` (`playersMetricTrust`, `playersOnline`);

ALTER TABLE `ServerPingSample`
  ADD COLUMN `playersMetricTrust` ENUM('trusted', 'self_reported', 'anomalous', 'unknown') NOT NULL DEFAULT 'unknown' AFTER `maxPlayers`,
  ADD COLUMN `playersMetricSource` ENUM('status_ping') NULL AFTER `playersMetricTrust`,
  ADD COLUMN `playersAnomalyReason` VARCHAR(64) NULL AFTER `playersMetricSource`;

UPDATE `Server`
SET
  `playersMetricSource` = CASE WHEN `isOnline` = TRUE THEN 'status_ping' ELSE NULL END,
  `playersMetricTrust` = CASE
    WHEN `isOnline` IS NOT TRUE OR `playersOnline` IS NULL OR `playersMax` IS NULL THEN 'unknown'
    WHEN (`playersMax` = 0 AND `playersOnline` > 0)
      OR (`playersMax` > 0 AND `playersOnline` > `playersMax`)
      OR (`playersOnline` >= 1000 AND `playersOnline` = `playersMax`) THEN 'anomalous'
    WHEN `verificationGrade` = 'Unverified' THEN 'self_reported'
    ELSE 'trusted'
  END,
  `playersAnomalyReason` = CASE
    WHEN `playersMax` = 0 AND `playersOnline` > 0 THEN 'online_with_zero_capacity'
    WHEN `playersMax` > 0 AND `playersOnline` > `playersMax` THEN 'online_exceeds_max'
    WHEN `playersOnline` >= 1000 AND `playersOnline` = `playersMax` THEN 'saturated_large_capacity'
    ELSE NULL
  END;
