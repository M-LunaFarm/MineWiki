INSERT IGNORE INTO `permissions` (`id`, `code`, `description`)
VALUES (UUID(), 'admin.audit.read', 'Read global security and operations audit events');

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), role_row.id, permission_row.id
FROM `global_roles` role_row
JOIN `permissions` permission_row ON permission_row.code = 'admin.audit.read'
WHERE role_row.code IN ('owner', 'admin');
