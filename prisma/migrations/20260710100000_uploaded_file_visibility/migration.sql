SET @visibility_column_exists = (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'uploaded_files'
    AND column_name = 'visibility'
);
SET @visibility_column_sql = IF(
  @visibility_column_exists = 0,
  'ALTER TABLE `uploaded_files` ADD COLUMN `visibility` VARCHAR(32) NOT NULL DEFAULT ''public''',
  'SELECT 1'
);
PREPARE visibility_column_statement FROM @visibility_column_sql;
EXECUTE visibility_column_statement;
DEALLOCATE PREPARE visibility_column_statement;

SET @linked_resource_type_column_exists = (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'uploaded_files'
    AND column_name = 'linked_resource_type'
);
SET @linked_resource_type_column_sql = IF(
  @linked_resource_type_column_exists = 0,
  'ALTER TABLE `uploaded_files` ADD COLUMN `linked_resource_type` VARCHAR(64) NULL',
  'SELECT 1'
);
PREPARE linked_resource_type_column_statement FROM @linked_resource_type_column_sql;
EXECUTE linked_resource_type_column_statement;
DEALLOCATE PREPARE linked_resource_type_column_statement;

SET @linked_resource_id_column_exists = (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'uploaded_files'
    AND column_name = 'linked_resource_id'
);
SET @linked_resource_id_column_sql = IF(
  @linked_resource_id_column_exists = 0,
  'ALTER TABLE `uploaded_files` ADD COLUMN `linked_resource_id` VARCHAR(128) NULL',
  'SELECT 1'
);
PREPARE linked_resource_id_column_statement FROM @linked_resource_id_column_sql;
EXECUTE linked_resource_id_column_statement;
DEALLOCATE PREPARE linked_resource_id_column_statement;

SET @visibility_index_exists = (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'uploaded_files'
    AND index_name = 'uploaded_files_visibility_idx'
);
SET @visibility_index_sql = IF(
  @visibility_index_exists = 0,
  'CREATE INDEX `uploaded_files_visibility_idx` ON `uploaded_files`(`visibility`)',
  'SELECT 1'
);
PREPARE visibility_index_statement FROM @visibility_index_sql;
EXECUTE visibility_index_statement;
DEALLOCATE PREPARE visibility_index_statement;

SET @linked_resource_index_exists = (
  SELECT COUNT(*)
  FROM information_schema.statistics
  WHERE table_schema = DATABASE()
    AND table_name = 'uploaded_files'
    AND index_name = 'uploaded_files_linked_resource_type_linked_resource_id_idx'
);
SET @linked_resource_index_sql = IF(
  @linked_resource_index_exists = 0,
  'CREATE INDEX `uploaded_files_linked_resource_type_linked_resource_id_idx` ON `uploaded_files`(`linked_resource_type`, `linked_resource_id`)',
  'SELECT 1'
);
PREPARE linked_resource_index_statement FROM @linked_resource_index_sql;
EXECUTE linked_resource_index_statement;
DEALLOCATE PREPARE linked_resource_index_statement;
