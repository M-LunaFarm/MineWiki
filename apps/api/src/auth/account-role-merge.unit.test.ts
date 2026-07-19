import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  rehomeAccountRolesForCanonicalMerge,
  rehomeMfaTotpForCanonicalMerge,
} from './account-separation.service';

test('canonical account merge preserves and deduplicates roles from every alias', async () => {
  const canonicalAccountId = 'canonical';
  const aliasAccountId = 'alias';
  const oldest = new Date('2026-01-01T00:00:00.000Z');
  const newer = new Date('2026-02-01T00:00:00.000Z');
  const rows = [
    { id: 'alias-admin', accountId: aliasAccountId, roleId: 'admin', createdAt: oldest },
    { id: 'canonical-moderator', accountId: canonicalAccountId, roleId: 'moderator', createdAt: oldest },
    { id: 'alias-moderator', accountId: aliasAccountId, roleId: 'moderator', createdAt: newer },
  ];
  const prisma = {
    accountRole: {
      findMany: async () => rows.map((row) => ({ ...row })),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in) {
          const index = rows.findIndex((row) => row.id === id);
          if (index >= 0) rows.splice(index, 1);
        }
        return { count: where.id.in.length };
      },
      update: async ({ where, data }: {
        where: { id: string };
        data: { accountId: string };
      }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('role row not found');
        row.accountId = data.accountId;
        return row;
      },
    },
  };

  await rehomeAccountRolesForCanonicalMerge(
    prisma as never,
    canonicalAccountId,
    [canonicalAccountId, aliasAccountId],
  );
  await rehomeAccountRolesForCanonicalMerge(
    prisma as never,
    canonicalAccountId,
    [canonicalAccountId, aliasAccountId],
  );

  assert.deepEqual(
    rows.map(({ accountId, roleId }) => ({ accountId, roleId })),
    [
      { accountId: canonicalAccountId, roleId: 'admin' },
      { accountId: canonicalAccountId, roleId: 'moderator' },
    ],
  );
  assert.equal(rows.find((row) => row.roleId === 'admin')?.createdAt, oldest);
  assert.equal(rows.find((row) => row.roleId === 'moderator')?.id, 'canonical-moderator');
});

test('canonical account merge keeps an enabled TOTP credential on the canonical account', async () => {
  const canonicalAccountId = 'canonical';
  const rows = [
    {
      id: 'canonical-pending', accountId: canonicalAccountId, enabledAt: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    },
    {
      id: 'alias-enabled', accountId: 'alias', enabledAt: new Date('2026-02-01T00:00:00.000Z'),
      createdAt: new Date('2026-02-01T00:00:00.000Z'),
    },
  ];
  const prisma = {
    mfaTotpCredential: {
      findMany: async () => rows.map((row) => ({ ...row })),
      deleteMany: async ({ where }: { where: { id: { in: string[] } } }) => {
        for (const id of where.id.in) {
          const index = rows.findIndex((row) => row.id === id);
          if (index >= 0) rows.splice(index, 1);
        }
        return { count: where.id.in.length };
      },
      update: async ({ where, data }: {
        where: { id: string };
        data: { accountId: string };
      }) => {
        const row = rows.find((candidate) => candidate.id === where.id);
        if (!row) throw new Error('TOTP credential not found');
        row.accountId = data.accountId;
        return row;
      },
    },
  };

  await rehomeMfaTotpForCanonicalMerge(
    prisma as never,
    canonicalAccountId,
    [canonicalAccountId, 'alias'],
  );

  assert.equal(rows.length, 1);
  assert.equal(rows[0]?.id, 'alias-enabled');
  assert.equal(rows[0]?.accountId, canonicalAccountId);
  assert.ok(rows[0]?.enabledAt);
});
