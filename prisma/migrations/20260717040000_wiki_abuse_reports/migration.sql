CREATE TABLE `wiki_report_cases` (
  `id` CHAR(36) NOT NULL,
  `target_type` ENUM('page', 'revision', 'discussion', 'comment') NOT NULL,
  `target_id` BIGINT UNSIGNED NOT NULL,
  `page_id` BIGINT UNSIGNED NOT NULL,
  `status` ENUM('open', 'in_review', 'resolved', 'dismissed') NOT NULL DEFAULT 'open',
  `active_key` VARCHAR(191) NULL,
  `report_count` INT UNSIGNED NOT NULL DEFAULT 1,
  `evidence_snapshot` JSON NOT NULL,
  `assignee_profile_id` BIGINT UNSIGNED NULL,
  `assigned_at` DATETIME(3) NULL,
  `resolution` VARCHAR(1000) NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 1,
  `status_updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `resolved_at` DATETIME(3) NULL,
  `dismissed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uk_wiki_report_cases_active_key` (`active_key`),
  INDEX `idx_wiki_report_cases_queue` (`status`, `created_at`, `id`),
  INDEX `idx_wiki_report_cases_assignee_queue` (`assignee_profile_id`, `status`, `created_at`, `id`),
  INDEX `idx_wiki_report_cases_target_history` (`target_type`, `target_id`, `created_at`),
  INDEX `idx_wiki_report_cases_page` (`page_id`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `wiki_report_submissions` (
  `id` CHAR(36) NOT NULL,
  `case_id` CHAR(36) NOT NULL,
  `reporter_profile_id` BIGINT UNSIGNED NOT NULL,
  `reason` VARCHAR(1000) NOT NULL,
  `evidence_snapshot` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  UNIQUE INDEX `uk_wiki_report_submissions_reporter` (`case_id`, `reporter_profile_id`),
  INDEX `idx_wiki_report_submissions_reporter` (`reporter_profile_id`, `created_at`),
  INDEX `idx_wiki_report_submissions_case` (`case_id`, `created_at`, `id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `wiki_report_submissions_case_id_fkey`
    FOREIGN KEY (`case_id`) REFERENCES `wiki_report_cases`(`id`) ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `permissions` (`id`, `code`, `description`)
VALUES (UUID(), 'wiki.report.moderate', 'Moderate aggregated wiki abuse reports');

INSERT IGNORE INTO `role_permissions` (`id`, `role_id`, `permission_id`)
SELECT UUID(), role_row.id, permission_row.id
FROM `global_roles` AS role_row
JOIN `permissions` AS permission_row ON permission_row.code = 'wiki.report.moderate'
WHERE role_row.code IN ('owner', 'admin', 'wiki_admin', 'moderator');
