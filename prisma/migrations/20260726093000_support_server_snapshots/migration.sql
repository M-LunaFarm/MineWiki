ALTER TABLE `SupportTicket`
  ADD COLUMN `serverNameSnapshot` VARCHAR(191) NULL AFTER `serverId`,
  ADD COLUMN `serverJoinHostSnapshot` VARCHAR(191) NULL AFTER `serverNameSnapshot`,
  ADD COLUMN `serverJoinPortSnapshot` INTEGER NULL AFTER `serverJoinHostSnapshot`,
  ADD COLUMN `serverEditionSnapshot` ENUM('java', 'bedrock') NULL AFTER `serverJoinPortSnapshot`;

UPDATE `SupportTicket` t
INNER JOIN `Server` s ON s.id = t.serverId
SET
  t.serverNameSnapshot = s.name,
  t.serverJoinHostSnapshot = s.joinHost,
  t.serverJoinPortSnapshot = s.joinPort,
  t.serverEditionSnapshot = s.edition
WHERE t.serverId IS NOT NULL;
