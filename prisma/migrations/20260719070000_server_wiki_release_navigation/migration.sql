CREATE TABLE `server_wiki_release_navigation_nodes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `release_id` BIGINT UNSIGNED NOT NULL,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `node_key` VARCHAR(100) NOT NULL,
  `kind` VARCHAR(16) NOT NULL,
  `page_id` BIGINT UNSIGNED NULL,
  `parent_key` VARCHAR(100) NULL,
  `title` VARCHAR(255) NOT NULL,
  `position` INTEGER UNSIGNED NOT NULL,
  `depth` INTEGER UNSIGNED NOT NULL,
  `has_children` BOOLEAN NOT NULL DEFAULT false,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `uq_server_wiki_release_navigation_node` (`release_id`, `node_key`),
  UNIQUE INDEX `uq_server_wiki_release_navigation_position` (`release_id`, `position`),
  UNIQUE INDEX `uq_server_wiki_release_navigation_page` (`release_id`, `page_id`),
  INDEX `idx_server_wiki_release_navigation_wiki` (`server_wiki_id`, `release_id`),
  INDEX `idx_server_wiki_release_navigation_kind` (`release_id`, `kind`, `position`),
  CONSTRAINT `server_wiki_release_navigation_nodes_release_id_fkey`
    FOREIGN KEY (`release_id`) REFERENCES `server_wiki_releases` (`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
