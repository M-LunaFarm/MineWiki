import { createHmac, timingSafeEqual } from 'node:crypto';

export type WikiRecentDiscussionSort = 'newest' | 'oldest';
export type WikiRecentDiscussionCursorScope =
  | { readonly kind: 'page'; readonly pageId: string; readonly status: string; readonly sort: 'newest' }
  | { readonly kind: 'global'; readonly status: string; readonly sort: WikiRecentDiscussionSort };

export interface WikiRecentDiscussionCursor {
  readonly snapshotAt: Date;
  readonly updatedAt: Date;
  readonly id: bigint;
}

export function encodeWikiRecentDiscussionCursor(
  secret: string,
  scope: WikiRecentDiscussionCursorScope,
  cursor: WikiRecentDiscussionCursor,
): string {
  const payload = Buffer.from(JSON.stringify({
    version: 2,
    scope,
    snapshotAt: cursor.snapshotAt.toISOString(),
    updatedAt: cursor.updatedAt.toISOString(),
    id: cursor.id.toString(),
  })).toString('base64url');
  return `${payload}.${sign(secret, payload)}`;
}

export function decodeWikiRecentDiscussionCursor(
  secret: string,
  expectedScope: WikiRecentDiscussionCursorScope,
  value: string,
  now = new Date(),
): WikiRecentDiscussionCursor {
  const [payload, signature, extra] = value.split('.');
  if (!payload || !signature || extra !== undefined) throw new Error('WIKI_RECENT_DISCUSSION_CURSOR_INVALID');
  const expected = Buffer.from(sign(secret, payload));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) {
    throw new Error('WIKI_RECENT_DISCUSSION_CURSOR_INVALID');
  }
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
  } catch {
    throw new Error('WIKI_RECENT_DISCUSSION_CURSOR_INVALID');
  }
  if (
    parsed.version !== 2
    || JSON.stringify(parsed.scope) !== JSON.stringify(expectedScope)
    || typeof parsed.snapshotAt !== 'string'
    || typeof parsed.updatedAt !== 'string'
    || typeof parsed.id !== 'string'
    || !/^\d+$/u.test(parsed.id)
  ) throw new Error('WIKI_RECENT_DISCUSSION_CURSOR_INVALID');
  const snapshotAt = new Date(parsed.snapshotAt);
  const updatedAt = new Date(parsed.updatedAt);
  if (
    Number.isNaN(snapshotAt.getTime())
    || Number.isNaN(updatedAt.getTime())
    || snapshotAt.getTime() > now.getTime()
    || updatedAt.getTime() > snapshotAt.getTime()
  ) throw new Error('WIKI_RECENT_DISCUSSION_CURSOR_INVALID');
  return { snapshotAt, updatedAt, id: BigInt(parsed.id) };
}

function sign(secret: string, payload: string): string {
  if (!secret) throw new Error('WIKI_RECENT_DISCUSSION_CURSOR_SECRET_MISSING');
  return createHmac('sha256', secret)
    .update(`minewiki:wiki-discussion-recent:v2:${payload}`)
    .digest('base64url');
}
