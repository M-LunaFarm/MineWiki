CREATE TABLE `account_merge_requests` (
  `id` CHAR(36) NOT NULL,
  `ticket_id` CHAR(36) NOT NULL,
  `requester_account_id` CHAR(36) NOT NULL,
  `source_canonical_account_id` CHAR(36) NOT NULL,
  `target_canonical_account_id` CHAR(36) NULL,
  `candidate_target_account_ids` JSON NOT NULL,
  `conflict_snapshot` JSON NOT NULL,
  `conflict_fingerprint` CHAR(64) NOT NULL,
  `proof_summary` JSON NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `active_key` CHAR(36) NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `decided_by_account_id` CHAR(36) NULL,
  `decision_reason` VARCHAR(1000) NULL,
  `decided_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `account_merge_requests_ticket_id_key` (`ticket_id`),
  UNIQUE INDEX `account_merge_requests_active_key_key` (`active_key`),
  INDEX `idx_account_merge_requests_status` (`status`, `created_at`),
  INDEX `idx_account_merge_requests_source` (`source_canonical_account_id`, `status`),
  INDEX `idx_account_merge_requests_target` (`target_canonical_account_id`, `status`),
  INDEX `idx_account_merge_requests_decider` (`decided_by_account_id`, `decided_at`),
  CONSTRAINT `account_merge_requests_ticket_id_fkey`
    FOREIGN KEY (`ticket_id`) REFERENCES `SupportTicket` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
