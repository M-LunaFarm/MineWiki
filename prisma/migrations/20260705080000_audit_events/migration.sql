CREATE TABLE `audit_events` (
  `id` CHAR(36) NOT NULL,
  `category` VARCHAR(64) NOT NULL,
  `action` VARCHAR(128) NOT NULL,
  `severity` VARCHAR(16) NOT NULL DEFAULT 'info',
  `actor_account_id` VARCHAR(191) NULL,
  `actor_profile_id` BIGINT NULL,
  `subject_type` VARCHAR(64) NULL,
  `subject_id` VARCHAR(128) NULL,
  `request_id` VARCHAR(64) NULL,
  `ip_address` VARCHAR(64) NULL,
  `user_agent` VARCHAR(512) NULL,
  `metadata` JSON NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `audit_events_category_created_at_idx` (`category`, `created_at`),
  INDEX `audit_events_action_created_at_idx` (`action`, `created_at`),
  INDEX `audit_events_actor_account_id_created_at_idx` (`actor_account_id`, `created_at`),
  INDEX `audit_events_subject_type_subject_id_created_at_idx` (`subject_type`, `subject_id`, `created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
