CREATE TABLE `wiki_search_documents` (
  `page_id` BIGINT UNSIGNED NOT NULL,
  `revision_id` BIGINT UNSIGNED NOT NULL,
  `search_vector` LONGTEXT NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`page_id`),
  UNIQUE INDEX `wiki_search_documents_revision_id_key` (`revision_id`),
  FULLTEXT INDEX `idx_wiki_search_documents_vector` (`search_vector`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
