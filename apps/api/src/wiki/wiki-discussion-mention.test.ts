import assert from 'node:assert/strict';
import { test } from 'node:test';
import { extractDiscussionMentions, uniqueDiscussionMentionUsernames } from './wiki-discussion-mention';

test('discussion mentions require a whitespace boundary and ignore email addresses', () => {
  assert.deepEqual(uniqueDiscussionMentionUsernames('hello @Alice a@b.com\n@bob'), ['Alice', 'bob']);
});

test('discussion mentions deduplicate case-insensitively and preserve safe offsets', () => {
  const content = '@Alice hello @alice';
  assert.deepEqual(extractDiscussionMentions(content), [
    { username: 'Alice', start: 0, end: 6 },
    { username: 'alice', start: 13, end: 19 }
  ]);
  assert.deepEqual(uniqueDiscussionMentionUsernames(content), ['Alice']);
});

test('discussion mentions reject oversized usernames and cap unique targets at ten', () => {
  const oversized = `@${'a'.repeat(65)}`;
  const targets = Array.from({ length: 12 }, (_, index) => `@user${index}`).join(' ');
  assert.deepEqual(uniqueDiscussionMentionUsernames(`${oversized} ${targets}`),
    Array.from({ length: 10 }, (_, index) => `user${index}`));
});
