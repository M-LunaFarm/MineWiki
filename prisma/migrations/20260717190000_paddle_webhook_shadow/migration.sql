CREATE TABLE `paddle_webhook_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `provider_event_id` VARCHAR(64) NOT NULL,
  `environment` VARCHAR(16) NOT NULL,
  `event_type` VARCHAR(64) NOT NULL,
  `occurred_at` DATETIME(3) NOT NULL,
  `status` VARCHAR(24) NOT NULL DEFAULT 'received',
  `payload` JSON NOT NULL,
  `attempts` INT UNSIGNED NOT NULL DEFAULT 1,
  `last_error` TEXT NULL,
  `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `processed_at` DATETIME(3) NULL,
  UNIQUE INDEX `uq_paddle_webhook_environment_event` (`environment`, `provider_event_id`),
  INDEX `idx_paddle_webhook_status_received` (`status`, `received_at`),
  INDEX `idx_paddle_webhook_type_occurred` (`event_type`, `occurred_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `paddle_subscription_shadows` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `environment` VARCHAR(16) NOT NULL,
  `provider_subscription_id` VARCHAR(64) NOT NULL,
  `provider_customer_id` VARCHAR(64) NULL,
  `status` VARCHAR(32) NOT NULL,
  `next_billed_at` DATETIME(3) NULL,
  `current_period_starts_at` DATETIME(3) NULL,
  `current_period_ends_at` DATETIME(3) NULL,
  `scheduled_change` JSON NULL,
  `last_event_id` VARCHAR(64) NOT NULL,
  `last_event_occurred_at` DATETIME(3) NOT NULL,
  `last_payload` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `uq_paddle_subscription_environment_id` (`environment`, `provider_subscription_id`),
  INDEX `idx_paddle_subscription_status_updated` (`status`, `updated_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
