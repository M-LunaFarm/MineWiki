INSERT IGNORE INTO `permissions` (`id`, `code`, `description`)
VALUES (UUID(), 'wiki.batch_rollback', 'Preview and execute bounded wiki vandalism rollback');

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), role_row.id, permission_row.id
FROM `global_roles` role_row
JOIN `permissions` permission_row ON permission_row.code = 'wiki.batch_rollback'
WHERE role_row.code IN ('owner', 'admin');
