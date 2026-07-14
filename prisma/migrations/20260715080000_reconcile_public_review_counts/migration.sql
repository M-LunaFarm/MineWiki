UPDATE `Server` AS server
LEFT JOIN (
  SELECT review.`serverId`, COUNT(*) AS public_count
  FROM `ServerReview` AS review
  WHERE review.`visibility` = 'public'
  GROUP BY review.`serverId`
) AS counted ON counted.`serverId` = server.`id`
SET server.`reviewsCount` = COALESCE(counted.public_count, 0)
WHERE server.`reviewsCount` <> COALESCE(counted.public_count, 0);
