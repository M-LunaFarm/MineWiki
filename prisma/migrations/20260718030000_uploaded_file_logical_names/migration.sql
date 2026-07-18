ALTER TABLE `uploaded_files`
  ADD COLUMN `wiki_filename` VARCHAR(255) NULL AFTER `filename`;

UPDATE `uploaded_files`
SET `wiki_filename` = `filename`
WHERE `usage_context` = 'wiki_editor';

CREATE UNIQUE INDEX `uk_uploaded_files_wiki_filename`
  ON `uploaded_files`(`wiki_filename`);
