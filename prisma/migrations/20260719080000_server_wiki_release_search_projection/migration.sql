ALTER TABLE `server_wiki_release_items`
  ADD COLUMN `search_vector` LONGTEXT NOT NULL,
  ADD FULLTEXT INDEX `idx_server_wiki_release_items_search` (`search_vector`);
