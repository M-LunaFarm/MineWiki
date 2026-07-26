ALTER TABLE `SupportTicket`
  ADD COLUMN `firstResponseAt` DATETIME(3) NULL,
  ADD COLUMN `resolvedAt` DATETIME(3) NULL,
  ADD COLUMN `lastCustomerMessageAt` DATETIME(3) NULL,
  ADD COLUMN `lastAgentMessageAt` DATETIME(3) NULL;

UPDATE `SupportTicket` t
SET
  t.`firstResponseAt` = (
    SELECT MIN(m.`createdAt`)
    FROM `SupportMessage` m
    WHERE m.`ticketId` = t.`id`
      AND m.`authorRole` = 'agent'
      AND m.`isInternal` = FALSE
  ),
  t.`lastCustomerMessageAt` = (
    SELECT MAX(m.`createdAt`)
    FROM `SupportMessage` m
    WHERE m.`ticketId` = t.`id`
      AND m.`authorRole` = 'customer'
      AND m.`isInternal` = FALSE
  ),
  t.`lastAgentMessageAt` = (
    SELECT MAX(m.`createdAt`)
    FROM `SupportMessage` m
    WHERE m.`ticketId` = t.`id`
      AND m.`authorRole` = 'agent'
      AND m.`isInternal` = FALSE
  ),
  t.`resolvedAt` = CASE
    WHEN t.`status` IN ('resolved', 'closed') THEN t.`updatedAt`
    ELSE NULL
  END;

CREATE INDEX `SupportTicket_status_priority_firstResponseAt_idx`
  ON `SupportTicket` (`status`, `priority`, `firstResponseAt`);
