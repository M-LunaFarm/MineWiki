ALTER TABLE `wiki_push_deliveries`
  ADD INDEX `idx_wiki_push_deliveries_retention` (`status`, `created_at`, `id`);

ALTER TABLE `wiki_notification_events`
  ADD INDEX `idx_wiki_notification_events_retention` (`status`, `created_at`, `id`);
