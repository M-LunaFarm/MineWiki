ALTER TABLE `wiki_search_documents`
  ADD CONSTRAINT `wiki_search_documents_page_id_fkey`
  FOREIGN KEY (`page_id`) REFERENCES `pages` (`id`)
  ON DELETE CASCADE ON UPDATE CASCADE;
