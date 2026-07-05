CREATE TABLE IF NOT EXISTS `server_wiki_id_migration_rejections` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_id` CHAR(36) NOT NULL,
  `wiki_space_id_raw` VARCHAR(191) NULL,
  `wiki_page_id_raw` VARCHAR(191) NULL,
  `reason` VARCHAR(64) NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  KEY `server_wiki_id_migration_rejections_server_id_idx` (`server_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `server_wiki_id_migration_rejections` (`server_id`, `wiki_space_id_raw`, `wiki_page_id_raw`, `reason`)
SELECT `id`, `wikiSpaceId`, `wikiPageId`, 'non_numeric_wiki_ids'
FROM `Server`
WHERE (`wikiSpaceId` IS NOT NULL AND `wikiSpaceId` NOT REGEXP '^[0-9]+$')
   OR (`wikiPageId` IS NOT NULL AND `wikiPageId` NOT REGEXP '^[0-9]+$');

ALTER TABLE `Server`
  ADD COLUMN `wikiSpaceId_tmp` BIGINT UNSIGNED NULL,
  ADD COLUMN `wikiPageId_tmp` BIGINT UNSIGNED NULL;

UPDATE `Server`
SET
  `wikiSpaceId_tmp` = CASE
    WHEN `wikiSpaceId` REGEXP '^[0-9]+$' THEN CAST(`wikiSpaceId` AS UNSIGNED)
    ELSE NULL
  END,
  `wikiPageId_tmp` = CASE
    WHEN `wikiPageId` REGEXP '^[0-9]+$' THEN CAST(`wikiPageId` AS UNSIGNED)
    ELSE NULL
  END;

DROP INDEX `Server_wikiSpaceId_idx` ON `Server`;

ALTER TABLE `Server`
  DROP COLUMN `wikiSpaceId`,
  DROP COLUMN `wikiPageId`;

ALTER TABLE `Server`
  CHANGE COLUMN `wikiSpaceId_tmp` `wikiSpaceId` BIGINT UNSIGNED NULL,
  CHANGE COLUMN `wikiPageId_tmp` `wikiPageId` BIGINT UNSIGNED NULL;

CREATE INDEX `Server_wikiSpaceId_idx` ON `Server`(`wikiSpaceId`);
