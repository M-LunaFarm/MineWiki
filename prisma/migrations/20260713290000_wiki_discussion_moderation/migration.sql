ALTER TABLE `wiki_discussion_threads`
  ADD COLUMN `pinned_comment_id` BIGINT UNSIGNED NULL AFTER `updated_at`;
