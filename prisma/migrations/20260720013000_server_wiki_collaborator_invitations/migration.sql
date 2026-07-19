CREATE TABLE `server_wiki_collaborator_invitations` (
  `id` CHAR(36) NOT NULL,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `space_id` BIGINT UNSIGNED NOT NULL,
  `target_profile_id` BIGINT UNSIGNED NOT NULL,
  `target_account_id` CHAR(36) NOT NULL,
  `role` VARCHAR(32) NOT NULL,
  `reason` VARCHAR(500) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `active_key` VARCHAR(96) NULL,
  `invited_by_profile_id` BIGINT UNSIGNED NOT NULL,
  `invited_by_account_id` CHAR(36) NOT NULL,
  `issuer_authority` VARCHAR(16) NOT NULL,
  `issued_under_owner_id` CHAR(36) NULL,
  `invited_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `expires_at` DATETIME(3) NOT NULL,
  `responded_at` DATETIME(3) NULL,
  `cancelled_by_profile_id` BIGINT UNSIGNED NULL,
  `cancel_reason` VARCHAR(500) NULL,
  `resent_at` DATETIME(3) NULL,
  `resend_count` INT UNSIGNED NOT NULL DEFAULT 0,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `server_wiki_collaborator_invitations_active_key_key` (`active_key`),
  INDEX `idx_server_wiki_invites_target` (`target_account_id`, `status`, `expires_at`),
  INDEX `idx_server_wiki_invites_wiki` (`server_wiki_id`, `status`, `invited_at`),
  INDEX `idx_server_wiki_invites_expiry` (`expires_at`, `status`),
  CONSTRAINT `chk_server_wiki_invites_role` CHECK (`role` IN ('manager', 'editor', 'reviewer')),
  CONSTRAINT `chk_server_wiki_invites_status` CHECK (`status` IN ('pending', 'accepted', 'declined', 'cancelled', 'expired')),
  CONSTRAINT `chk_server_wiki_invites_issuer` CHECK (`issuer_authority` IN ('owner', 'server_admin')),
  CONSTRAINT `server_wiki_collaborator_invitations_tenant_fkey`
    FOREIGN KEY (`server_wiki_id`, `space_id`)
    REFERENCES `server_wikis` (`id`, `space_id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
