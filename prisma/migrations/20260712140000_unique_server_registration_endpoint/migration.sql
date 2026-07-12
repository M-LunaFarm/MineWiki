ALTER TABLE `Server`
  ADD COLUMN `registrationEndpointKey` CHAR(64) NULL AFTER `registrantAccountId`;

UPDATE `Server` AS `server`
JOIN (
  SELECT
    `grouped`.`keepId`,
    SHA2(
      CONCAT(
        `grouped`.`editionKey`,
        ':',
        `grouped`.`hostKey`,
        ':',
        `grouped`.`portKey`
      ),
      256
    ) AS `endpointKey`
  FROM (
    SELECT
      MIN(`id`) AS `keepId`,
      CAST(`edition` AS CHAR) AS `editionKey`,
      LOWER(TRIM(TRAILING '.' FROM TRIM(`joinHost`))) AS `hostKey`,
      `joinPort` AS `portKey`
    FROM `Server`
    GROUP BY
      `edition`,
      LOWER(TRIM(TRAILING '.' FROM TRIM(`joinHost`))),
      `joinPort`
  ) AS `grouped`
) AS `canonical` ON `canonical`.`keepId` = `server`.`id`
SET `server`.`registrationEndpointKey` = `canonical`.`endpointKey`;

CREATE UNIQUE INDEX `Server_registrationEndpointKey_key`
  ON `Server`(`registrationEndpointKey`);
