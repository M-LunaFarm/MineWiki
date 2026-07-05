ALTER TABLE `users`
  ADD COLUMN `account_id` CHAR(36) NULL;

CREATE UNIQUE INDEX `users_account_id_key` ON `users`(`account_id`);

ALTER TABLE `server_wikis`
  ADD COLUMN `vote_server_id` CHAR(36) NULL;

CREATE UNIQUE INDEX `server_wikis_vote_server_id_key` ON `server_wikis`(`vote_server_id`);

ALTER TABLE `Server`
  ADD COLUMN `wikiSpaceId` VARCHAR(191) NULL,
  ADD COLUMN `wikiPageId` VARCHAR(191) NULL,
  ADD COLUMN `wikiSlug` VARCHAR(191) NULL;

CREATE INDEX `Server_wikiSpaceId_idx` ON `Server`(`wikiSpaceId`);
CREATE INDEX `Server_wikiSlug_idx` ON `Server`(`wikiSlug`);
