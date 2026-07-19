ALTER TABLE `paddle_checkout_intents`
  ADD COLUMN `open_lease_key` VARCHAR(96) NULL AFTER `status`,
  ADD COLUMN `provider_checkout_url` VARCHAR(2048) NULL AFTER `provider_transaction_id`;

-- Preserve one pre-migration pending checkout per billing subject as an open
-- lease. Legacy checkout URLs were not persisted, so a retry must stop instead
-- of risking a second provider transaction.
UPDATE `paddle_checkout_intents` AS `candidate`
SET `candidate`.`open_lease_key` = CONCAT(`candidate`.`environment`, ':', `candidate`.`billing_subject_id`)
WHERE `candidate`.`status` = 'pending'
  AND NOT EXISTS (
    SELECT 1
    FROM `paddle_checkout_intents` AS `newer`
    WHERE `newer`.`billing_subject_id` = `candidate`.`billing_subject_id`
      AND `newer`.`environment` = `candidate`.`environment`
      AND `newer`.`status` = 'pending'
      AND (
        `newer`.`created_at` > `candidate`.`created_at`
        OR (`newer`.`created_at` = `candidate`.`created_at` AND `newer`.`id` > `candidate`.`id`)
      )
  );

ALTER TABLE `paddle_checkout_intents`
  ADD UNIQUE INDEX `uq_paddle_checkout_open_lease` (`open_lease_key`),
  ALTER COLUMN `status` SET DEFAULT 'creating';
