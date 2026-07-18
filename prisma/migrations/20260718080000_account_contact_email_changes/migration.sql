CREATE TABLE `account_email_changes` (
  `id` CHAR(36) NOT NULL,
  `canonical_account_id` CHAR(36) NOT NULL,
  `credential_account_id` CHAR(36) NULL,
  `previous_email` VARCHAR(254) NULL,
  `new_email` VARCHAR(254) NOT NULL,
  `token_hash` CHAR(64) NOT NULL,
  `group_fingerprint` CHAR(64) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `active_key` CHAR(36) NULL,
  `requested_by_session_id` CHAR(36) NOT NULL,
  `sent_at` DATETIME(3) NOT NULL,
  `resend_available_at` DATETIME(3) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `confirmed_at` DATETIME(3) NULL,
  `superseded_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `account_email_changes_token_hash_key` (`token_hash`),
  UNIQUE INDEX `account_email_changes_active_key_key` (`active_key`),
  INDEX `idx_account_email_changes_account` (`canonical_account_id`, `status`, `created_at`),
  INDEX `idx_account_email_changes_new_email` (`new_email`, `status`),
  INDEX `idx_account_email_changes_expiry` (`expires_at`),
  CONSTRAINT `fk_account_email_changes_canonical`
    FOREIGN KEY (`canonical_account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE,
  CONSTRAINT `fk_account_email_changes_credential`
    FOREIGN KEY (`credential_account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
