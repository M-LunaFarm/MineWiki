import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ConflictException, ForbiddenException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import { AccountModerationService } from './account-moderation.service';

const actorId = '00000000-0000-4000-8000-000000000001';
const targetId = '00000000-0000-4000-8000-000000000002';
const aliasId = '00000000-0000-4000-8000-000000000003';
const hasDatabase = Boolean(process.env.DATABASE_URL);

test('admin list and detail collapse linked identities into the canonical account', async () => {
  const fixture = moderationFixture();
  const service = new AccountModerationService(fixture.prisma as never);

  const list = await service.list({ limit: 50 });
  const detail = await service.getDetail(aliasId);

  assert.equal(list.accounts.length, 2);
  assert.equal(list.accounts.find((account) => account.canonicalAccountId === targetId)?.linkedAccountCount, 1);
  assert.equal(detail.canonicalAccountId, targetId);
  assert.equal(detail.confirmationValue, targetId);
  assert.deepEqual(new Set(detail.accountIds), new Set([targetId, aliasId]));
  assert.deepEqual(detail.roles, []);
});

test('suspension atomically changes the canonical group, revokes credentials, and appends audit', async () => {
  const fixture = moderationFixture();
  const service = new AccountModerationService(fixture.prisma as never);

  const result = await service.suspend(actorId, aliasId, {
    reason: '연결 계정에서 긴급 보안 침해 징후가 확인되었습니다.',
    confirmation: targetId,
    expectedStatus: 'active',
  });

  assert.ok(fixture.accounts.filter((account) => account.id !== actorId).every((account) => account.lifecycleStatus === 'suspended'));
  assert.ok(fixture.accounts.filter((account) => account.id !== actorId).every((account) => account.suspendedBy === actorId));
  assert.equal(fixture.sessionCount, 0);
  assert.equal(fixture.tokens[0]?.status, 'revoked');
  assert.equal(result.account.canonicalAccountId, targetId);
  assert.deepEqual(new Set(result.account.accountIds), new Set([targetId, aliasId]));
  assert.equal(result.revokedSessionCount, 2);
  assert.equal(result.revokedWikiApiTokenCount, 1);
  assert.equal(fixture.audits.at(-1)?.action, 'account.suspended');
  assert.deepEqual(fixture.audits.at(-1)?.metadata.accountIds, [targetId, aliasId]);
});

test('restore only accepts a uniformly suspended group and revokes sessions and tokens again', async () => {
  const fixture = moderationFixture({ targetStatus: 'suspended', actorRole: 'owner' });
  fixture.sessionCount = 1;
  fixture.tokens.push({ accountId: aliasId, status: 'active', revokedAt: null });
  const service = new AccountModerationService(fixture.prisma as never);

  const result = await service.restore(actorId, targetId, {
    reason: '본인 확인과 사고 대응 후 안전한 복구가 승인되었습니다.',
    confirmation: targetId,
    expectedStatus: 'suspended',
  });

  assert.ok(fixture.accounts.filter((account) => account.id !== actorId).every((account) => account.lifecycleStatus === 'active'));
  assert.ok(fixture.accounts.filter((account) => account.id !== actorId).every((account) => account.suspendedAt === null));
  assert.equal(result.account.lifecycleStatus, 'active');
  assert.equal(fixture.audits.at(-1)?.action, 'account.restored');
  assert.equal(fixture.sessionCount, 0);
  assert.ok(fixture.tokens.every((token) => token.status === 'revoked'));
});

test('restore rejects an active group even when the caller claims the suspended expected status', async () => {
  const fixture = moderationFixture({ actorRole: 'owner' });
  const service = new AccountModerationService(fixture.prisma as never);

  await assert.rejects(
    () => service.restore(actorId, targetId, {
      reason: '정지되지 않은 계정은 복구할 수 없어야 합니다.',
      confirmation: targetId,
      expectedStatus: 'suspended',
    }),
    ConflictException,
  );
  assert.equal(fixture.updateCalls, 0);
});

test('canonical self-targeting is rejected before any lifecycle mutation', async () => {
  const fixture = moderationFixture();
  const service = new AccountModerationService(fixture.prisma as never);

  await assert.rejects(
    () => service.suspend(targetId, aliasId, {
      reason: '자기 연결 계정 그룹을 정지하려는 잘못된 요청입니다.',
      confirmation: targetId,
      expectedStatus: 'active',
    }),
    ForbiddenException,
  );
  assert.equal(fixture.updateCalls, 0);
});

test('admin hierarchy cannot target another admin canonical group', async () => {
  const fixture = moderationFixture({ targetRole: 'admin' });
  const service = new AccountModerationService(fixture.prisma as never);

  await assert.rejects(
    () => service.suspend(actorId, targetId, {
      reason: '관리자 계층 보호 검증을 위한 충분히 긴 사유입니다.',
      confirmation: targetId,
      expectedStatus: 'active',
    }),
    ForbiddenException,
  );
  assert.equal(fixture.updateCalls, 0);
});

test('last active owner protection is evaluated while hierarchy roles are locked', async () => {
  const fixture = moderationFixture({ actorRole: 'owner', targetRole: 'owner', onlyTargetIsActiveOwner: true });
  const service = new AccountModerationService(fixture.prisma as never);

  await assert.rejects(
    () => service.suspend(actorId, targetId, {
      reason: '마지막 활성 소유자 보호를 검증하기 위한 요청입니다.',
      confirmation: targetId,
      expectedStatus: 'active',
    }),
    ConflictException,
  );
  assert.equal(fixture.updateCalls, 0);
});

if (hasDatabase) {
  const prisma = new PrismaService();

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  test('database suspension atomically fences a canonical group and permanently revokes credentials', async () => {
    const actorAccountId = randomUUID();
    const targetAccountId = randomUUID();
    const aliasAccountId = randomUUID();
    const tokenId = randomUUID();
    const now = new Date();
    const expiresAt = new Date(now.getTime() + 3_600_000);
    const service = new AccountModerationService(prisma);

    try {
      const [ownerRole] = await Promise.all([
        prisma.globalRole.upsert({
          where: { code: 'owner' },
          update: {},
          create: { code: 'owner', displayName: 'Owner', description: 'Test owner' },
        }),
        prisma.globalRole.upsert({
          where: { code: 'admin' },
          update: {},
          create: { code: 'admin', displayName: 'Admin', description: 'Test admin' },
        }),
      ]);
      await prisma.account.createMany({
        data: [
          { id: actorAccountId, provider: 'email', providerUserId: `moderation-actor-${actorAccountId}`, email: `${actorAccountId}@example.com`, emailVerified: true },
          { id: targetAccountId, provider: 'email', providerUserId: `moderation-target-${targetAccountId}`, email: `${targetAccountId}@example.com`, emailVerified: true },
          { id: aliasAccountId, canonicalAccountId: targetAccountId, provider: 'discord', providerUserId: `moderation-alias-${aliasAccountId}`, emailVerified: false },
        ],
      });
      await prisma.accountLink.create({ data: { primaryAccountId: targetAccountId, linkedAccountId: aliasAccountId } });
      await prisma.accountRole.create({ data: { accountId: actorAccountId, roleId: ownerRole.id } });
      await prisma.session.createMany({
        data: [targetAccountId, aliasAccountId].map((accountId, index) => ({
          id: randomUUID(), accountId, token: `moderation-session-${targetAccountId}-${index}`,
          issuedAt: now, expiresAt, tokenVersion: 1, lastActiveAt: now,
        })),
      });
      await prisma.wikiApiToken.create({
        data: {
          id: tokenId, accountId: targetAccountId, name: 'Emergency test token',
          tokenPrefix: `mwt_${tokenId.slice(0, 12)}`, secretHash: 'a'.repeat(64),
          scopes: ['wiki:read'], expiresAt,
        },
      });

      const suspended = await service.suspend(actorAccountId, aliasAccountId, {
        reason: '실제 트랜잭션에서 계정 침해 대응 경계를 검증합니다.',
        confirmation: targetAccountId,
        expectedStatus: 'active',
      });
      const [suspendedAccounts, sessions, token, audit] = await Promise.all([
        prisma.account.findMany({ where: { id: { in: [targetAccountId, aliasAccountId] } } }),
        prisma.session.count({ where: { accountId: { in: [targetAccountId, aliasAccountId] } } }),
        prisma.wikiApiToken.findUniqueOrThrow({ where: { id: tokenId } }),
        prisma.auditEvent.findFirst({ where: { action: 'account.suspended', subjectId: targetAccountId }, orderBy: { createdAt: 'desc' } }),
      ]);
      assert.equal(suspended.revokedSessionCount, 2);
      assert.equal(suspended.revokedWikiApiTokenCount, 1);
      assert.ok(suspendedAccounts.every((account) => account.lifecycleStatus === 'suspended'));
      assert.equal(sessions, 0);
      assert.equal(token.status, 'revoked');
      assert.equal(audit?.actorAccountId, actorAccountId);

      await service.restore(actorAccountId, targetAccountId, {
        reason: '보안 조사와 본인 확인을 마쳐 계정 접근을 복구합니다.',
        confirmation: targetAccountId,
        expectedStatus: 'suspended',
      });
      const restoredAccounts = await prisma.account.findMany({ where: { id: { in: [targetAccountId, aliasAccountId] } } });
      assert.ok(restoredAccounts.every((account) => account.lifecycleStatus === 'active'));
      assert.equal((await prisma.wikiApiToken.findUniqueOrThrow({ where: { id: tokenId } })).status, 'revoked');
    } finally {
      await prisma.auditEvent.deleteMany({ where: { OR: [{ actorAccountId }, { subjectId: targetAccountId }] } });
      await prisma.account.deleteMany({ where: { id: { in: [aliasAccountId, targetAccountId, actorAccountId] } } });
    }
  });
}

function moderationFixture(options: {
  targetStatus?: 'active' | 'suspended';
  actorRole?: 'owner' | 'admin';
  targetRole?: 'owner' | 'admin';
  onlyTargetIsActiveOwner?: boolean;
} = {}) {
  const now = new Date('2026-07-16T00:00:00.000Z');
  const targetStatus = options.targetStatus ?? 'active';
  const accounts = [
    account(actorId, null, 'active', now),
    account(targetId, null, targetStatus, now),
    account(aliasId, targetId, targetStatus, now),
  ];
  const assignments = [
    { accountId: actorId, role: { code: options.actorRole ?? 'admin' } },
    ...(options.targetRole ? [{ accountId: targetId, role: { code: options.targetRole } }] : []),
  ];
  const audits: Array<{
    id: string;
    action: string;
    actorAccountId: string | null;
    metadata: Record<string, unknown>;
    createdAt: Date;
  }> = [];
  const tokens = [{ accountId: targetId, status: 'active', revokedAt: null as Date | null }];
  const links = [{ primaryAccountId: targetId, linkedAccountId: aliasId }];
  const fixture = {
    accounts,
    audits,
    tokens,
    sessionCount: 2,
    updateCalls: 0,
    prisma: {} as Record<string, unknown>,
  };

  const tx = {
    account: {
      async findUnique(input: { where: { id: string } }) {
        return accounts.find((entry) => entry.id === input.where.id) ?? null;
      },
      async findMany(input: { where?: Record<string, unknown> }) {
        return filterAccounts(accounts, input.where);
      },
      async updateMany(input: {
        where: { id: { in: string[] }; lifecycleStatus: string };
        data: Record<string, unknown>;
      }) {
        fixture.updateCalls += 1;
        const targets = accounts.filter((entry) =>
          input.where.id.in.includes(entry.id) && entry.lifecycleStatus === input.where.lifecycleStatus,
        );
        for (const entry of targets) Object.assign(entry, input.data);
        return { count: targets.length };
      },
    },
    accountLink: {
      async findMany(input: { where: { OR: Array<Record<string, { in: string[] }>> } }) {
        const frontier = input.where.OR.flatMap((clause) =>
          clause.primaryAccountId?.in ?? clause.linkedAccountId?.in ?? [],
        );
        return links.filter((link) =>
          frontier.includes(link.primaryAccountId) || frontier.includes(link.linkedAccountId),
        );
      },
    },
    globalRole: {
      async findMany() { return [{ id: 'role-owner' }, { id: 'role-admin' }]; },
    },
    accountRole: {
      async findMany(input: { where?: { accountId?: { in: string[] }; role?: { code: string } } }) {
        if (input.where?.role?.code === 'owner') {
          if (options.onlyTargetIsActiveOwner) {
            return [{ account: { id: targetId, canonicalAccountId: null } }];
          }
          return assignments
            .filter((entry) => entry.role.code === 'owner')
            .map((entry) => ({ account: accounts.find((accountRow) => accountRow.id === entry.accountId)! }));
        }
        const accountIds = input.where?.accountId?.in;
        return accountIds ? assignments.filter((entry) => accountIds.includes(entry.accountId)) : assignments;
      },
    },
    session: {
      async deleteMany() { const count = fixture.sessionCount; fixture.sessionCount = 0; return { count }; },
    },
    wikiApiToken: {
      async updateMany(input: { where: { accountId: { in: string[] }; status: string }; data: { status: string; revokedAt: Date } }) {
        const active = tokens.filter((token) => input.where.accountId.in.includes(token.accountId) && token.status === input.where.status);
        for (const token of active) Object.assign(token, input.data);
        return { count: active.length };
      },
    },
    auditEvent: {
      async create(input: { data: { action: string; actorAccountId: string | null; metadata: Record<string, unknown> } }) {
        const row = { id: randomUUID(), action: input.data.action, actorAccountId: input.data.actorAccountId, metadata: input.data.metadata, createdAt: new Date() };
        audits.push(row);
        return row;
      },
      async findMany() { return [...audits].reverse(); },
    },
    async $queryRaw(query: { strings: string[]; values: unknown[] }) {
      if (query.strings[0]?.includes('`Account`')) {
        return accounts.filter(({ id }) => query.values.includes(id)).map(({ id }) => ({ id }));
      }
      return query.values.map((id) => ({ id }));
    },
  };
  fixture.prisma = {
    ...tx,
    async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); },
  };
  return fixture;
}

function account(
  id: string,
  canonicalAccountId: string | null,
  lifecycleStatus: 'active' | 'suspended',
  now: Date,
) {
  return {
    id,
    canonicalAccountId,
    provider: 'email' as const,
    email: `${id.at(-1)}@example.com`,
    displayName: `Account ${id.at(-1)}`,
    lifecycleStatus,
    createdAt: now,
    lastLoginAt: now,
    suspendedAt: lifecycleStatus === 'suspended' ? now : null,
    suspendedBy: lifecycleStatus === 'suspended' ? actorId : null,
    suspensionReason: lifecycleStatus === 'suspended' ? '기존 정지 사유입니다.' : null,
  };
}

function filterAccounts<T extends { id: string; canonicalAccountId: string | null }>(
  accounts: T[],
  where?: Record<string, unknown>,
): T[] {
  if (!where) return [...accounts];
  const directIds = (where.id as { in?: string[] } | undefined)?.in;
  if (directIds) return accounts.filter((entry) => directIds.includes(entry.id));
  const clauses = where.OR as Array<Record<string, { in?: string[] }>> | undefined;
  if (!clauses) return [...accounts];
  return accounts.filter((entry) => clauses.some((clause) => {
    const ids = clause.id?.in;
    const canonicalIds = clause.canonicalAccountId?.in;
    return Boolean(ids?.includes(entry.id) || (entry.canonicalAccountId && canonicalIds?.includes(entry.canonicalAccountId)));
  }));
}
