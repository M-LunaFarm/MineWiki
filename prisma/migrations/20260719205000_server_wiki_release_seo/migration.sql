ALTER TABLE `server_wikis`
  ADD COLUMN `seo_title` VARCHAR(70) NULL AFTER `bottom_notice_source`,
  ADD COLUMN `seo_description` VARCHAR(200) NULL AFTER `seo_title`,
  ADD COLUMN `seo_indexing_enabled` BOOLEAN NOT NULL DEFAULT true AFTER `seo_description`;
