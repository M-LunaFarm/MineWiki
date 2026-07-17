ALTER TABLE `paddle_subscription_shadows`
  ADD UNIQUE INDEX `uq_paddle_subscription_environment_transaction` (`environment`, `provider_transaction_id`);
