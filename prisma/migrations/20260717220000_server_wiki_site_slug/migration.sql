ALTER TABLE `server_wikis`
  ADD COLUMN `site_slug` VARCHAR(80) NULL AFTER `slug`;

UPDATE `server_wikis`
SET `site_slug` = CASE
  WHEN CHAR_LENGTH(`slug`) <= 80 THEN `slug`
  ELSE CONCAT(LEFT(`slug`, 55), '-', `id`)
END
WHERE `site_slug` IS NULL;

CREATE UNIQUE INDEX `server_wikis_site_slug_key`
  ON `server_wikis`(`site_slug`);
