CREATE TABLE `webauthn_credentials` (
  `id` CHAR(36) NOT NULL,
  `account_id` VARCHAR(191) NOT NULL,
  `credential_id` VARCHAR(512) NOT NULL,
  `name` VARCHAR(64) NOT NULL,
  `public_key` BLOB NOT NULL,
  `counter` BIGINT UNSIGNED NOT NULL DEFAULT 0,
  `counter_version` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `transports` JSON NULL,
  `device_type` VARCHAR(32) NOT NULL,
  `backed_up` BOOLEAN NOT NULL DEFAULT false,
  `last_used_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `webauthn_credentials_credential_id_key` (`credential_id`),
  UNIQUE INDEX `webauthn_credentials_account_id_name_key` (`account_id`, `name`),
  INDEX `webauthn_credentials_account_id_created_at_idx` (`account_id`, `created_at`),
  CONSTRAINT `webauthn_credentials_account_id_fkey`
    FOREIGN KEY (`account_id`) REFERENCES `Account` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `webauthn_challenges` (
  `id` CHAR(36) NOT NULL,
  `account_id` VARCHAR(191) NOT NULL,
  `session_id` VARCHAR(191) NOT NULL,
  `session_token_version` INTEGER UNSIGNED NOT NULL,
  `operation` VARCHAR(32) NOT NULL,
  `purpose` VARCHAR(64) NULL,
  `challenge` VARCHAR(255) NOT NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `consumed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  UNIQUE INDEX `webauthn_challenges_challenge_key` (`challenge`),
  INDEX `webauthn_challenge_lookup_idx`
    (`account_id`, `session_id`, `operation`, `purpose`, `consumed_at`),
  INDEX `webauthn_challenges_expires_at_idx` (`expires_at`),
  CONSTRAINT `webauthn_challenges_account_id_fkey`
    FOREIGN KEY (`account_id`) REFERENCES `Account` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `webauthn_challenges_session_id_fkey`
    FOREIGN KEY (`session_id`) REFERENCES `Session` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `webauthn_challenges_operation_purpose_chk` CHECK (
    (`operation` = 'registration' AND `purpose` IS NULL)
    OR
    (`operation` = 'step_up' AND `purpose` IS NOT NULL)
  )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
