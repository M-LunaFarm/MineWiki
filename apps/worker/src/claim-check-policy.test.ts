import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildClaimCheckDueWhere } from './claim-check-policy';

test('claim scheduler retries owner proof failures only after the six-hour spacing window', () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const where = buildClaimCheckDueWhere(now);
  const failed = where.OR?.[2] as {
    status: string;
    server: { ownerAccountId: { not: null } };
    OR: Array<{ lastCheckedAt: null | { lt: Date } }>;
  };

  assert.equal(failed.status, 'failed');
  assert.deepEqual(failed.server, { ownerAccountId: { not: null } });
  assert.equal(
    (failed.OR[1]?.lastCheckedAt as { lt: Date }).lt.toISOString(),
    '2026-07-19T06:00:00.000Z',
  );
});

test('claim scheduler keeps pending and verified checks at one-hour and daily cadences', () => {
  const now = new Date('2026-07-19T12:00:00.000Z');
  const where = buildClaimCheckDueWhere(now);
  const pending = where.OR?.[0] as { OR: Array<{ lastCheckedAt: null | { lt: Date } }> };
  const verified = where.OR?.[1] as { OR: Array<{ lastCheckedAt: null | { lt: Date } }> };

  assert.equal(
    (pending.OR[1]?.lastCheckedAt as { lt: Date }).lt.toISOString(),
    '2026-07-19T11:00:00.000Z',
  );
  assert.equal(
    (verified.OR[1]?.lastCheckedAt as { lt: Date }).lt.toISOString(),
    '2026-07-18T12:00:00.000Z',
  );
});
