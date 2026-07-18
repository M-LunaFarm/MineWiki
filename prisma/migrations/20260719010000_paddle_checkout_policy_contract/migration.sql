ALTER TABLE `paddle_checkout_intents`
  ADD COLUMN `policy_version` VARCHAR(64) NOT NULL AFTER `configured_price_id`,
  ADD COLUMN `terms_accepted_at` DATETIME(3) NOT NULL AFTER `policy_version`,
  ADD COLUMN `product_snapshot` JSON NOT NULL AFTER `terms_accepted_at`;
