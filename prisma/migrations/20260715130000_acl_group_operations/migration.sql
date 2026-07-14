ALTER TABLE `acl_groups`
  ADD COLUMN `self_removable` BOOLEAN NOT NULL DEFAULT false AFTER `status`;

ALTER TABLE `acl_group_members`
  ADD COLUMN `ip_version` TINYINT UNSIGNED NULL AFTER `ip`,
  ADD INDEX `idx_acl_group_members_ip` (`group_id`, `ip_version`, `removed_at`);

UPDATE `acl_group_members`
SET `ip_version` = CASE
  WHEN LENGTH(`ip`) = 4 THEN 4
  WHEN LENGTH(`ip`) = 16 THEN 6
  ELSE NULL
END
WHERE `member_type` IN ('ip', 'cidr');

INSERT IGNORE INTO `permissions` (`id`, `code`, `description`)
VALUES (UUID(), 'wiki.acl.manage', 'Manage wiki ACL groups and memberships');

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), role_row.id, permission_row.id
FROM `global_roles` role_row
JOIN `permissions` permission_row ON permission_row.code = 'wiki.acl.manage'
WHERE role_row.code IN ('owner', 'admin', 'wiki_admin');
