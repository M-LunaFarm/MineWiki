ALTER TABLE `wiki_api_idempotency_records`
  ADD UNIQUE INDEX `wiki_api_idempotency_records_token_id_request_hash_route_key` (`token_id`, `request_hash`, `route`);
