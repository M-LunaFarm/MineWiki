-- Preflight is intentionally repeated in application validation before this migration is deployed.
-- These one-to-one numeric links are durable even after a server wiki is archived.
DROP INDEX `Server_wikiSpaceId_idx` ON `Server`;
DROP INDEX `server_wikis_space_id_idx` ON `server_wikis`;

ALTER TABLE `Server`
  ADD UNIQUE INDEX `Server_wikiSpaceId_key` (`wikiSpaceId`),
  ADD UNIQUE INDEX `Server_wikiPageId_key` (`wikiPageId`);

ALTER TABLE `server_wikis`
  ADD UNIQUE INDEX `server_wikis_space_id_key` (`space_id`);

ALTER TABLE `wiki_spaces`
  ADD UNIQUE INDEX `wiki_spaces_root_page_id_key` (`root_page_id`);

ALTER TABLE `Server`
  ADD CONSTRAINT `Server_wikiSpaceId_fkey`
    FOREIGN KEY (`wikiSpaceId`) REFERENCES `wiki_spaces` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  ADD CONSTRAINT `Server_wikiPageId_fkey`
    FOREIGN KEY (`wikiPageId`) REFERENCES `pages` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE `server_wikis`
  ADD CONSTRAINT `server_wikis_space_id_fkey`
    FOREIGN KEY (`space_id`) REFERENCES `wiki_spaces` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `wiki_spaces`
  ADD CONSTRAINT `wiki_spaces_root_page_id_fkey`
    FOREIGN KEY (`root_page_id`) REFERENCES `pages` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE;
