CREATE TABLE `wiki_special_snapshots` (
  `type` VARCHAR(32) NOT NULL,
  `namespace_code` VARCHAR(32) NOT NULL DEFAULT '',
  `generation` CHAR(36) NOT NULL,
  `items` JSON NOT NULL,
  `source_page_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `source_link_count` INTEGER UNSIGNED NOT NULL DEFAULT 0,
  `generated_at` DATETIME(3) NOT NULL,

  PRIMARY KEY (`type`, `namespace_code`),
  INDEX `idx_wiki_special_snapshots_generated` (`generated_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
