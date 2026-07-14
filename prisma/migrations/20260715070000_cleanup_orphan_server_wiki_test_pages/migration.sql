-- Remove server-wiki starter pages leaked by the API integration fixture before
-- its cleanup covered every page in the generated space. The predicate is
-- intentionally limited to orphaned, creator-less, three-page Wiki Link
-- fixtures that contain the reserved example.com test host.
CREATE TEMPORARY TABLE `_minewiki_orphan_server_test_pages` (
  `id` BIGINT UNSIGNED NOT NULL PRIMARY KEY
) ENGINE=MEMORY;

INSERT INTO `_minewiki_orphan_server_test_pages` (`id`)
SELECT p.`id`
FROM `pages` p
JOIN `namespaces` n ON n.`id` = p.`namespace_id`
LEFT JOIN `wiki_spaces` s ON s.`id` = p.`space_id`
LEFT JOIN `users` u ON u.`id` = p.`created_by`
WHERE s.`id` IS NULL
  AND u.`id` IS NULL
  AND n.`code` = 'server'
  AND p.`local_path` REGEXP '^[a-z0-9]+-[a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9][a-f0-9]/(시작하기|규칙|FAQ)$'
  AND (
    SELECT COUNT(*)
    FROM `pages` grouped_page
    WHERE grouped_page.`space_id` = p.`space_id`
  ) = 3
  AND EXISTS (
    SELECT 1
    FROM `pages` fixture_page
    JOIN `page_revisions` fixture_revision
      ON fixture_revision.`id` = fixture_page.`current_revision_id`
    WHERE fixture_page.`space_id` = p.`space_id`
      AND fixture_revision.`content_raw` LIKE '== Wiki Link %'
      AND fixture_revision.`content_raw` LIKE '%.example.com%'
  );

DELETE link_row
FROM `page_links` link_row
JOIN `_minewiki_orphan_server_test_pages` orphan_page
  ON orphan_page.`id` = link_row.`source_page_id`;

DELETE cache_row
FROM `page_render_cache` cache_row
JOIN `_minewiki_orphan_server_test_pages` orphan_page
  ON orphan_page.`id` = cache_row.`page_id`;

DELETE change_row
FROM `recent_changes` change_row
JOIN `_minewiki_orphan_server_test_pages` orphan_page
  ON orphan_page.`id` = change_row.`page_id`;

DELETE revision_row
FROM `page_revisions` revision_row
JOIN `_minewiki_orphan_server_test_pages` orphan_page
  ON orphan_page.`id` = revision_row.`page_id`;

DELETE page_row
FROM `pages` page_row
JOIN `_minewiki_orphan_server_test_pages` orphan_page
  ON orphan_page.`id` = page_row.`id`;

DROP TEMPORARY TABLE `_minewiki_orphan_server_test_pages`;
