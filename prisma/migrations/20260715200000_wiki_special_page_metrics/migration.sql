ALTER TABLE `pages`
  ADD COLUMN `current_content_size` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN `current_category_count` INTEGER UNSIGNED NOT NULL DEFAULT 0;

UPDATE `pages` AS `p`
LEFT JOIN `page_revisions` AS `r`
  ON `r`.`id` = `p`.`current_revision_id`
SET
  `p`.`current_content_size` = COALESCE(`r`.`content_size`, 0),
  `p`.`current_category_count` = (
    SELECT COUNT(*)
    FROM `page_links` AS `l`
    WHERE `l`.`source_page_id` = `p`.`id`
      AND `l`.`source_revision_id` = `p`.`current_revision_id`
      AND `l`.`link_type` = 'category'
  );

CREATE INDEX `idx_pages_special_old`
  ON `pages` (`status`, `page_type`, `namespace_id`, `updated_at`, `id`);
CREATE INDEX `idx_pages_special_size`
  ON `pages` (`status`, `page_type`, `namespace_id`, `current_content_size`, `id`);
CREATE INDEX `idx_pages_special_category`
  ON `pages` (`status`, `page_type`, `namespace_id`, `current_category_count`, `updated_at`, `id`);
