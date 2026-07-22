ALTER TABLE `page_links`
  ADD COLUMN `category_label` VARCHAR(255) NULL AFTER `link_type`,
  ADD COLUMN `category_blurred` BOOLEAN NOT NULL DEFAULT FALSE AFTER `category_label`;

ALTER TABLE `server_wiki_release_links`
  ADD COLUMN `category_label` VARCHAR(255) NULL AFTER `link_type`,
  ADD COLUMN `category_blurred` BOOLEAN NOT NULL DEFAULT FALSE AFTER `category_label`;

UPDATE `server_wiki_release_candidates`
SET `status` = 'superseded'
WHERE `snapshot_version` < 3
  AND `status` = 'pending_review';
