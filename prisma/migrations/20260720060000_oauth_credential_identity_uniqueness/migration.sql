-- Keep only the newest token snapshot for each external OAuth identity.
DELETE older
FROM `oauth_credentials` older
JOIN `oauth_credentials` newer
  ON newer.`provider` = older.`provider`
 AND newer.`providerUserId` = older.`providerUserId`
 AND (
   newer.`updatedAt` > older.`updatedAt`
   OR (newer.`updatedAt` = older.`updatedAt` AND newer.`id` > older.`id`)
 );

-- Credentials belong to the canonical account after account linking.
UPDATE `oauth_credentials` credential
JOIN `Account` account ON account.`id` = credential.`accountId`
SET credential.`accountId` = COALESCE(account.`canonicalAccountId`, account.`id`)
WHERE credential.`accountId` <> COALESCE(account.`canonicalAccountId`, account.`id`);

ALTER TABLE `oauth_credentials`
  DROP INDEX `oauth_credentials_provider_providerUserId_idx`,
  ADD UNIQUE INDEX `oauth_credentials_provider_providerUserId_key` (`provider`, `providerUserId`);
