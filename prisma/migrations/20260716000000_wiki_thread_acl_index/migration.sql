CREATE INDEX `idx_acl_thread_action_eval`
  ON `acl_rules` (`target_type`, `target_id`, `action`, `sort_order`, `id`);
