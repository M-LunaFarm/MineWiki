ALTER TABLE `paddle_webhook_events`
  ADD COLUMN `provider_subscription_id` VARCHAR(64) NULL AFTER `provider_event_id`,
  ADD COLUMN `occurred_at_raw` VARCHAR(64) NULL AFTER `occurred_at`,
  ADD COLUMN `available_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) AFTER `attempts`,
  ADD COLUMN `locked_at` DATETIME(3) NULL AFTER `available_at`,
  ADD COLUMN `locked_by` VARCHAR(64) NULL AFTER `locked_at`,
  ADD COLUMN `dead_lettered_at` DATETIME(3) NULL AFTER `processed_at`,
  MODIFY COLUMN `attempts` INT UNSIGNED NOT NULL DEFAULT 0;

UPDATE `paddle_webhook_events`
SET `occurred_at_raw` = DATE_FORMAT(`occurred_at`, '%Y-%m-%dT%H:%i:%s.%fZ')
WHERE `occurred_at_raw` IS NULL;

ALTER TABLE `paddle_webhook_events`
  MODIFY COLUMN `occurred_at_raw` VARCHAR(64) NOT NULL,
  DROP INDEX `idx_paddle_webhook_status_received`,
  ADD INDEX `idx_paddle_webhook_status_available` (`status`, `available_at`),
  ADD INDEX `idx_paddle_webhook_subscription_order` (`environment`, `provider_subscription_id`, `occurred_at`, `id`);

ALTER TABLE `paddle_subscription_shadows`
  ADD COLUMN `last_event_occurred_at_raw` VARCHAR(64) NULL AFTER `last_event_occurred_at`;

UPDATE `paddle_subscription_shadows`
SET `last_event_occurred_at_raw` = DATE_FORMAT(`last_event_occurred_at`, '%Y-%m-%dT%H:%i:%s.%fZ')
WHERE `last_event_occurred_at_raw` IS NULL;
