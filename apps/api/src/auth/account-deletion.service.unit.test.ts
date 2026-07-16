import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AccountDeletionService } from './account-deletion.service';

test('account deletion revokes every active non-owner collaborator role as a system action', async () => {
  const now = new Date('2026-07-17T00:00:00.000Z');
  const profileIds = [11n, 12n];
  let received: unknown;
  const service = new AccountDeletionService({} as never);
  const count = await (service as unknown as {
    revokeWikiCollaboratorRoles: (
      tx: unknown,
      ids: bigint[],
      revokedAt: Date,
    ) => Promise<number>;
  }).revokeWikiCollaboratorRoles({
    subwikiRole: {
      async updateMany(input: unknown) {
        received = input;
        return { count: 4 };
      },
    },
  }, profileIds, now);

  assert.equal(count, 4);
  assert.deepEqual(received, {
    where: {
      userId: { in: profileIds },
      status: 'active',
      role: { not: 'owner' },
    },
    data: {
      status: 'revoked',
      revokedAt: now,
      revokedBy: null,
    },
  });
});

test('account deletion skips collaborator writes when no deleting profile exists', async () => {
  let called = false;
  const service = new AccountDeletionService({} as never);
  const count = await (service as unknown as {
    revokeWikiCollaboratorRoles: (
      tx: unknown,
      ids: bigint[],
      revokedAt: Date,
    ) => Promise<number>;
  }).revokeWikiCollaboratorRoles({
    subwikiRole: {
      async updateMany() {
        called = true;
        return { count: 0 };
      },
    },
  }, [], new Date());

  assert.equal(count, 0);
  assert.equal(called, false);
});
