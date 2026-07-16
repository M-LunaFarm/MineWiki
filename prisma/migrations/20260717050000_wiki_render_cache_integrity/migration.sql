-- Render caches are derived and safe to discard. Remove historical fixture and
-- cross-page residue before enforcing the cache graph at the database boundary.
DELETE cache_row
FROM `page_render_cache` AS cache_row
LEFT JOIN `pages` AS page_row ON page_row.`id` = cache_row.`page_id`
LEFT JOIN `page_revisions` AS revision_row ON revision_row.`id` = cache_row.`revision_id`
WHERE page_row.`id` IS NULL
   OR revision_row.`id` IS NULL
   OR revision_row.`page_id` <> cache_row.`page_id`;

ALTER TABLE `page_revisions`
  ADD UNIQUE INDEX `uk_page_revisions_id_page` (`id`, `page_id`);

ALTER TABLE `page_render_cache`
  ADD INDEX `idx_render_cache_revision_page` (`revision_id`, `page_id`),
  ADD CONSTRAINT `fk_render_cache_page`
    FOREIGN KEY (`page_id`) REFERENCES `pages` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT `fk_render_cache_revision_page`
    FOREIGN KEY (`revision_id`, `page_id`)
    REFERENCES `page_revisions` (`id`, `page_id`)
    ON DELETE CASCADE ON UPDATE CASCADE;
