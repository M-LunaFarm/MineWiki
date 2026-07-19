ALTER TABLE `pages`
  ADD COLUMN `visibility_auto_hidden` BOOLEAN NOT NULL DEFAULT FALSE AFTER `status`;

UPDATE `pages`
SET `visibility_auto_hidden` = TRUE
WHERE `status` = 'hidden'
  AND `current_revision_id` IS NULL;
