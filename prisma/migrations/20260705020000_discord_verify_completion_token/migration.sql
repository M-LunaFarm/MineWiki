ALTER TABLE `DiscordVerificationSession`
  ADD COLUMN IF NOT EXISTS `completion_token_hash` CHAR(64) NULL;
