-- Fail deployment instead of silently choosing an owner if legacy duplicates exist.
ALTER TABLE `MinecraftIdentity`
  ADD CONSTRAINT `MinecraftIdentity_uuid_key` UNIQUE (`uuid`);
