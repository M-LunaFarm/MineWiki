CREATE TABLE IF NOT EXISTS `global_roles` (
  `id` VARCHAR(191) NOT NULL,
  `code` VARCHAR(64) NOT NULL,
  `display_name` VARCHAR(128) NOT NULL,
  `description` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `global_roles_code_key` (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `permissions` (
  `id` VARCHAR(191) NOT NULL,
  `code` VARCHAR(128) NOT NULL,
  `description` VARCHAR(255) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `permissions_code_key` (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `account_roles` (
  `id` VARCHAR(191) NOT NULL,
  `account_id` VARCHAR(191) NOT NULL,
  `role_id` VARCHAR(191) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `account_roles_account_id_role_id_key` (`account_id`, `role_id`),
  KEY `account_roles_role_id_idx` (`role_id`),
  CONSTRAINT `account_roles_account_id_fkey`
    FOREIGN KEY (`account_id`) REFERENCES `Account` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `account_roles_role_id_fkey`
    FOREIGN KEY (`role_id`) REFERENCES `global_roles` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS `role_permissions` (
  `id` VARCHAR(191) NOT NULL,
  `role_id` VARCHAR(191) NOT NULL,
  `permission_id` VARCHAR(191) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `role_permissions_role_id_permission_id_key` (`role_id`, `permission_id`),
  KEY `role_permissions_permission_id_idx` (`permission_id`),
  CONSTRAINT `role_permissions_role_id_fkey`
    FOREIGN KEY (`role_id`) REFERENCES `global_roles` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `role_permissions_permission_id_fkey`
    FOREIGN KEY (`permission_id`) REFERENCES `permissions` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `global_roles` (`id`, `code`, `display_name`, `description`) VALUES
  (UUID(), 'owner', 'Owner', 'Full site owner'),
  (UUID(), 'admin', 'Admin', 'Full site administrator'),
  (UUID(), 'moderator', 'Moderator', 'Moderation staff'),
  (UUID(), 'wiki_admin', 'Wiki Admin', 'Wiki administrator'),
  (UUID(), 'server_admin', 'Server Admin', 'Server administrator'),
  (UUID(), 'support_agent', 'Support Agent', 'Support staff');

INSERT IGNORE INTO `permissions` (`id`, `code`, `description`) VALUES
  (UUID(), 'wiki.read.restricted', 'Read restricted wiki resources'),
  (UUID(), 'wiki.edit.locked', 'Edit locked wiki pages'),
  (UUID(), 'wiki.admin', 'Manage wiki administration'),
  (UUID(), 'server.admin', 'Manage server administration'),
  (UUID(), 'guild.admin', 'Manage Discord guild administration'),
  (UUID(), 'support.admin', 'Manage support tickets'),
  (UUID(), 'file.admin', 'Manage uploaded files');

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), r.id, p.id
FROM `global_roles` r
JOIN `permissions` p
WHERE r.code = 'owner';

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), r.id, p.id
FROM `global_roles` r
JOIN `permissions` p
WHERE r.code = 'admin';

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), r.id, p.id
FROM `global_roles` r
JOIN `permissions` p ON p.code IN ('wiki.admin', 'wiki.edit.locked', 'wiki.read.restricted')
WHERE r.code = 'wiki_admin';

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), r.id, p.id
FROM `global_roles` r
JOIN `permissions` p ON p.code = 'server.admin'
WHERE r.code = 'server_admin';

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), r.id, p.id
FROM `global_roles` r
JOIN `permissions` p ON p.code = 'support.admin'
WHERE r.code = 'support_agent';

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), r.id, p.id
FROM `global_roles` r
JOIN `permissions` p ON p.code IN ('wiki.edit.locked', 'wiki.read.restricted')
WHERE r.code = 'moderator';
