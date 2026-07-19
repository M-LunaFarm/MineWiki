CREATE TABLE `server_ownership_transfers` (
  `id` CHAR(36) NOT NULL,
  `server_id` VARCHAR(191) NOT NULL,
  `source_owner_account_id` VARCHAR(191) NOT NULL,
  `source_owner_profile_id` BIGINT UNSIGNED NOT NULL,
  `target_account_id` VARCHAR(191) NOT NULL,
  `target_profile_id` BIGINT UNSIGNED NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `active_server_key` VARCHAR(64) NULL,
  `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` DATETIME(3) NOT NULL,
  `responded_at` DATETIME(3) NULL,
  `cancelled_at` DATETIME(3) NULL,
  `cancelled_by_profile_id` BIGINT UNSIGNED NULL,
  `cancel_reason` VARCHAR(500) NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_server_ownership_transfer_active` (`active_server_key`),
  INDEX `idx_server_ownership_transfer_target` (`target_account_id`, `status`, `expires_at`),
  INDEX `idx_server_ownership_transfer_server` (`server_id`, `status`, `requested_at`),
  INDEX `idx_server_ownership_transfer_expiry` (`expires_at`, `status`),
  CONSTRAINT `chk_server_ownership_transfer_status`
    CHECK (`status` IN ('pending', 'accepted', 'declined', 'cancelled', 'expired', 'superseded')),
  CONSTRAINT `chk_server_ownership_transfer_accounts`
    CHECK (`source_owner_account_id` <> `target_account_id`),
  CONSTRAINT `server_ownership_transfers_server_fkey`
    FOREIGN KEY (`server_id`) REFERENCES `Server` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
