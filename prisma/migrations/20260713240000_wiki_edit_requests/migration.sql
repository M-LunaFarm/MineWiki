CREATE TABLE `wiki_edit_requests` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `page_id` BIGINT UNSIGNED NOT NULL,
  `base_revision_id` BIGINT UNSIGNED NOT NULL,
  `proposed_content` MEDIUMTEXT NOT NULL,
  `edit_summary` VARCHAR(255) NOT NULL,
  `is_minor` BOOLEAN NOT NULL DEFAULT false,
  `status` VARCHAR(32) NOT NULL DEFAULT 'pending',
  `created_by` BIGINT UNSIGNED NOT NULL,
  `reviewed_by` BIGINT UNSIGNED NULL,
  `review_note` VARCHAR(1000) NULL,
  `accepted_revision_id` BIGINT UNSIGNED NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  `reviewed_at` DATETIME(3) NULL,

  INDEX `idx_wiki_edit_requests_page`(`page_id`, `status`, `created_at`),
  INDEX `idx_wiki_edit_requests_creator`(`created_by`, `status`, `created_at`),
  INDEX `idx_wiki_edit_requests_reviewer`(`reviewed_by`, `reviewed_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
