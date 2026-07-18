ALTER TABLE `uploaded_files`
  DROP INDEX `uk_uploaded_files_wiki_filename`,
  ADD COLUMN `current_wiki_filename` VARCHAR(255) NULL AFTER `wiki_filename`,
  ADD UNIQUE INDEX `uk_uploaded_files_current_wiki_filename` (`current_wiki_filename`);

UPDATE `uploaded_files`
SET `current_wiki_filename` = `wiki_filename`
WHERE `wiki_filename` IS NOT NULL
  AND `status` IN ('active', 'delete_pending', 'retained');

ALTER TABLE `wiki_file_versions`
  DROP INDEX `wiki_file_versions_uploaded_file_id_key`,
  ADD INDEX `wiki_file_versions_uploaded_file_id_idx` (`uploaded_file_id`);
