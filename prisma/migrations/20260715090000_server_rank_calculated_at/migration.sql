ALTER TABLE `ServerStats`
  ADD COLUMN `rank_calculated_at` DATETIME(3) NULL,
  ADD INDEX `ServerStats_rank_calculated_at_idx` (`rank_calculated_at`);

UPDATE `ServerStats` AS stats
LEFT JOIN (
  SELECT snapshot.`serverId`, MAX(snapshot.`recordedAt`) AS calculated_at
  FROM `ServerRankSnapshot` AS snapshot
  GROUP BY snapshot.`serverId`
) AS latest ON latest.`serverId` = stats.`serverId`
SET stats.`rank_calculated_at` = latest.calculated_at;
