INSERT IGNORE INTO `global_roles` (`id`, `code`, `display_name`, `description`)
VALUES (UUID(), 'vote_moderator', 'Vote Moderator', 'Vote integrity moderator');

INSERT IGNORE INTO `permissions` (`id`, `code`, `description`)
VALUES (UUID(), 'vote.admin', 'Invalidate abusive votes and manage vote integrity');

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), r.id, p.id
FROM `global_roles` r
JOIN `permissions` p ON p.code = 'vote.admin'
WHERE r.code IN ('owner', 'admin', 'vote_moderator');
