INSERT IGNORE INTO `permissions` (`id`, `code`, `description`)
VALUES (UUID(), 'admin.account.merge', 'Review and execute verified canonical account merges');

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), role_row.id, permission_row.id
FROM `global_roles` role_row
JOIN `permissions` permission_row ON permission_row.code = 'admin.account.merge'
WHERE role_row.code IN ('owner', 'admin');
