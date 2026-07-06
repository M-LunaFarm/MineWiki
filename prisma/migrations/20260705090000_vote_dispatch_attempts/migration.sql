CREATE TABLE `vote_dispatch_attempts` (
  `id` CHAR(36) NOT NULL,
  `vote_id` VARCHAR(191) NOT NULL,
  `server_id` VARCHAR(191) NOT NULL,
  `target_id` VARCHAR(191) NULL,
  `protocol` ENUM('v1', 'v2') NOT NULL,
  `status` VARCHAR(32) NOT NULL DEFAULT 'queued',
  `attempts` INT NOT NULL DEFAULT 0,
  `error` VARCHAR(512) NULL,
  `last_attempt_at` DATETIME(3) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),

  PRIMARY KEY (`id`),
  INDEX `vote_dispatch_attempts_vote_id_idx` (`vote_id`),
  INDEX `vote_dispatch_attempts_server_id_created_at_idx` (`server_id`, `created_at`),
  INDEX `vote_dispatch_attempts_server_id_status_created_at_idx` (`server_id`, `status`, `created_at`),
  INDEX `vote_dispatch_attempts_target_id_idx` (`target_id`),
  CONSTRAINT `vote_dispatch_attempts_vote_id_fkey`
    FOREIGN KEY (`vote_id`) REFERENCES `Vote` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `vote_dispatch_attempts_server_id_fkey`
    FOREIGN KEY (`server_id`) REFERENCES `Server` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `vote_dispatch_attempts_target_id_fkey`
    FOREIGN KEY (`target_id`) REFERENCES `VotifierTarget` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
