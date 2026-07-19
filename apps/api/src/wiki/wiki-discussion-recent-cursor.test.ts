import assert from 'node:assert/strict';
import test from 'node:test';
import {
  decodeWikiRecentDiscussionCursor,
  encodeWikiRecentDiscussionCursor,
  type WikiRecentDiscussionCursorScope,
} from './wiki-discussion-recent-cursor';

const secret = 'test-cursor-secret-at-least-32-characters';
const scope: WikiRecentDiscussionCursorScope = { kind: 'global', status: 'active', sort: 'newest' };
const cursor = {
  snapshotAt: new Date('2026-07-18T08:00:00.000Z'),
  updatedAt: new Date('2026-07-18T07:00:00.000Z'),
  id: 42n,
};

test('recent discussion cursor round-trips only in its original filter scope', () => {
  const encoded = encodeWikiRecentDiscussionCursor(secret, scope, cursor);
  assert.deepEqual(decodeWikiRecentDiscussionCursor(secret, scope, encoded, cursor.snapshotAt), cursor);
  assert.throws(() => decodeWikiRecentDiscussionCursor(secret, { ...scope, status: 'closed' }, encoded, cursor.snapshotAt), /INVALID/u);
  assert.throws(() => decodeWikiRecentDiscussionCursor(secret, { ...scope, sort: 'oldest' }, encoded, cursor.snapshotAt), /INVALID/u);
});

test('recent discussion cursor rejects signature and timestamp tampering', () => {
  const encoded = encodeWikiRecentDiscussionCursor(secret, scope, cursor);
  const [payload, signature] = encoded.split('.');
  assert.throws(() => decodeWikiRecentDiscussionCursor(secret, scope, `${payload}.${signature}x`, cursor.snapshotAt), /INVALID/u);
  const future = encodeWikiRecentDiscussionCursor(secret, scope, {
    ...cursor,
    snapshotAt: new Date('2026-07-18T08:00:01.000Z'),
  });
  assert.throws(() => decodeWikiRecentDiscussionCursor(secret, scope, future, cursor.snapshotAt), /INVALID/u);
});

test('recent discussion cursor binds immutable server wiki and space identities', () => {
  const tenantScope: WikiRecentDiscussionCursorScope = {
    kind: 'space', serverWikiId: '50', spaceId: '40', status: 'all', sort: 'newest',
  };
  const encoded = encodeWikiRecentDiscussionCursor(secret, tenantScope, cursor);
  assert.deepEqual(decodeWikiRecentDiscussionCursor(secret, tenantScope, encoded, cursor.snapshotAt), cursor);
  assert.throws(() => decodeWikiRecentDiscussionCursor(secret, {
    ...tenantScope, serverWikiId: '51', spaceId: '41',
  }, encoded, cursor.snapshotAt), /INVALID/u);
});
