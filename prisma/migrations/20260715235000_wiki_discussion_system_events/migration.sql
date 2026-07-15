ALTER TABLE `wiki_discussion_comments`
  ADD COLUMN `entry_type` VARCHAR(16) NOT NULL DEFAULT 'comment',
  ADD COLUMN `event_type` VARCHAR(32) NULL,
  ADD COLUMN `event_before` TEXT NULL,
  ADD COLUMN `event_after` TEXT NULL,
  ADD INDEX `idx_wiki_comments_thread_entry` (`thread_id`, `entry_type`, `id`),
  ADD CONSTRAINT `chk_wiki_discussion_entry_shape` CHECK (
    (`entry_type` = 'comment' AND `event_type` IS NULL AND `event_before` IS NULL AND `event_after` IS NULL)
    OR
    (`entry_type` = 'system' AND `content` = '' AND `status` = 'normal' AND `event_type` IS NOT NULL AND (
      (`event_type` = 'status_change'
        AND `event_before` IS NOT NULL AND `event_after` IS NOT NULL
        AND `event_before` IN ('open', 'paused', 'closed')
        AND `event_after` IN ('open', 'paused', 'closed')
        AND `event_before` <> `event_after`)
      OR
      (`event_type` = 'topic_change'
        AND `event_before` IS NOT NULL AND CHAR_LENGTH(`event_before`) BETWEEN 1 AND 255
        AND `event_after` IS NOT NULL AND CHAR_LENGTH(`event_after`) BETWEEN 1 AND 255
        AND `event_before` <> `event_after`)
      OR
      (`event_type` = 'page_move'
        AND `event_before` IS NOT NULL AND `event_before` REGEXP '^[0-9]+$'
        AND `event_after` IS NOT NULL AND `event_after` REGEXP '^[0-9]+$'
        AND `event_before` <> `event_after`)
      OR
      (`event_type` = 'pin_change'
        AND (`event_before` IS NULL OR `event_before` REGEXP '^[0-9]+$')
        AND (`event_after` IS NULL OR `event_after` REGEXP '^[0-9]+$')
        AND (`event_before` IS NOT NULL OR `event_after` IS NOT NULL)
        AND NOT (`event_before` <=> `event_after`))
    ))
  );
