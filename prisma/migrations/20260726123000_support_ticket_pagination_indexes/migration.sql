CREATE INDEX `SupportTicket_requesterAccountId_lastMessageAt_id_idx`
  ON `SupportTicket` (`requesterAccountId`, `lastMessageAt`, `id`);

CREATE INDEX `SupportTicket_assigneeAccountId_lastMessageAt_id_idx`
  ON `SupportTicket` (`assigneeAccountId`, `lastMessageAt`, `id`);

CREATE INDEX `SupportTicket_lastMessageAt_id_idx`
  ON `SupportTicket` (`lastMessageAt`, `id`);
