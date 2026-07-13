CREATE INDEX `idx_wiki_threads_recent`
  ON `wiki_discussion_threads` (`updated_at`, `id`);

CREATE INDEX `idx_wiki_threads_status_recent`
  ON `wiki_discussion_threads` (`status`, `updated_at`, `id`);
