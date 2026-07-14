ALTER TABLE `Account`
  ADD COLUMN `lifecycle_status` VARCHAR(32) NOT NULL DEFAULT 'active' AFTER `lastLoginAt`,
  ADD COLUMN `deletion_requested_at` DATETIME(3) NULL AFTER `lifecycle_status`,
  ADD COLUMN `anonymized_at` DATETIME(3) NULL AFTER `deletion_requested_at`,
  ADD INDEX `Account_lifecycle_status_deletion_requested_at_idx` (`lifecycle_status`, `deletion_requested_at`);

CREATE TABLE `account_deletion_requests` (
  `id` CHAR(36) NOT NULL,
  `canonical_account_id` CHAR(36) NOT NULL,
  `account_ids` JSON NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'requested',
  `reauth_method` VARCHAR(32) NOT NULL,
  `cancel_token_hash` CHAR(64) NOT NULL,
  `blocker_snapshot` JSON NULL,
  `requested_by` CHAR(36) NOT NULL,
  `requested_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `scheduled_for` DATETIME(3) NOT NULL,
  `cancelled_at` DATETIME(3) NULL,
  `cancelled_by` VARCHAR(64) NULL,
  `processed_at` DATETIME(3) NULL,
  `processed_by` CHAR(36) NULL,
  `admin_note` VARCHAR(1000) NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `account_deletion_requests_canonical_account_id_key` (`canonical_account_id`),
  UNIQUE INDEX `account_deletion_requests_cancel_token_hash_key` (`cancel_token_hash`),
  INDEX `account_deletion_requests_status_scheduled_for_idx` (`status`, `scheduled_for`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `guilds`
  ADD COLUMN `owner_account_id` CHAR(36) NULL AFTER `guild_id`,
  ADD INDEX `guilds_owner_account_id_idx` (`owner_account_id`);

INSERT IGNORE INTO `permissions` (`id`, `code`, `description`)
VALUES (UUID(), 'admin.account.delete', 'Process account termination lifecycle requests');

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), role_row.id, permission_row.id
FROM `global_roles` role_row
JOIN `permissions` permission_row ON permission_row.code = 'admin.account.delete'
WHERE role_row.code IN ('owner', 'admin');
