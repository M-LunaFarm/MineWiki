import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { Prisma, type ServerWikiLayoutEntitlement } from '@prisma/client';
import { ServerWikiLayoutEntitlementAdminService } from './server-wiki-layout-entitlement-admin.service';

const serverId = '11111111-1111-4111-8111-111111111111';
const actorAccountId = '22222222-2222-4222-8222-222222222222';
const createdAt = new Date('2026-07-17T00:00:00.000Z');

interface FixtureOptions {
  readonly entitlements?: ServerWikiLayoutEntitlement[];
  readonly selectedLayout?: string;
  readonly missingServer?: boolean;
  readonly missingWiki?: boolean;
  readonly mismatchedWiki?: boolean;
}

function entitlement(
  id: bigint,
  input: Partial<ServerWikiLayoutEntitlement> = {},
): ServerWikiLayoutEntitlement {
  return {
    id,
    serverWikiId: input.serverWikiId ?? 88n,
    layoutKey: input.layoutKey ?? 'brand',
    status: input.status ?? 'active',
    source: input.source ?? 'manual',
    externalReference: input.externalReference ?? `invoice-${id}`,
    startsAt: input.startsAt ?? new Date('2026-07-01T00:00:00.000Z'),
    expiresAt: input.expiresAt ?? new Date('2027-07-01T00:00:00.000Z'),
    createdBy: input.createdBy ?? 7n,
    createdAt: input.createdAt ?? createdAt,
    updatedAt: input.updatedAt ?? createdAt,
  };
}

function createFixture(options: FixtureOptions = {}) {
  const entitlements = (options.entitlements ?? []).map((row) => ({ ...row }));
  const audits: Array<Record<string, unknown>> = [];
  const lockQueries: string[] = [];
  const isolationLevels: string[] = [];
  const server = {
    id: serverId,
    wikiSpaceId: 77n,
    wikiSlug: 'test-server',
  };
  const serverWiki = {
    id: 88n,
    spaceId: options.mismatchedWiki ? 79n : 77n,
    slug: 'test-server',
    status: 'active',
    layoutKey: options.selectedLayout ?? 'brand',
  };
  let nextId = entitlements.reduce((highest, row) => row.id > highest ? row.id : highest, 0n) + 1n;

  const tx = {
    async $queryRaw(strings: TemplateStringsArray) {
      lockQueries.push(strings.join('?').replace(/\s+/gu, ' ').trim());
      return [];
    },
    server: {
      async findUnique(args: { where: { id: string } }) {
        if (options.missingServer || args.where.id !== server.id) return null;
        return { ...server };
      },
    },
    serverWiki: {
      async findUnique(args: { where: { voteServerId?: string; id?: bigint } }) {
        if (options.missingWiki) return null;
        if (args.where.voteServerId && args.where.voteServerId !== server.id) return null;
        if (args.where.id && args.where.id !== serverWiki.id) return null;
        return { ...serverWiki };
      },
      async update(args: { where: { id: bigint }; data: { layoutKey: string } }) {
        assert.equal(args.where.id, serverWiki.id);
        serverWiki.layoutKey = args.data.layoutKey;
        return { ...serverWiki };
      },
    },
    wikiProfile: {
      async findUnique() {
        return { id: 7n };
      },
    },
    serverWikiLayoutEntitlement: {
      async findMany(args: {
        where: { serverWikiId: bigint; id?: { lt: bigint } };
        orderBy: { id: 'asc' | 'desc' };
        take?: number;
      }) {
        let rows = entitlements
          .filter((row) => row.serverWikiId === args.where.serverWikiId)
          .filter((row) => args.where.id === undefined || row.id < args.where.id.lt)
          .sort((left, right) => Number(left.id - right.id));
        if (args.orderBy.id === 'desc') rows = rows.reverse();
        return rows.slice(0, args.take ?? rows.length).map((row) => ({ ...row }));
      },
      async findUnique(args: { where: { externalReference: string } }) {
        return entitlements.find((row) => row.externalReference === args.where.externalReference) ?? null;
      },
      async create(args: {
        data: Omit<ServerWikiLayoutEntitlement, 'id' | 'createdAt' | 'updatedAt'>;
      }) {
        const row: ServerWikiLayoutEntitlement = {
          id: nextId,
          ...args.data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        nextId += 1n;
        entitlements.push(row);
        return { ...row };
      },
      async update(args: {
        where: { id: bigint };
        data: Partial<Pick<ServerWikiLayoutEntitlement, 'expiresAt' | 'status'>>;
      }) {
        const row = entitlements.find((candidate) => candidate.id === args.where.id);
        assert.ok(row);
        Object.assign(row, args.data, { updatedAt: new Date() });
        return { ...row };
      },
    },
    auditEvent: {
      async create(args: { data: Record<string, unknown> }) {
        audits.push(args.data);
        return args.data;
      },
      async findFirst(args: {
        where: { action: string; subjectType: string; subjectId: string };
      }) {
        return audits.find((row) => (
          row.action === args.where.action
          && row.subjectType === args.where.subjectType
          && row.subjectId === args.where.subjectId
        )) ?? null;
      },
    },
  };
  const prisma = {
    ...tx,
    async $transaction<T>(
      operation: (store: typeof tx) => Promise<T>,
      config: { isolationLevel: string },
    ) {
      isolationLevels.push(config.isolationLevel);
      return operation(tx);
    },
  };
  const service = new ServerWikiLayoutEntitlementAdminService(prisma as never);
  return { service, entitlements, audits, lockQueries, isolationLevels, serverWiki };
}

test('history is server-scoped, newest-first, cursor bounded, and checks server/wiki existence', async () => {
  const fixture = createFixture({
    entitlements: [entitlement(1n), entitlement(2n), entitlement(3n)],
  });

  const page = await fixture.service.list(serverId, { limit: 2 });
  assert.deepEqual(page.items.map((item) => item.id), ['3', '2']);
  assert.equal(page.nextCursor, '2');
  const tail = await fixture.service.list(serverId, { limit: 2, before: page.nextCursor! });
  assert.deepEqual(tail.items.map((item) => item.id), ['1']);
  assert.equal(tail.nextCursor, null);

  await assert.rejects(
    () => createFixture({ missingServer: true }).service.list(serverId),
    NotFoundException,
  );
  await assert.rejects(
    () => createFixture({ missingWiki: true }).service.list(serverId),
    NotFoundException,
  );
  await assert.rejects(
    () => createFixture({ mismatchedWiki: true }).service.list(serverId),
    ConflictException,
  );
});

test('grant locks and writes entitlement plus immutable old/new audit in one serializable transaction', async () => {
  const fixture = createFixture();
  const input = {
    layoutKey: 'handbook' as const,
    startsAt: '2026-07-17T00:00:00.000Z',
    expiresAt: '2027-07-17T00:00:00.000Z',
    source: 'manual',
    externalRef: 'invoice-41',
    reason: 'annual premium layout grant',
  };

  const created = await fixture.service.grant(serverId, input, actorAccountId);

  assert.equal(created.layoutKey, 'handbook');
  assert.equal(created.externalRef, 'invoice-41');
  assert.deepEqual(fixture.isolationLevels, [Prisma.TransactionIsolationLevel.Serializable]);
  assert.ok(fixture.lockQueries.some((query) => query.includes('`Server`') && query.includes('FOR UPDATE')));
  assert.ok(fixture.lockQueries.some((query) => query.includes('server_wikis') && query.includes('FOR UPDATE')));
  assert.ok(fixture.lockQueries.some((query) => query.includes('server_wiki_layout_entitlements') && query.includes('FOR UPDATE')));
  assert.equal(fixture.audits[0]?.action, 'billing.entitlement.granted');
  assert.equal(fixture.audits[0]?.actorAccountId, actorAccountId);
  const metadata = fixture.audits[0]?.metadata as Record<string, unknown>;
  assert.equal(metadata.serverId, serverId);
  assert.equal(metadata.oldValue, null);
  assert.equal(metadata.reason, input.reason);

  const replayed = await fixture.service.grant(serverId, input, actorAccountId);
  assert.equal(replayed.id, created.id);
  assert.equal(fixture.entitlements.length, 1);
  assert.equal(fixture.audits.length, 1);

  await assert.rejects(
    () => fixture.service.grant(serverId, { ...input, layoutKey: 'brand' }, actorAccountId),
    ConflictException,
  );
  await assert.rejects(
    () => fixture.service.grant(serverId, { ...input, externalRef: 'paddle:sandbox:subscription:sub_fake' }, actorAccountId),
    /reserved billing provider prefix/,
  );
});

test('manual administration cannot extend or revoke provider-owned Paddle entitlements', async () => {
  const paddle = entitlement(1n, {
    source: 'paddle',
    externalReference: 'paddle:sandbox:subscription:sub_test',
    expiresAt: null,
  });
  const fixture = createFixture({ entitlements: [paddle] });
  await assert.rejects(
    () => fixture.service.extend(serverId, '1', {
      expiresAt: '2028-07-01T00:00:00.000Z',
      reason: 'manual override forbidden',
    }, actorAccountId),
    /managed only by verified billing events/,
  );
  await assert.rejects(
    () => fixture.service.revoke(serverId, '1', { reason: 'manual override forbidden' }, actorAccountId),
    /managed only by verified billing events/,
  );
});

test('grant and extend enforce premium layouts, bounded dates, increasing expiry, and active state', async () => {
  const fixture = createFixture({ entitlements: [entitlement(1n)] });
  await assert.rejects(
    () => fixture.service.grant(serverId, {
      layoutKey: 'docs' as never,
      startsAt: '2026-07-17T00:00:00.000Z',
      expiresAt: '2027-07-17T00:00:00.000Z',
      source: 'manual',
      reason: 'invalid free layout grant',
    }, actorAccountId),
    BadRequestException,
  );
  await assert.rejects(
    () => fixture.service.extend(serverId, '1', {
      expiresAt: '2027-01-01T00:00:00.000Z',
      reason: 'expiry must move forward',
    }, actorAccountId),
    BadRequestException,
  );

  const extended = await fixture.service.extend(serverId, '1', {
    expiresAt: '2028-07-01T00:00:00.000Z',
    reason: 'annual renewal approved',
  }, actorAccountId);
  assert.equal(extended.expiresAt, '2028-07-01T00:00:00.000Z');
  assert.equal(fixture.audits[0]?.action, 'billing.entitlement.extended');
  const metadata = fixture.audits[0]?.metadata as Record<string, unknown>;
  assert.notDeepEqual(metadata.oldValue, metadata.newValue);

  fixture.entitlements[0]!.status = 'revoked';
  await assert.rejects(
    () => fixture.service.extend(serverId, '1', {
      expiresAt: '2029-07-01T00:00:00.000Z',
      reason: 'revoked entitlement renewal',
    }, actorAccountId),
    ConflictException,
  );
});

test('revoke keeps a selected premium layout while another active entitlement remains, then downgrades to docs', async () => {
  const fixture = createFixture({
    selectedLayout: 'brand',
    entitlements: [
      entitlement(1n, { externalReference: 'invoice-1' }),
      entitlement(2n, { externalReference: 'invoice-2' }),
    ],
  });

  const first = await fixture.service.revoke(serverId, '1', {
    reason: 'first contract was cancelled',
  }, actorAccountId);
  assert.equal(first.status, 'revoked');
  assert.equal(fixture.serverWiki.layoutKey, 'brand');

  await fixture.service.revoke(serverId, '2', {
    reason: 'final contract was cancelled',
  }, actorAccountId);
  assert.equal(fixture.serverWiki.layoutKey, 'docs');
  assert.deepEqual(fixture.audits.map((row) => row.action), [
    'billing.entitlement.revoked',
    'billing.entitlement.revoked',
  ]);
  const finalMetadata = fixture.audits[1]?.metadata as Record<string, unknown>;
  assert.equal((finalMetadata.newValue as Record<string, unknown>).selectedLayout, 'docs');
});

test('mutations reject an entitlement from another server wiki and malformed bounded identifiers', async () => {
  const fixture = createFixture({
    entitlements: [entitlement(1n, { serverWikiId: 999n })],
  });
  await assert.rejects(
    () => fixture.service.revoke(serverId, '1', { reason: 'wrong server entitlement' }, actorAccountId),
    NotFoundException,
  );
  await assert.rejects(
    () => fixture.service.revoke(serverId, '0', { reason: 'invalid identifier rejected' }, actorAccountId),
    BadRequestException,
  );
  await assert.rejects(
    () => fixture.service.list('not-a-uuid'),
    BadRequestException,
  );
});
