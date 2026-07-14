CREATE TABLE `wiki_discussion_polls` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `comment_id` BIGINT UNSIGNED NOT NULL,
  `question` VARCHAR(255) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'open',
  `results_visibility` VARCHAR(16) NOT NULL DEFAULT 'after_vote',
  `created_by` BIGINT UNSIGNED NOT NULL,
  `closes_at` DATETIME(3) NULL,
  `closed_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `wiki_discussion_polls_comment_id_key` (`comment_id`),
  INDEX `idx_wiki_discussion_polls_status_closes` (`status`, `closes_at`),
  INDEX `idx_wiki_discussion_polls_creator` (`created_by`, `created_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `wiki_discussion_poll_options` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `poll_id` BIGINT UNSIGNED NOT NULL,
  `position` INTEGER NOT NULL,
  `label` VARCHAR(120) NOT NULL,
  UNIQUE INDEX `uk_wiki_discussion_poll_options_position` (`poll_id`, `position`),
  INDEX `idx_wiki_discussion_poll_options_poll` (`poll_id`, `id`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `wiki_discussion_poll_votes` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `poll_id` BIGINT UNSIGNED NOT NULL,
  `option_id` BIGINT UNSIGNED NOT NULL,
  `profile_id` BIGINT UNSIGNED NOT NULL,
  `created_at` DATETIME(3) NOT NULL,
  `updated_at` DATETIME(3) NOT NULL,
  UNIQUE INDEX `uk_wiki_discussion_poll_votes_voter` (`poll_id`, `profile_id`),
  INDEX `idx_wiki_discussion_poll_votes_option` (`poll_id`, `option_id`),
  INDEX `idx_wiki_discussion_poll_votes_profile` (`profile_id`, `updated_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
