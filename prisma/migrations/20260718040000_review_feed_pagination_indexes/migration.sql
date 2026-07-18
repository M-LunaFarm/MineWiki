CREATE INDEX `idx_review_staff_newest`
  ON `ServerReview`(`serverId`, `createdAt`, `id`);
CREATE INDEX `idx_review_staff_rating`
  ON `ServerReview`(`serverId`, `rating`, `createdAt`, `id`);
CREATE INDEX `idx_review_visibility_newest`
  ON `ServerReview`(`serverId`, `visibility`, `createdAt`, `id`);
CREATE INDEX `idx_review_visibility_rating`
  ON `ServerReview`(`serverId`, `visibility`, `rating`, `createdAt`, `id`);
CREATE INDEX `idx_review_author_visibility_newest`
  ON `ServerReview`(`serverId`, `authorAccountId`, `visibility`, `createdAt`, `id`);
CREATE INDEX `idx_review_author_visibility_rating`
  ON `ServerReview`(`serverId`, `authorAccountId`, `visibility`, `rating`, `createdAt`, `id`);
