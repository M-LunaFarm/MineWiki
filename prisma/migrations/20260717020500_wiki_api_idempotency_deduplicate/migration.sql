DELETE duplicate
FROM `wiki_api_idempotency_records` AS duplicate
INNER JOIN `wiki_api_idempotency_records` AS keeper
  ON duplicate.`token_id` = keeper.`token_id`
  AND duplicate.`request_hash` = keeper.`request_hash`
  AND duplicate.`route` = keeper.`route`
  AND (
    duplicate.`created_at` > keeper.`created_at`
    OR (duplicate.`created_at` = keeper.`created_at` AND duplicate.`id` > keeper.`id`)
  );
