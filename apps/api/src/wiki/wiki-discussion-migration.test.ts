import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';

const migrationUrl = new URL('../../../../prisma/migrations/20260715235000_wiki_discussion_system_events/migration.sql', import.meta.url);

test('discussion system event migration enforces every immutable event shape', async () => {
  const sql = await readFile(migrationUrl, 'utf8');
  assert.match(sql, /entry_type` = 'comment'.*event_type` IS NULL.*event_before` IS NULL.*event_after` IS NULL/s);
  assert.match(sql, /event_type` = 'status_change'.*event_before` IN \('open', 'paused', 'closed'\).*event_after` IN \('open', 'paused', 'closed'\).*event_before` <> `event_after/s);
  assert.match(sql, /event_type` = 'topic_change'.*CHAR_LENGTH\(`event_before`\) BETWEEN 1 AND 255.*CHAR_LENGTH\(`event_after`\) BETWEEN 1 AND 255.*event_before` <> `event_after/s);
  assert.match(sql, /event_type` = 'page_move'.*event_before` REGEXP '\^\[0-9\]\+\$'.*event_after` REGEXP '\^\[0-9\]\+\$'.*event_before` <> `event_after/s);
  assert.match(sql, /event_type` = 'pin_change'.*event_before` IS NOT NULL OR `event_after` IS NOT NULL.*NOT \(`event_before` <=> `event_after`\)/s);
});
