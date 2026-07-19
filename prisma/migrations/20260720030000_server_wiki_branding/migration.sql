ALTER TABLE `server_wikis`
  ADD COLUMN `brand_name` VARCHAR(80) NULL AFTER `seo_indexing_enabled`,
  ADD COLUMN `brand_logo_url` VARCHAR(512) NULL AFTER `brand_name`,
  ADD COLUMN `brand_favicon_url` VARCHAR(512) NULL AFTER `brand_logo_url`,
  ADD COLUMN `brand_accent_color` CHAR(7) NULL AFTER `brand_favicon_url`;
