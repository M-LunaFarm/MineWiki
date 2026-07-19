import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
} from '@nestjs/common';
import { Prisma, type WikiProfile } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { WikiProfileService } from '../wiki/wiki-profile.service';
import {
  ServerWikiCollaboratorService,
  type ServerWikiCollaboratorActor,
} from './server-wiki-collaborator.service';

const serverId = '11111111-1111-4111-8111-111111111111';
const ownerAccountId = '22222222-2222-4222-8222-222222222222';
const targetAccountId = '33333333-3333-4333-8333-333333333333';
const aliasAccountId = '44444444-4444-4444-8444-444444444444';
const now = new Date('2026-07-17T00:00:00.000Z');

const ownerActor: ServerWikiCollaboratorActor = {
  accountId: ownerAccountId,
  permissions: [],
};

interface TestRole {
  id: bigint;
  spaceId: bigint;
  userId: bigint;
  role: string;
  status: string;
  grantedAt: Date;
  grantedBy: bigint | null;
  revokedAt: Date | null;
  revokedBy: bigint | null;
}

interface FixtureOptions {
  readonly roles?: TestRole[];
  readonly failAudit?: boolean;
  readonly mismatchedWiki?: boolean;
  readonly mismatchedRootPage?: boolean;
  readonly ownershipSuspended?: boolean;
}

function wikiProfile(input: Partial<WikiProfile> & Pick<WikiProfile, 'id' | 'username' | 'displayName'>): WikiProfile {
  return {
    id: input.id,
    accountId: input.accountId ?? null,
    username: input.username,
    displayName: input.displayName,
    email: input.email ?? null,
    emailVerifiedAt: input.emailVerifiedAt ?? null,
    emailVerificationSentAt: input.emailVerificationSentAt ?? null,
    passwordHash: input.passwordHash ?? null,
    status: input.status ?? 'active',
    mergedIntoProfileId: input.mergedIntoProfileId ?? null,
    mergedAt: input.mergedAt ?? null,
    createdAt: input.createdAt ?? now,
    updatedAt: input.updatedAt ?? now,
  };
}

function role(input: Partial<TestRole> & Pick<TestRole, 'id' | 'userId' | 'role' | 'status'>): TestRole {
  return {
    id: input.id,
    spaceId: input.spaceId ?? 77n,
    userId: input.userId,
    role: input.role,
    status: input.status,
    grantedAt: input.grantedAt ?? now,
    grantedBy: input.grantedBy ?? 1n,
    revokedAt: input.revokedAt ?? (input.status === 'revoked' ? now : null),
    revokedBy: input.revokedBy ?? null,
  };
}

function createFixture(options: FixtureOptions = {}) {
  const profiles: WikiProfile[] = [
    wikiProfile({ id: 1n, accountId: ownerAccountId, username: 'server_owner', displayName: '서버 소유자' }),
    wikiProfile({ id: 2n, accountId: targetAccountId, username: 'Exact_User', displayName: '정확한 사용자' }),
    wikiProfile({ id: 3n, accountId: aliasAccountId, username: 'Old_User', displayName: '병합된 사용자', status: 'merged', mergedIntoProfileId: 2n, mergedAt: now }),
    wikiProfile({ id: 4n, accountId: '55555555-5555-4555-8555-555555555555', username: 'Blocked_User', displayName: '차단 사용자', status: 'blocked' }),
    wikiProfile({ id: 5n, accountId: '66666666-6666-4666-8666-666666666666', username: 'Closed_User', displayName: '닫힌 사용자', status: 'closed' }),
    wikiProfile({ id: 6n, accountId: null, username: 'Detached_User', displayName: '분리 사용자' }),
    wikiProfile({ id: 7n, accountId: '77777777-7777-4777-8777-777777777777', username: 'Linked_Alias', displayName: '연결 별칭' }),
    wikiProfile({ id: 8n, accountId: ownerAccountId, username: 'Owner_Alias', displayName: '소유자 프로필' }),
    wikiProfile({ id: 9n, accountId: '99999999-9999-4999-8999-999999999999', username: 'Legacy_Owner', displayName: '기존 소유자' }),
  ];
  const accounts = [
    { id: ownerAccountId, canonicalAccountId: ownerAccountId, lifecycleStatus: 'active' },
    { id: targetAccountId, canonicalAccountId: targetAccountId, lifecycleStatus: 'active' },
    { id: aliasAccountId, canonicalAccountId: ownerAccountId, lifecycleStatus: 'active' },
    { id: '55555555-5555-4555-8555-555555555555', canonicalAccountId: '55555555-5555-4555-8555-555555555555', lifecycleStatus: 'active' },
    { id: '66666666-6666-4666-8666-666666666666', canonicalAccountId: '66666666-6666-4666-8666-666666666666', lifecycleStatus: 'closed' },
    { id: '77777777-7777-4777-8777-777777777777', canonicalAccountId: targetAccountId, lifecycleStatus: 'active' },
    { id: '99999999-9999-4999-8999-999999999999', canonicalAccountId: '99999999-9999-4999-8999-999999999999', lifecycleStatus: 'active' },
  ];
  const roles = structuredClone(options.roles ?? []);
  const audits: Array<Record<string, unknown>> = [];
  const lockQueries: string[] = [];
  const isolationLevels: string[] = [];
  let nextRoleId = 100n;
  const server = {
    id: serverId,
    ownerAccountId,
    ownershipChallengeSuspendedAt: options.ownershipSuspended ? now : null,
    wikiSpaceId: 77n,
    wikiPageId: 99n,
    wikiSlug: 'test-server',
  };
  const serverWiki = {
    id: 88n,
    voteServerId: serverId,
    spaceId: options.mismatchedWiki ? 78n : 77n,
    slug: 'test-server',
    status: 'active',
  };
  const space = {
    id: 77n,
    slug: 'test-server',
    spaceType: 'server_wiki',
    status: 'active',
    rootPageId: options.mismatchedRootPage ? 100n : 99n,
  };

  const tx = {
    async $queryRaw(strings: TemplateStringsArray) {
      lockQueries.push(strings.join('?').replace(/\s+/gu, ' ').trim());
      return [];
    },
    server: {
      async findUnique(args: { where: { id: string } }) {
        return args.where.id === server.id ? server : null;
      },
    },
    serverWiki: {
      async findMany() {
        return [serverWiki];
      },
    },
    wikiSpace: {
      async findUnique(args: { where: { id: bigint } }) {
        return args.where.id === space.id ? space : null;
      },
    },
    wikiProfileAlias: {
      async findUnique(args: { where: { sourceProfileId: bigint } }) {
        return args.where.sourceProfileId === 3n ? { targetProfileId: 2n } : null;
      },
    },
    wikiProfile: {
      async findUnique(args: { where: { id?: bigint; username?: string; accountId?: string } }) {
        if (args.where.id !== undefined) return profiles.find((item) => item.id === args.where.id) ?? null;
        if (args.where.username !== undefined) return profiles.find((item) => item.username === args.where.username) ?? null;
        if (args.where.accountId !== undefined) return profiles.find((item) => item.accountId === args.where.accountId) ?? null;
        return null;
      },
      async findMany(args: { where: { id: { in: bigint[] } } }) {
        return profiles.filter((item) => args.where.id.in.includes(item.id));
      },
    },
    account: {
      async findUnique(args: { where: { id: string } }) {
        return accounts.find((item) => item.id === args.where.id) ?? null;
      },
    },
    subwikiRole: {
      async findMany(args: {
        where: {
          spaceId: bigint;
          userId?: bigint;
          status?: string;
          role?: { in: string[] };
        };
      }) {
        return roles
          .filter((item) => item.spaceId === args.where.spaceId)
          .filter((item) => args.where.userId === undefined || item.userId === args.where.userId)
          .filter((item) => args.where.status === undefined || item.status === args.where.status)
          .filter((item) => !args.where.role || args.where.role.in.includes(item.role))
          .sort((left, right) => Number(left.id - right.id));
      },
      async updateMany(args: {
        where: { id: bigint; status: string; role: string };
        data: Partial<TestRole>;
      }) {
        const current = roles.find((item) => (
          item.id === args.where.id
          && item.status === args.where.status
          && item.role === args.where.role
        ));
        if (!current) return { count: 0 };
        Object.assign(current, args.data);
        return { count: 1 };
      },
      async upsert(args: {
        where: { spaceId_userId_role: { spaceId: bigint; userId: bigint; role: string } };
        update: Partial<TestRole>;
        create: Omit<TestRole, 'id' | 'revokedAt' | 'revokedBy'>;
      }) {
        const key = args.where.spaceId_userId_role;
        const current = roles.find((item) => item.spaceId === key.spaceId && item.userId === key.userId && item.role === key.role);
        if (current) {
          Object.assign(current, args.update);
          return current;
        }
        const created: TestRole = { id: nextRoleId, revokedAt: null, revokedBy: null, ...args.create };
        nextRoleId += 1n;
        roles.push(created);
        return created;
      },
    },
    auditEvent: {
      async create(args: { data: Record<string, unknown> }) {
        if (options.failAudit) throw new Error('audit write failed');
        audits.push(args.data);
        return { id: randomUUID(), ...args.data };
      },
    },
  };

  const prisma = {
    server: tx.server,
    account: tx.account,
    async $transaction<T>(
      callback: (store: typeof tx) => Promise<T>,
      config: { isolationLevel: string },
    ): Promise<T> {
      isolationLevels.push(config.isolationLevel);
      const roleSnapshot = structuredClone(roles);
      const auditLength = audits.length;
      const nextIdSnapshot = nextRoleId;
      try {
        return await callback(tx);
      } catch (error) {
        roles.splice(0, roles.length, ...roleSnapshot);
        audits.splice(auditLength);
        nextRoleId = nextIdSnapshot;
        throw error;
      }
    },
  };
  const profileService = {
    async ensureWikiProfile(accountId: string) {
      const profile = profiles.find((item) => item.accountId === accountId && item.status !== 'merged');
      if (!profile) throw new Error('actor profile missing');
      return profile;
    },
  };
  return {
    service: new ServerWikiCollaboratorService(
      prisma as unknown as PrismaService,
      profileService as unknown as WikiProfileService,
    ),
    roles,
    audits,
    lockQueries,
    isolationLevels,
    profiles,
    accounts,
    server,
    serverWiki,
    space,
  };
}

test('owner list returns the frontend roster contract and locks the authoritative server-wiki graph', async () => {
  const fixture = createFixture({
    roles: [
      role({ id: 10n, userId: 2n, role: 'editor', status: 'active', grantedBy: 1n }),
      role({ id: 11n, userId: 9n, role: 'owner', status: 'active', grantedBy: 1n }),
    ],
  });
  const result = await fixture.service.list(serverId, ownerActor);

  assert.deepEqual(result.assignableRoles, ['manager', 'editor', 'reviewer']);
  assert.equal(result.serverId, serverId);
  assert.equal(result.spaceId, '77');
  assert.deepEqual(result.items, [{
    profileId: '2',
    username: 'Exact_User',
    displayName: '정확한 사용자',
    role: 'editor',
    expectedRole: 'editor',
    grantedAt: now.toISOString(),
    grantedByName: '서버 소유자',
    grantedBy: { profileId: '1', username: 'server_owner', displayName: '서버 소유자' },
  }]);
  assert.deepEqual(fixture.isolationLevels, [Prisma.TransactionIsolationLevel.Serializable]);
  assert.ok(fixture.lockQueries.some((query) => query.includes('FROM `Server`')));
  assert.ok(fixture.lockQueries.some((query) => query.includes('FROM server_wikis')));
  assert.ok(fixture.lockQueries.some((query) => query.includes('FROM wiki_spaces')));
  assert.ok(fixture.lockQueries.some((query) => query.includes('FROM subwiki_roles')));
});

test('ownership challenge locks owner and delegated collaborator authority while preserving server admin', async () => {
  const fixture = createFixture({
    ownershipSuspended: true,
    roles: [role({ id: 10n, userId: 2n, role: 'manager', status: 'active' })],
  });
  await assert.rejects(() => fixture.service.list(serverId, ownerActor), /소유권 재검증/u);
  await assert.rejects(() => fixture.service.authorizeContentSettings(serverId, {
    accountId: targetAccountId,
    permissions: [],
  }), /소유권 재검증/u);
  await assert.doesNotReject(() => fixture.service.list(serverId, {
    accountId: targetAccountId,
    permissions: ['server.admin'],
  }));
});

test('elevation and subwiki manager state never replace explicit server owner or global server.admin authority', async () => {
  const fixture = createFixture({ roles: [role({ id: 10n, userId: 2n, role: 'manager', status: 'active' })] });
  await assert.rejects(
    fixture.service.list(serverId, {
      accountId: targetAccountId,
      isElevated: true,
      groups: ['owner', 'server_admin'],
      permissions: [],
    }),
    ForbiddenException,
  );
  await assert.doesNotReject(
    fixture.service.list(serverId, { accountId: targetAccountId, permissions: ['server.admin'] }),
  );
});

test('only an unambiguous active manager receives bounded content-settings authority', async () => {
  const manager = createFixture({
    roles: [role({ id: 10n, userId: 2n, role: 'manager', status: 'active' })],
  });
  assert.deepEqual(
    await manager.service.authorizeContentSettings(serverId, { accountId: targetAccountId }),
    { accountId: targetAccountId, kind: 'manager' },
  );

  for (const roles of [
    [role({ id: 10n, userId: 2n, role: 'manager', status: 'revoked' })],
    [role({ id: 10n, userId: 2n, role: 'editor', status: 'active' })],
    [role({ id: 10n, userId: 2n, role: 'reviewer', status: 'active' })],
    [
      role({ id: 10n, userId: 2n, role: 'manager', status: 'active' }),
      role({ id: 11n, userId: 2n, role: 'editor', status: 'active' }),
    ],
  ]) {
    const denied = createFixture({ roles });
    await assert.rejects(
      denied.service.authorizeContentSettings(serverId, { accountId: targetAccountId }),
      (error: unknown) => error instanceof ForbiddenException || error instanceof ConflictException,
    );
  }
});

test('content-settings authority canonicalizes aliases and retains owner and global admin access', async () => {
  const manager = createFixture({
    roles: [role({ id: 10n, userId: 2n, role: 'manager', status: 'active' })],
  });
  const alias = manager.accounts.find((account) => account.id === aliasAccountId);
  assert.ok(alias);
  alias.canonicalAccountId = targetAccountId;
  assert.deepEqual(
    await manager.service.authorizeContentSettings(serverId, { accountId: aliasAccountId }),
    { accountId: targetAccountId, kind: 'manager' },
  );

  const owner = createFixture();
  assert.equal((await owner.service.authorizeContentSettings(serverId, ownerActor)).kind, 'owner');
  assert.equal((await owner.service.authorizeContentSettings(serverId, {
    accountId: targetAccountId,
    permissions: ['server.admin'],
  })).kind, 'server_admin');
});

test('content-settings authority fails closed on broken links and canonical account chains', async () => {
  for (const fixture of [
    createFixture({ mismatchedWiki: true }),
    createFixture({ mismatchedRootPage: true }),
  ]) {
    await assert.rejects(
      fixture.service.authorizeContentSettings(serverId, { accountId: targetAccountId }),
      ConflictException,
    );
  }

  for (const mode of ['missing', 'cycle'] as const) {
    const fixture = createFixture({
      roles: [role({ id: 10n, userId: 2n, role: 'manager', status: 'active' })],
    });
    const target = fixture.accounts.find((account) => account.id === targetAccountId);
    assert.ok(target);
    target.canonicalAccountId = mode === 'missing'
      ? 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
      : aliasAccountId;
    if (mode === 'cycle') {
      const alias = fixture.accounts.find((account) => account.id === aliasAccountId);
      assert.ok(alias);
      alias.canonicalAccountId = targetAccountId;
    }
    await assert.rejects(
      fixture.service.authorizeContentSettings(serverId, { accountId: targetAccountId }),
      (error: unknown) => error instanceof ForbiddenException || error instanceof ConflictException,
    );
  }
});

test('a linked alias session is compared through its canonical owner account', async () => {
  const fixture = createFixture();
  const result = await fixture.service.create(serverId, {
    username: 'Exact_User',
    role: 'editor',
    reason: '연결 계정 소유자 협업 추가',
  }, { accountId: aliasAccountId, permissions: [] });

  assert.equal(result.items[0]?.role, 'editor');
  assert.equal(fixture.audits[0]?.actorAccountId, ownerAccountId);
  assert.equal(fixture.audits[0]?.actorProfileId, 1n);
  assert.ok(fixture.lockQueries.some((query) => query.includes('FROM `Account`')));
});

test('create resolves an exact merged username to its canonical profile and reactivates history', async () => {
  const fixture = createFixture({
    roles: [
      role({ id: 10n, userId: 2n, role: 'reviewer', status: 'revoked', grantedBy: null }),
      role({ id: 11n, userId: 2n, role: 'maintainer', status: 'revoked', grantedBy: null }),
    ],
  });
  const result = await fixture.service.create(serverId, {
    username: 'Old_User',
    role: 'reviewer',
    reason: '  문서 검토 협업 요청  ',
  }, ownerActor);

  const reviewer = fixture.roles.find((item) => item.id === 10n);
  assert.equal(reviewer?.status, 'active');
  assert.equal(reviewer?.grantedBy, 1n);
  assert.equal(fixture.roles.find((item) => item.id === 11n)?.status, 'revoked');
  assert.equal(result.items[0]?.profileId, '2');
  assert.equal(result.items[0]?.username, 'Exact_User');
  assert.equal(fixture.audits.length, 1);
  assert.equal(fixture.audits[0]?.actorAccountId, ownerAccountId);
  assert.equal(fixture.audits[0]?.actorProfileId, 1n);
  assert.equal(fixture.audits[0]?.subjectId, '2');
  assert.deepEqual(fixture.audits[0]?.metadata, {
    serverId,
    serverWikiId: '88',
    spaceId: '77',
    targetProfileId: '2',
    targetUsername: 'Exact_User',
    previousRole: null,
    newRole: 'reviewer',
    reason: '문서 검토 협업 요청',
  });
  assert.ok(fixture.lockQueries.some((query) => query.includes('wiki_profile_aliases')));
  assert.ok(fixture.lockQueries.some((query) => query.includes('space_id = ? AND user_id = ?')));
});

test('assignments reject owner duplication and blocked, closed, detached, or non-canonical profiles', async () => {
  const cases = ['Blocked_User', 'Closed_User', 'Detached_User', 'Linked_Alias'];
  for (const username of cases) {
    const fixture = createFixture();
    await assert.rejects(
      fixture.service.create(serverId, { username, role: 'editor', reason: '편집 협업 요청' }, ownerActor),
      BadRequestException,
    );
    assert.equal(fixture.roles.length, 0);
    assert.equal(fixture.audits.length, 0);
  }

  const ownerFixture = createFixture();
  await assert.rejects(
    ownerFixture.service.create(serverId, { username: 'server_owner', role: 'editor', reason: '소유자 중복 요청' }, ownerActor),
    /중복 등록/u,
  );
  assert.equal(ownerFixture.roles.length, 0);
});

test('service validation rejects non-UUID IDs, owner roles, non-NFKC usernames, and unbounded reasons', async () => {
  const fixture = createFixture();
  await assert.rejects(
    fixture.service.list('not-a-uuid', ownerActor),
    BadRequestException,
  );
  await assert.rejects(
    fixture.service.create(serverId, { username: 'Ｅｘａｃｔ＿Ｕｓｅｒ', role: 'editor', reason: '편집 협업 요청' }, ownerActor),
    BadRequestException,
  );
  await assert.rejects(
    fixture.service.create(serverId, { username: 'Exact_User', role: 'owner' as never, reason: '소유자 역할 요청' }, ownerActor),
    BadRequestException,
  );
  await assert.rejects(
    fixture.service.create(serverId, { username: 'Exact_User', role: 'editor', reason: '짧음' }, ownerActor),
    BadRequestException,
  );
  await assert.rejects(
    fixture.service.update(serverId, '0', { role: 'reviewer', expectedRole: 'editor', reason: '검토 역할 변경' }, ownerActor),
    BadRequestException,
  );
});

test('role change rejects stale and no-op requests without audit or mutation', async () => {
  for (const input of [
    { role: 'reviewer' as const, expectedRole: 'manager' as const, reason: '오래된 역할 변경' },
    { role: 'editor' as const, expectedRole: 'editor' as const, reason: '동일 역할 변경 요청' },
  ]) {
    const fixture = createFixture({ roles: [role({ id: 10n, userId: 2n, role: 'editor', status: 'active' })] });
    await assert.rejects(
      fixture.service.update(serverId, '2', input, ownerActor),
      ConflictException,
    );
    assert.equal(fixture.roles[0]?.status, 'active');
    assert.equal(fixture.audits.length, 0);
  }
});

test('every mutation fails closed on active maintainer, trusted, or unknown legacy authority', async () => {
  for (const legacyRole of ['maintainer', 'trusted', 'custom_legacy']) {
    const fixture = createFixture({
      roles: [role({ id: 10n, userId: 2n, role: legacyRole, status: 'active' })],
    });
    await assert.rejects(
      fixture.service.create(serverId, {
        username: 'Exact_User',
        role: 'editor',
        reason: '레거시 권한 충돌 확인',
      }, ownerActor),
      ConflictException,
    );
    assert.equal(fixture.roles.length, 1);
    assert.equal(fixture.roles[0]?.status, 'active');
    assert.equal(fixture.audits.length, 0);
  }

  const updateFixture = createFixture({
    roles: [
      role({ id: 10n, userId: 2n, role: 'editor', status: 'active' }),
      role({ id: 11n, userId: 2n, role: 'maintainer', status: 'active' }),
    ],
  });
  await assert.rejects(
    updateFixture.service.update(serverId, '2', {
      role: 'reviewer', expectedRole: 'editor', reason: '레거시 중복 변경 차단',
    }, ownerActor),
    ConflictException,
  );
  assert.ok(updateFixture.roles.every((item) => item.status === 'active'));
  assert.equal(updateFixture.audits.length, 0);

  const removeFixture = createFixture({
    roles: [
      role({ id: 10n, userId: 2n, role: 'reviewer', status: 'active' }),
      role({ id: 11n, userId: 2n, role: 'trusted', status: 'active' }),
    ],
  });
  await assert.rejects(
    removeFixture.service.remove(serverId, '2', {
      expectedRole: 'reviewer', reason: '레거시 중복 회수 차단',
    }, ownerActor),
    ConflictException,
  );
  assert.ok(removeFixture.roles.every((item) => item.status === 'active'));
  assert.equal(removeFixture.audits.length, 0);
});

test('every mutation fails closed on duplicate active assignable rows', async () => {
  for (const operation of ['create', 'update', 'remove'] as const) {
    const fixture = createFixture({
      roles: [
        role({ id: 10n, userId: 2n, role: 'editor', status: 'active' }),
        role({ id: 11n, userId: 2n, role: 'reviewer', status: 'active' }),
      ],
    });
    const request = operation === 'create'
      ? fixture.service.create(serverId, {
          username: 'Exact_User', role: 'manager', reason: '중복 역할 추가 차단',
        }, ownerActor)
      : operation === 'update'
        ? fixture.service.update(serverId, '2', {
            role: 'manager', expectedRole: 'editor', reason: '중복 역할 변경 차단',
          }, ownerActor)
        : fixture.service.remove(serverId, '2', {
            expectedRole: 'editor', reason: '중복 역할 회수 차단',
          }, ownerActor);
    await assert.rejects(request, ConflictException);
    assert.ok(fixture.roles.every((item) => item.status === 'active'));
    assert.equal(fixture.audits.length, 0);
  }
});

test('role change revokes the prior row, activates one new row, audits both roles, and leaves legacy owner rows untouched', async () => {
  const fixture = createFixture({
    roles: [
      role({ id: 10n, userId: 2n, role: 'editor', status: 'active' }),
      role({ id: 11n, userId: 2n, role: 'reviewer', status: 'revoked' }),
      role({ id: 12n, userId: 9n, role: 'owner', status: 'active' }),
    ],
  });
  const result = await fixture.service.update(serverId, '2', {
    role: 'reviewer',
    expectedRole: 'editor',
    reason: '검토 전담 역할 변경',
  }, ownerActor);

  assert.equal(fixture.roles.find((item) => item.id === 10n)?.status, 'revoked');
  assert.equal(fixture.roles.find((item) => item.id === 11n)?.status, 'active');
  assert.equal(fixture.roles.find((item) => item.id === 12n)?.status, 'active');
  assert.equal(result.items[0]?.role, 'reviewer');
  assert.equal(result.items[0]?.expectedRole, 'reviewer');
  assert.equal(fixture.audits[0]?.action, 'server.wiki_collaborator.role_change');
  assert.deepEqual(fixture.audits[0]?.metadata, {
    serverId,
    serverWikiId: '88',
    spaceId: '77',
    targetProfileId: '2',
    targetUsername: 'Exact_User',
    previousRole: 'editor',
    newRole: 'reviewer',
    reason: '검토 전담 역할 변경',
  });
});

test('remove fails closed without mutating an active legacy owner row', async () => {
  const fixture = createFixture({
    roles: [
      role({ id: 10n, userId: 4n, role: 'reviewer', status: 'active' }),
      role({ id: 11n, userId: 4n, role: 'owner', status: 'active' }),
    ],
  });
  await assert.rejects(
    fixture.service.remove(serverId, '4', {
      expectedRole: 'reviewer',
      reason: '차단 사용자 권한 회수',
    }, ownerActor),
    ConflictException,
  );

  assert.equal(fixture.roles.find((item) => item.id === 10n)?.status, 'active');
  assert.equal(fixture.roles.find((item) => item.id === 11n)?.status, 'active');
  assert.equal(fixture.audits.length, 0);
});

test('remove still revokes one unambiguous assignable role from an invalidated member', async () => {
  const fixture = createFixture({
    roles: [role({ id: 10n, userId: 4n, role: 'reviewer', status: 'active' })],
  });
  const result = await fixture.service.remove(serverId, '4', {
    expectedRole: 'reviewer',
    reason: '차단 사용자 권한 회수',
  }, ownerActor);

  assert.equal(fixture.roles[0]?.status, 'revoked');
  assert.equal(result.items.length, 0);
  assert.equal(fixture.audits[0]?.action, 'server.wiki_collaborator.remove');
});

test('audit persistence failure rolls the role state back inside the transaction', async () => {
  const fixture = createFixture({
    failAudit: true,
    roles: [role({ id: 10n, userId: 2n, role: 'editor', status: 'active' })],
  });
  await assert.rejects(
    fixture.service.update(serverId, '2', {
      role: 'reviewer',
      expectedRole: 'editor',
      reason: '감사 실패 원자성 확인',
    }, ownerActor),
    /audit write failed/u,
  );
  assert.equal(fixture.roles.length, 1);
  assert.equal(fixture.roles[0]?.role, 'editor');
  assert.equal(fixture.roles[0]?.status, 'active');
  assert.equal(fixture.audits.length, 0);
});

test('mismatched server-wiki-space linkage fails closed before any role or audit mutation', async () => {
  const fixture = createFixture({ mismatchedWiki: true });
  await assert.rejects(
    fixture.service.create(serverId, { username: 'Exact_User', role: 'editor', reason: '편집 협업 요청' }, ownerActor),
    ConflictException,
  );
  assert.equal(fixture.roles.length, 0);
  assert.equal(fixture.audits.length, 0);
});

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('server wiki collaborator database integration', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const profiles = new WikiProfileService(prisma);
  const service = new ServerWikiCollaboratorService(prisma, profiles);

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  test('database integration preserves role history, optimistic concurrency, strict audit, and owner rows', async () => {
    const suffix = randomUUID().replace(/-/gu, '').slice(0, 12);
    const ownerId = randomUUID();
    const ownerAliasId = randomUUID();
    const collaboratorId = randomUUID();
    let ownerProfileId: bigint | null = null;
    let collaboratorProfileId: bigint | null = null;
    let spaceId: bigint | null = null;
    let createdServerId: string | null = null;

    try {
      await prisma.account.createMany({
        data: [
          {
            id: ownerId,
            canonicalAccountId: ownerId,
            provider: 'email',
            providerUserId: `collab-owner-${suffix}@example.com`,
            email: `collab-owner-${suffix}@example.com`,
            emailVerified: true,
          },
          {
            id: ownerAliasId,
            canonicalAccountId: ownerId,
            provider: 'naver',
            providerUserId: `collab-owner-alias-${suffix}`,
            emailVerified: true,
          },
          {
            id: collaboratorId,
            canonicalAccountId: collaboratorId,
            provider: 'discord',
            providerUserId: `collab-target-${suffix}`,
            emailVerified: true,
          },
        ],
      });
      const ownerProfile = await profiles.ensureWikiProfile(ownerId);
      const collaboratorProfile = await profiles.ensureWikiProfile(collaboratorId);
      ownerProfileId = ownerProfile.id;
      collaboratorProfileId = collaboratorProfile.id;
      const slug = `collab-${suffix}`;
      const space = await prisma.wikiSpace.create({
        data: {
          code: slug,
          spaceKey: slug,
          name: 'Collaborator integration wiki',
          slug,
          spaceType: 'server_wiki',
          rootPageId: 99n,
          rootNamespaceCode: 'server',
          rootPath: `/server/${slug}`,
          status: 'active',
          createdBy: ownerProfile.id,
          ownerUserId: ownerProfile.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      spaceId = space.id;
      const server = await prisma.server.create({
        data: {
          ownerAccountId: ownerId,
          wikiSpaceId: space.id,
          wikiPageId: 99n,
          wikiSlug: slug,
          name: `Collaborator ${suffix}`,
          joinHost: `${slug}.example.com`,
          joinPort: 25565,
          edition: 'java',
          supportedVersions: ['1.21'],
          tags: ['integration'],
          shortDescription: 'Collaborator integration test',
          longDescription: 'Disposable collaborator integration test server',
        },
      });
      createdServerId = server.id;
      await prisma.serverWiki.create({
        data: {
          spaceId: space.id,
          voteServerId: server.id,
          serverName: server.name,
          slug,
          status: 'active',
          createdBy: ownerProfile.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      await prisma.subwikiRole.createMany({
        data: [
          {
            spaceId: space.id,
            userId: ownerProfile.id,
            role: 'owner',
            status: 'active',
            grantedBy: ownerProfile.id,
            grantedAt: now,
          },
          {
            spaceId: space.id,
            userId: collaboratorProfile.id,
            role: 'reviewer',
            status: 'revoked',
            grantedBy: ownerProfile.id,
            grantedAt: now,
            revokedAt: now,
            revokedBy: ownerProfile.id,
          },
          {
            spaceId: space.id,
            userId: collaboratorProfile.id,
            role: 'trusted',
            status: 'active',
            grantedBy: ownerProfile.id,
            grantedAt: now,
          },
        ],
      });
      const actor = { accountId: ownerAliasId, permissions: [] };

      await assert.rejects(
        service.create(server.id, {
          username: collaboratorProfile.username,
          role: 'reviewer',
          reason: '레거시 권한 충돌 확인',
        }, actor),
        ConflictException,
      );
      const activeLegacy = await prisma.subwikiRole.findUnique({
        where: {
          spaceId_userId_role: {
            spaceId: space.id,
            userId: collaboratorProfile.id,
            role: 'trusted',
          },
        },
      });
      assert.equal(activeLegacy?.status, 'active');
      await prisma.subwikiRole.update({
        where: { id: activeLegacy!.id },
        data: { status: 'revoked', revokedAt: now, revokedBy: ownerProfile.id },
      });

      const added = await service.create(server.id, {
        username: collaboratorProfile.username,
        role: 'reviewer',
        reason: '통합 테스트 협업 추가',
      }, actor);
      assert.equal(added.items[0]?.role, 'reviewer');
      await assert.rejects(
        service.update(server.id, collaboratorProfile.id.toString(), {
          role: 'editor',
          expectedRole: 'manager',
          reason: '오래된 역할 변경 요청',
        }, actor),
        ConflictException,
      );
      const changed = await service.update(server.id, collaboratorProfile.id.toString(), {
        role: 'editor',
        expectedRole: 'reviewer',
        reason: '통합 테스트 역할 변경',
      }, actor);
      assert.equal(changed.items[0]?.role, 'editor');
      const removed = await service.remove(server.id, collaboratorProfile.id.toString(), {
        expectedRole: 'editor',
        reason: '통합 테스트 권한 회수',
      }, actor);
      assert.equal(removed.items.length, 0);

      const storedRoles = await prisma.subwikiRole.findMany({
        where: { spaceId: space.id },
        orderBy: { id: 'asc' },
      });
      assert.equal(storedRoles.find((item) => item.role === 'owner')?.status, 'active');
      assert.equal(storedRoles.find((item) => item.role === 'reviewer')?.status, 'revoked');
      assert.equal(storedRoles.find((item) => item.role === 'editor')?.status, 'revoked');
      assert.equal(storedRoles.find((item) => item.role === 'trusted')?.status, 'revoked');
      assert.equal(storedRoles.filter((item) => item.status === 'active' && ['manager', 'editor', 'reviewer'].includes(item.role)).length, 0);

      const auditRows = await prisma.auditEvent.findMany({
        where: {
          subjectType: 'server_wiki_collaborator',
          subjectId: collaboratorProfile.id.toString(),
          actorAccountId: ownerId,
        },
        orderBy: { createdAt: 'asc' },
      });
      assert.deepEqual(auditRows.map((item) => item.action), [
        'server.wiki_collaborator.add',
        'server.wiki_collaborator.role_change',
        'server.wiki_collaborator.remove',
      ]);
      assert.ok(auditRows.every((item) => item.actorProfileId === ownerProfile.id));
    } finally {
      if (collaboratorProfileId) {
        await prisma.auditEvent.deleteMany({
          where: { subjectType: 'server_wiki_collaborator', subjectId: collaboratorProfileId.toString() },
        });
      }
      if (spaceId) {
        await prisma.subwikiRole.deleteMany({ where: { spaceId } });
        await prisma.serverWiki.deleteMany({ where: { spaceId } });
      }
      if (createdServerId) await prisma.server.deleteMany({ where: { id: createdServerId } });
      if (spaceId) await prisma.wikiSpace.deleteMany({ where: { id: spaceId } });
      const profileIds = [ownerProfileId, collaboratorProfileId].filter((id): id is bigint => id !== null);
      if (profileIds.length > 0) await prisma.wikiProfile.deleteMany({ where: { id: { in: profileIds } } });
      await prisma.account.deleteMany({ where: { id: { in: [ownerId, ownerAliasId, collaboratorId] } } });
    }
  });
}
