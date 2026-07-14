ALTER TABLE `Session`
  ADD COLUMN `terms_policy_version` VARCHAR(32) NULL,
  ADD COLUMN `privacy_policy_version` VARCHAR(32) NULL;

UPDATE `Session` AS session_record
JOIN `Account` AS session_account ON session_account.`id` = session_record.`accountId`
SET
  session_record.`terms_policy_version` = (
    SELECT consent.`policy_version`
    FROM `account_consents` AS consent
    JOIN `Account` AS member_account ON member_account.`id` = consent.`account_id`
    WHERE consent.`consent_type` = 'terms'
      AND (
        member_account.`id` = COALESCE(session_account.`canonicalAccountId`, session_account.`id`)
        OR member_account.`id` = session_account.`id`
        OR member_account.`canonicalAccountId` = COALESCE(session_account.`canonicalAccountId`, session_account.`id`)
      )
    ORDER BY consent.`consented_at` DESC, consent.`id` DESC
    LIMIT 1
  ),
  session_record.`privacy_policy_version` = (
    SELECT consent.`policy_version`
    FROM `account_consents` AS consent
    JOIN `Account` AS member_account ON member_account.`id` = consent.`account_id`
    WHERE consent.`consent_type` = 'privacy'
      AND (
        member_account.`id` = COALESCE(session_account.`canonicalAccountId`, session_account.`id`)
        OR member_account.`id` = session_account.`id`
        OR member_account.`canonicalAccountId` = COALESCE(session_account.`canonicalAccountId`, session_account.`id`)
      )
    ORDER BY consent.`consented_at` DESC, consent.`id` DESC
    LIMIT 1
  );

CREATE INDEX `Session_terms_policy_version_privacy_policy_version_idx`
  ON `Session`(`terms_policy_version`, `privacy_policy_version`);
