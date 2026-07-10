SET @completion_token_column_exists = (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'DiscordVerificationSession'
    AND column_name = 'completion_token_hash'
);
SET @completion_token_column_sql = IF(
  @completion_token_column_exists = 0,
  'ALTER TABLE `DiscordVerificationSession` ADD COLUMN `completion_token_hash` CHAR(64) NULL',
  'SELECT 1'
);
PREPARE completion_token_column_statement FROM @completion_token_column_sql;
EXECUTE completion_token_column_statement;
DEALLOCATE PREPARE completion_token_column_statement;
