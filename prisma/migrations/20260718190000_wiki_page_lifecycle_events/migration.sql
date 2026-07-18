CREATE TABLE `page_lifecycle_events` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `page_id` BIGINT UNSIGNED NOT NULL,
  `event_type` VARCHAR(16) NOT NULL,
  `actor_profile_id` BIGINT UNSIGNED NULL,
  `reason` VARCHAR(255) NULL,
  `source_namespace_id` INT UNSIGNED NULL,
  `source_namespace_code` VARCHAR(32) NULL,
  `source_space_id` BIGINT UNSIGNED NULL,
  `source_title` VARCHAR(255) NULL,
  `source_path` VARCHAR(500) NULL,
  `destination_namespace_id` INT UNSIGNED NULL,
  `destination_namespace_code` VARCHAR(32) NULL,
  `destination_space_id` BIGINT UNSIGNED NULL,
  `destination_title` VARCHAR(255) NULL,
  `destination_path` VARCHAR(500) NULL,
  `created_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`id`),
  INDEX `idx_page_lifecycle_page_id` (`page_id`, `id`),
  INDEX `idx_page_lifecycle_created` (`created_at`, `id`),
  CONSTRAINT `fk_page_lifecycle_page`
    FOREIGN KEY (`page_id`) REFERENCES `pages` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `fk_page_lifecycle_actor`
    FOREIGN KEY (`actor_profile_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `chk_page_lifecycle_event_type`
    CHECK (`event_type` IN ('move', 'delete', 'restore'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
