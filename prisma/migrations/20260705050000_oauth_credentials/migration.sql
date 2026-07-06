CREATE TABLE IF NOT EXISTS `oauth_credentials` (
  `id` CHAR(36) NOT NULL,
  `accountId` VARCHAR(191) NOT NULL,
  `provider` ENUM('discord', 'naver') NOT NULL,
  `providerUserId` VARCHAR(191) NOT NULL,
  `accessToken` TEXT NOT NULL,
  `refreshToken` TEXT NULL,
  `tokenType` VARCHAR(32) NULL,
  `scope` VARCHAR(512) NULL,
  `expiresAt` DATETIME(3) NULL,
  `createdAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updatedAt` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (`id`),
  UNIQUE KEY `oauth_credentials_accountId_provider_providerUserId_key` (`accountId`, `provider`, `providerUserId`),
  KEY `oauth_credentials_provider_providerUserId_idx` (`provider`, `providerUserId`),
  KEY `oauth_credentials_expiresAt_idx` (`expiresAt`),
  CONSTRAINT `oauth_credentials_accountId_fkey`
    FOREIGN KEY (`accountId`) REFERENCES `Account` (`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
