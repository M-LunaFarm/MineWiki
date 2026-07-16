import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ServerService } from './server.service';

const serverId = '11111111-1111-4111-8111-111111111111';
const actorAccountId = '22222222-2222-4222-8222-222222222222';

interface FixtureOptions {
  readonly linked?: boolean;
  readonly inconsistent?: boolean;
  readonly failAudit?: boolean;
  readonly ownershipChanged?: boolean;
}

function createFixture(options: FixtureOptions = {}) {
  const operations: string[] = [];
  const server = {
    id: serverId,
    ownerAccountId: options.ownershipChanged
      ? '33333333-3333-4333-8333-333333333333'
      : actorAccountId,
    registrantAccountId: null,
    wikiSpaceId: options.linked ? 77n : null,
    wikiPageId: options.linked ? 78n : null,
    wikiSlug: options.linked ? 'owned-wiki' : null,
  };
  const linkedWiki = {
    id: 88n,
    voteServerId: serverId,
    spaceId: options.inconsistent ? 999n : 77n,
    slug: 'owned-wiki',
    status: 'active',
  };
  const tx = {
    async $queryRaw() {
      operations.push('lock');
      return [];
    },
    server: {
      async findUnique() {
        operations.push('read-server');
        return server;
      },
      async findMany() {
        operations.push('check-competing-servers');
        return [];
      },
      async delete(input: unknown) {
        operations.push('delete-server');
        assert.deepEqual(input, { where: { id: serverId } });
        return server;
      },
    },
    serverWiki: {
      async findMany() {
        operations.push('read-linked-wiki');
        return options.linked ? [linkedWiki] : [];
      },
      async updateMany(input: unknown) {
        operations.push('archive-unlink-wiki');
        assert.deepEqual(input, {
          where: { id: 88n, voteServerId: serverId, status: 'active' },
          data: { voteServerId: null, status: 'archived', updatedAt: new Date('2026-07-17T00:00:00.000Z') },
        });
        return { count: 1 };
      },
    },
    wikiSpace: {
      async findUnique() {
        operations.push('read-space');
        return { id: 77n, slug: 'owned-wiki', spaceType: 'server_wiki', status: 'active' };
      },
      async updateMany(input: unknown) {
        operations.push('archive-space');
        assert.deepEqual(input, {
          where: { id: 77n, status: 'active' },
          data: { status: 'archived', updatedAt: new Date('2026-07-17T00:00:00.000Z') },
        });
        return { count: 1 };
      },
    },
    subwikiRole: {
      async count() {
        operations.push('count-owner-memberships');
        return 1;
      },
      async updateMany(input: unknown) {
        operations.push('revoke-collaborators');
        assert.deepEqual(input, {
          where: { spaceId: 77n, status: 'active', role: { not: 'owner' } },
          data: {
            status: 'revoked',
            revokedAt: new Date('2026-07-17T00:00:00.000Z'),
            revokedBy: 7n,
          },
        });
        return { count: 3 };
      },
    },
    wikiProfile: {
      async findUnique() {
        operations.push('read-actor-profile');
        return { id: 7n };
      },
    },
    pluginServer: {
      async updateMany(input: unknown) {
        operations.push('disable-credentials');
        assert.deepEqual(input, {
          where: { serverId, enabled: true },
          data: { enabled: false },
        });
        return { count: 2 };
      },
    },
    auditEvent: {
      async create(input: { data: Record<string, unknown> }) {
        operations.push('audit');
        if (options.failAudit) throw new Error('audit unavailable');
        assert.equal(input.data.action, 'server.deleted');
        assert.equal(input.data.actorAccountId, actorAccountId);
        assert.deepEqual(input.data.metadata, {
          disabledPluginCredentials: 2,
          archivedServerWikiId: options.linked ? '88' : null,
          archivedWikiSpaceId: options.linked ? '77' : null,
          revokedCollaboratorMemberships: options.linked ? 3 : 0,
          preservedOwnerMemberships: options.linked ? 1 : 0,
        });
        return { id: 'audit-1' };
      },
    },
  };
  const prisma = {
    async $transaction<T>(operation: (client: typeof tx) => Promise<T>, transactionOptions: { isolationLevel?: string }) {
      operations.push('transaction');
      assert.equal(transactionOptions.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      const originalDate = Date;
      class FixedDate extends Date {
        constructor(value?: string | number | Date) {
          super(value ?? '2026-07-17T00:00:00.000Z');
        }
      }
      Object.assign(globalThis, { Date: FixedDate });
      try {
        return await operation(tx);
      } finally {
        Object.assign(globalThis, { Date: originalDate });
      }
    },
  };
  const service = new ServerService({} as never, prisma as never, {} as never);
  return { service, operations };
}

test('server removal atomically archives its linked wiki, revokes non-owner roles, audits, and deletes', async () => {
  const { service, operations } = createFixture({ linked: true });

  await service.remove(serverId, actorAccountId);

  assert.equal(operations[0], 'transaction');
  assert.ok(operations.indexOf('archive-unlink-wiki') < operations.indexOf('audit'));
  assert.ok(operations.indexOf('revoke-collaborators') < operations.indexOf('audit'));
  assert.ok(operations.indexOf('audit') < operations.indexOf('delete-server'));
});

test('server removal without a wiki keeps credential disable, strict audit, and delete in one transaction', async () => {
  const { service, operations } = createFixture();

  await service.remove(serverId, actorAccountId);

  assert.equal(operations.includes('archive-unlink-wiki'), false);
  assert.equal(operations.includes('revoke-collaborators'), false);
  assert.ok(operations.indexOf('disable-credentials') < operations.indexOf('audit'));
  assert.ok(operations.indexOf('audit') < operations.indexOf('delete-server'));
});

test('server removal fails closed on inconsistent wiki linkage before any mutation', async () => {
  const { service, operations } = createFixture({ linked: true, inconsistent: true });

  await assert.rejects(() => service.remove(serverId, actorAccountId), ConflictException);

  assert.equal(operations.includes('archive-unlink-wiki'), false);
  assert.equal(operations.includes('revoke-collaborators'), false);
  assert.equal(operations.includes('disable-credentials'), false);
  assert.equal(operations.includes('delete-server'), false);
  assert.equal(operations.includes('audit'), false);
});

test('server removal rechecks actor authority after locking the server', async () => {
  const { service, operations } = createFixture({ linked: true, ownershipChanged: true });

  await assert.rejects(
    () => service.remove(serverId, actorAccountId),
    /제거할 권한이 없습니다/u,
  );

  assert.equal(operations.includes('read-linked-wiki'), false);
  assert.equal(operations.includes('archive-unlink-wiki'), false);
  assert.equal(operations.includes('disable-credentials'), false);
  assert.equal(operations.includes('audit'), false);
  assert.equal(operations.includes('delete-server'), false);
});

test('server removal propagates transactional audit failure and never reaches delete', async () => {
  const { service, operations } = createFixture({ linked: true, failAudit: true });

  await assert.rejects(() => service.remove(serverId, actorAccountId), /audit unavailable/u);

  assert.equal(operations.includes('audit'), true);
  assert.equal(operations.includes('delete-server'), false);
});
