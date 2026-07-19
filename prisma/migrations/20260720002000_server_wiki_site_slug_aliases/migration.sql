CREATE TABLE `server_wiki_site_slug_aliases` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `slug` VARCHAR(63) NOT NULL,
  `created_by` CHAR(36) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),

  UNIQUE INDEX `server_wiki_site_slug_aliases_slug_key`(`slug`),
  INDEX `idx_server_wiki_site_slug_aliases_wiki`(`server_wiki_id`, `created_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `server_wiki_site_slug_aliases_server_wiki_id_fkey`
    FOREIGN KEY (`server_wiki_id`) REFERENCES `server_wikis`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
