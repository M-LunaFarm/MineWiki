ALTER TABLE `Session`
  ADD COLUMN `primary_authenticated_at` DATETIME(3) NULL,
  ADD COLUMN `step_up_at` DATETIME(3) NULL,
  ADD COLUMN `step_up_expires_at` DATETIME(3) NULL,
  ADD COLUMN `step_up_method` VARCHAR(32) NULL,
  ADD COLUMN `step_up_purpose` VARCHAR(64) NULL;

-- Existing sessions predate trustworthy primary-auth and step-up timestamps.
-- Requiring a fresh login is safer than treating a token rotation as authentication.
DELETE FROM `Session`;

ALTER TABLE `Session`
  MODIFY COLUMN `primary_authenticated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  ADD INDEX `Session_step_up_expires_at_idx` (`step_up_expires_at`),
  ADD CONSTRAINT `Session_step_up_consistency_chk` CHECK (
    (`step_up_at` IS NULL AND `step_up_expires_at` IS NULL AND `step_up_method` IS NULL AND `step_up_purpose` IS NULL)
    OR
    (`step_up_at` IS NOT NULL AND `step_up_expires_at` IS NOT NULL AND `step_up_method` IS NOT NULL AND `step_up_purpose` IS NOT NULL AND `step_up_expires_at` > `step_up_at`)
  ),
  ADD CONSTRAINT `Session_step_up_method_chk` CHECK (
    `step_up_method` IS NULL OR `step_up_method` IN ('totp', 'recovery_code', 'webauthn')
  );

CREATE TABLE `mfa_totp_credentials` (
  `id` CHAR(36) NOT NULL,
  `account_id` VARCHAR(191) NOT NULL,
  `secret_ciphertext` TEXT NOT NULL,
  `pending_expires_at` DATETIME(3) NULL,
  `enabled_at` DATETIME(3) NULL,
  `last_used_step` BIGINT UNSIGNED NULL,
  `failed_attempts` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `locked_until` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `mfa_totp_credentials_account_id_key` (`account_id`),
  CONSTRAINT `mfa_totp_credentials_account_id_fkey`
    FOREIGN KEY (`account_id`) REFERENCES `Account` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `mfa_recovery_codes` (
  `id` CHAR(36) NOT NULL,
  `account_id` VARCHAR(191) NOT NULL,
  `code_hash` CHAR(64) NOT NULL,
  `used_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `mfa_recovery_codes_account_id_code_hash_key` (`account_id`, `code_hash`),
  INDEX `mfa_recovery_codes_account_id_used_at_idx` (`account_id`, `used_at`),
  CONSTRAINT `mfa_recovery_codes_account_id_fkey`
    FOREIGN KEY (`account_id`) REFERENCES `Account` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
