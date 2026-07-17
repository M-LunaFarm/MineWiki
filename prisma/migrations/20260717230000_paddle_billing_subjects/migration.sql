CREATE TABLE `paddle_billing_subjects` (
  `id` CHAR(36) NOT NULL,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `created_by_account_id` VARCHAR(191) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `paddle_billing_subjects_server_wiki_id_key` (`server_wiki_id`),
  INDEX `idx_paddle_billing_subject_creator` (`created_by_account_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `paddle_billing_subjects_server_wiki_id_fkey`
    FOREIGN KEY (`server_wiki_id`) REFERENCES `server_wikis`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `paddle_checkout_intents` (
  `id` CHAR(36) NOT NULL,
  `billing_subject_id` CHAR(36) NOT NULL,
  `environment` VARCHAR(16) NOT NULL,
  `layout_key` VARCHAR(32) NOT NULL,
  `configured_price_id` VARCHAR(64) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'pending',
  `provider_transaction_id` VARCHAR(64) NULL,
  `expires_at` DATETIME(3) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `uq_paddle_checkout_environment_transaction` (`environment`, `provider_transaction_id`),
  INDEX `idx_paddle_checkout_subject_status` (`billing_subject_id`, `status`),
  INDEX `idx_paddle_checkout_status_expiry` (`status`, `expires_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `paddle_checkout_intents_billing_subject_id_fkey`
    FOREIGN KEY (`billing_subject_id`) REFERENCES `paddle_billing_subjects`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `paddle_subscription_shadows`
  ADD COLUMN `billing_subject_id` CHAR(36) NULL AFTER `id`,
  ADD COLUMN `provider_transaction_id` VARCHAR(64) NULL AFTER `provider_customer_id`,
  ADD COLUMN `projection_status` VARCHAR(24) NOT NULL DEFAULT 'unprojected' AFTER `last_payload`,
  ADD COLUMN `projection_error` TEXT NULL AFTER `projection_status`,
  ADD COLUMN `projected_at` DATETIME(3) NULL AFTER `projection_error`,
  ADD INDEX `idx_paddle_subscription_subject_status` (`billing_subject_id`, `status`),
  ADD INDEX `idx_paddle_subscription_projection` (`projection_status`, `updated_at`),
  ADD CONSTRAINT `paddle_subscription_shadows_billing_subject_id_fkey`
    FOREIGN KEY (`billing_subject_id`) REFERENCES `paddle_billing_subjects`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;
