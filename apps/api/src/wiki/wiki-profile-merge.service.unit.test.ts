import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Prisma } from '@prisma/client';
import { WikiProfileMergeService } from './wiki-profile-merge.service';
import type { PrismaService } from '../common/prisma.service';
import type { WikiProfileService } from './wiki-profile.service';

type RoleRow = {
  id: bigint;
  spaceId: bigint;
  userId: bigint;
  role: string;
  status: string;
  grantedBy: bigint | null;
  grantedAt: Date;
  revokedAt: Date | null;
  revokedBy: bigint | null;
};

test('profile merge preserves canonical role state and only inherits missing active roles', async () => {
  const sourceId = 10n;
  const targetId = 20n;
  const actorId = 30n;
  const now = new Date('2026-07-17T00:00:00.000Z');
  const originalRevokedAt = new Date('2026-07-01T00:00:00.000Z');
  const rows: RoleRow[] = [
    {
      id: 1n, spaceId: 100n, userId: sourceId, role: 'manager', status: 'active',
      grantedBy: 40n, grantedAt: new Date('2026-06-01T00:00:00.000Z'), revokedAt: null, revokedBy: null
    },
    {
      id: 2n, spaceId: 100n, userId: targetId, role: 'manager', status: 'revoked',
      grantedBy: 41n, grantedAt: new Date('2026-05-01T00:00:00.000Z'), revokedAt: originalRevokedAt, revokedBy: 42n
    },
    {
      id: 3n, spaceId: 100n, userId: sourceId, role: 'editor', status: 'active',
      grantedBy: 43n, grantedAt: new Date('2026-06-02T00:00:00.000Z'), revokedAt: null, revokedBy: null
    },
    {
      id: 4n, spaceId: 100n, userId: targetId, role: 'editor', status: 'active',
      grantedBy: 44n, grantedAt: new Date('2026-05-02T00:00:00.000Z'), revokedAt: null, revokedBy: null
    },
    {
      id: 5n, spaceId: 100n, userId: sourceId, role: 'reviewer', status: 'active',
      grantedBy: 45n, grantedAt: new Date('2026-06-03T00:00:00.000Z'), revokedAt: null, revokedBy: null
    },
    {
      id: 6n, spaceId: 100n, userId: sourceId, role: 'trusted', status: 'revoked',
      grantedBy: 46n, grantedAt: new Date('2026-04-01T00:00:00.000Z'), revokedAt: originalRevokedAt, revokedBy: 47n
    }
  ];
  let nextId = 7n;
  const subwikiRole = {
    async findMany({ where }: { where: { userId: bigint; status: string } }) {
      return rows.filter((row) => row.userId === where.userId && row.status === where.status);
    },
    async findUnique({ where }: { where: { spaceId_userId_role: { spaceId: bigint; userId: bigint; role: string } } }) {
      const key = where.spaceId_userId_role;
      return rows.find((row) => row.spaceId === key.spaceId && row.userId === key.userId && row.role === key.role) ?? null;
    },
    async create({ data }: { data: Omit<RoleRow, 'id' | 'revokedAt' | 'revokedBy'> }) {
      const row: RoleRow = { id: nextId++, ...data, revokedAt: null, revokedBy: null };
      rows.push(row);
      return row;
    },
    async update({ where, data }: { where: { id: bigint }; data: Partial<RoleRow> }) {
      const row = rows.find((candidate) => candidate.id === where.id);
      assert.ok(row);
      Object.assign(row, data);
      return row;
    }
  };
  let rolesLocked = false;
  const $queryRaw = async () => {
    rolesLocked = true;
    return [];
  };
  const service = new WikiProfileMergeService({} as PrismaService, {} as WikiProfileService);
  const transferSubwikiRoles = (
    service as unknown as {
      transferSubwikiRoles(
        tx: Prisma.TransactionClient,
        sourceId: bigint,
        targetId: bigint,
        actorProfileId: bigint,
        now: Date
      ): Promise<number>;
    }
  ).transferSubwikiRoles.bind(service);

  const transferred = await transferSubwikiRoles({ subwikiRole, $queryRaw } as unknown as Prisma.TransactionClient, sourceId, targetId, actorId, now);

  assert.equal(rolesLocked, true);
  assert.equal(transferred, 3);
  const revokedTarget = rows.find((row) => row.userId === targetId && row.role === 'manager');
  assert.equal(revokedTarget?.status, 'revoked');
  assert.equal(revokedTarget?.revokedAt, originalRevokedAt);
  assert.equal(revokedTarget?.revokedBy, 42n);
  const activeTarget = rows.find((row) => row.userId === targetId && row.role === 'editor');
  assert.equal(activeTarget?.status, 'active');
  assert.equal(activeTarget?.grantedBy, 44n);
  const inheritedTarget = rows.find((row) => row.userId === targetId && row.role === 'reviewer');
  assert.equal(inheritedTarget?.status, 'active');
  assert.equal(inheritedTarget?.grantedBy, 45n);
  assert.equal(rows.some((row) => row.userId === targetId && row.role === 'trusted'), false);
  assert.deepEqual(
    rows.filter((row) => row.userId === sourceId && row.status === 'active'),
    []
  );
  assert.equal(rows.find((row) => row.id === 6n)?.revokedBy, 47n);
});
