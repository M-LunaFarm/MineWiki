ALTER TABLE `Account`
  ADD COLUMN `suspended_at` DATETIME(3) NULL AFTER `anonymized_at`,
  ADD COLUMN `suspended_by` VARCHAR(191) NULL AFTER `suspended_at`,
  ADD COLUMN `suspension_reason` VARCHAR(1000) NULL AFTER `suspended_by`,
  ADD INDEX `Account_lifecycle_status_suspended_at_idx` (`lifecycle_status`, `suspended_at`);

INSERT IGNORE INTO `permissions` (`id`, `code`, `description`)
VALUES (UUID(), 'admin.account.suspend', 'Emergency suspend and restore canonical account groups');

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), role_row.id, permission_row.id
FROM `global_roles` role_row
JOIN `permissions` permission_row ON permission_row.code = 'admin.account.suspend'
WHERE role_row.code IN ('owner', 'admin');
