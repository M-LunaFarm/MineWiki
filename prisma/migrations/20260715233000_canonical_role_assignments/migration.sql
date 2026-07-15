-- A linked identity must never carry authority independently from its canonical account.
-- Copy every legacy assignment to the canonical account first, then remove alias copies.
INSERT IGNORE INTO `account_roles` (`id`, `account_id`, `role_id`, `created_at`)
SELECT
  UUID(),
  canonical_account.`id`,
  assignment.`role_id`,
  assignment.`created_at`
FROM `account_roles` AS assignment
INNER JOIN `Account` AS assigned_account
  ON assigned_account.`id` = assignment.`account_id`
INNER JOIN `Account` AS canonical_account
  ON canonical_account.`id` = COALESCE(assigned_account.`canonicalAccountId`, assigned_account.`id`)
WHERE assignment.`account_id` <> canonical_account.`id`;

DELETE assignment
FROM `account_roles` AS assignment
INNER JOIN `Account` AS assigned_account
  ON assigned_account.`id` = assignment.`account_id`
WHERE assigned_account.`canonicalAccountId` IS NOT NULL
  AND assignment.`account_id` <> assigned_account.`canonicalAccountId`;
