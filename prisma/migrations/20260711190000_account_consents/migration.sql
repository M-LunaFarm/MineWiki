CREATE TABLE `account_consents` (
  `id` VARCHAR(191) NOT NULL,
  `account_id` VARCHAR(191) NOT NULL,
  `consent_type` VARCHAR(32) NOT NULL,
  `policy_version` VARCHAR(32) NOT NULL,
  `consented_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `ip_address` VARCHAR(45) NULL,
  `user_agent` VARCHAR(512) NULL,

  UNIQUE INDEX `account_consents_account_id_consent_type_policy_version_key`(`account_id`, `consent_type`, `policy_version`),
  INDEX `account_consents_consent_type_policy_version_idx`(`consent_type`, `policy_version`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `account_consents`
  ADD CONSTRAINT `account_consents_account_id_fkey`
  FOREIGN KEY (`account_id`) REFERENCES `Account`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;
