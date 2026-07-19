ALTER TABLE `server_wikis`
  ADD UNIQUE INDEX `uq_server_wiki_tenant` (`id`, `space_id`);

CREATE TABLE `server_wiki_domains` (
  `id` BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  `server_wiki_id` BIGINT UNSIGNED NOT NULL,
  `space_id` BIGINT UNSIGNED NOT NULL,
  `hostname` VARCHAR(253) NOT NULL,
  `status` VARCHAR(16) NOT NULL DEFAULT 'pending',
  `verification_token_hash` CHAR(64) NOT NULL,
  `verification_expires_at` DATETIME(3) NOT NULL,
  `version` INT UNSIGNED NOT NULL DEFAULT 0,
  `verified_at` DATETIME(3) NULL,
  `activated_at` DATETIME(3) NULL,
  `disabled_at` DATETIME(3) NULL,
  `last_checked_at` DATETIME(3) NULL,
  `created_by` VARCHAR(191) NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `server_wiki_domains_server_wiki_id_key` (`server_wiki_id`),
  UNIQUE INDEX `server_wiki_domains_hostname_key` (`hostname`),
  UNIQUE INDEX `uq_server_wiki_domain_tenant` (`server_wiki_id`, `space_id`),
  INDEX `idx_server_wiki_domains_route` (`status`, `hostname`),
  INDEX `idx_server_wiki_domains_tenant` (`space_id`, `status`),
  INDEX `idx_server_wiki_domains_verification_expiry` (`verification_expires_at`),
  CONSTRAINT `server_wiki_domains_tenant_fkey`
    FOREIGN KEY (`server_wiki_id`, `space_id`)
    REFERENCES `server_wikis` (`id`, `space_id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
