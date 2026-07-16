ALTER TABLE `acl_groups`
  ADD COLUMN `scope_type` VARCHAR(16) NOT NULL DEFAULT 'site' AFTER `group_key`,
  ADD COLUMN `space_id` BIGINT UNSIGNED NULL AFTER `scope_type`,
  ADD INDEX `idx_acl_groups_scope` (`scope_type`, `space_id`, `status`),
  ADD CONSTRAINT `fk_acl_groups_space`
    FOREIGN KEY (`space_id`) REFERENCES `wiki_spaces` (`id`) ON DELETE RESTRICT,
  ADD CONSTRAINT `chk_acl_groups_scope`
    CHECK (
      (`scope_type` = 'site' AND `space_id` IS NULL)
      OR (`scope_type` = 'space' AND `space_id` IS NOT NULL)
    );
