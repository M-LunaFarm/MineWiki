import assert from 'node:assert/strict';
import test from 'node:test';
import type { ServerWikiLayoutEntitlement } from '@prisma/client';
import { BadRequestException } from '@nestjs/common';
import { ServerWikiLayoutEntitlementLifecycleService } from './server-wiki-layout-entitlement-lifecycle.service';

const now = new Date('2026-07-17T00:00:00.000Z');

function entitlement(id: bigint, input: Partial<ServerWikiLayoutEntitlement> = {}): ServerWikiLayoutEntitlement {
  return {
    id,
    serverWikiId: input.serverWikiId ?? 88n,
    layoutKey: input.layoutKey ?? 'brand',
    status: input.status ?? 'active',
    source: input.source ?? 'manual',
    externalReference: input.externalReference ?? `invoice-${id}`,
    startsAt: input.startsAt ?? new Date('2026-07-01T00:00:00.000Z'),
    expiresAt: input.expiresAt ?? new Date('2026-07-16T00:00:00.000Z'),
    createdBy: input.createdBy ?? 7n,
    createdAt: input.createdAt ?? new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: input.updatedAt ?? new Date('2026-07-01T00:00:00.000Z'),
  };
}

function createFixture(input: {
  readonly entitlements: ServerWikiLayoutEntitlement[];
  readonly selectedLayout?: string;
}) {
  const entitlements = input.entitlements.map((row) => ({ ...row }));
  const serverWiki = { id: 88n, voteServerId: '11111111-1111-4111-8111-111111111111', layoutKey: input.selectedLayout ?? 'brand' };
  const audits: Array<Record<string, unknown>> = [];
  const lockQueries: string[] = [];
  const tx = {
    async $queryRaw(strings: TemplateStringsArray) {
      lockQueries.push(strings.join('?').replace(/\s+/gu, ' ').trim());
      return [];
    },
    serverWikiLayoutEntitlement: {
      async findUnique(args: { where: { id: bigint } }) {
        return entitlements.find((row) => row.id === args.where.id) ?? null;
      },
      async findMany(args: { where: { serverWikiId: bigint } }) {
        return entitlements.filter((row) => row.serverWikiId === args.where.serverWikiId).map((row) => ({ ...row }));
      },
      async update(args: { where: { id: bigint }; data: { status: string } }) {
        const row = entitlements.find((candidate) => candidate.id === args.where.id);
        assert.ok(row);
        row.status = args.data.status;
        row.updatedAt = now;
        return { ...row };
      },
    },
    serverWiki: {
      async findUnique(args: { where: { id: bigint } }) {
        return args.where.id === serverWiki.id ? { ...serverWiki } : null;
      },
      async update(args: { where: { id: bigint }; data: { layoutKey: string } }) {
        assert.equal(args.where.id, serverWiki.id);
        serverWiki.layoutKey = args.data.layoutKey;
        return { ...serverWiki };
      },
    },
    auditEvent: {
      async create(args: { data: Record<string, unknown> }) {
        audits.push(args.data);
        return args.data;
      },
    },
  };
  const prisma = {
    serverWikiLayoutEntitlement: {
      async findMany(args: { where: { status: string; expiresAt: { lte: Date } }; take: number }) {
        return entitlements
          .filter((row) => row.status === args.where.status && row.expiresAt !== null && row.expiresAt <= args.where.expiresAt.lte)
          .slice(0, args.take)
          .map((row) => ({ id: row.id }));
      },
    },
    async $transaction(operation: (store: typeof tx) => Promise<unknown>) {
      return operation(tx);
    },
  };
  return {
    service: new ServerWikiLayoutEntitlementLifecycleService(prisma as never),
    entitlements,
    serverWiki,
    audits,
    lockQueries,
  };
}

test('expiry reconciliation marks due entitlements and downgrades an uncovered selected layout', async () => {
  const fixture = createFixture({ entitlements: [entitlement(1n)] });

  const result = await fixture.service.processDue(100, now);

  assert.deepEqual(result, { examined: 1, expired: 1, downgraded: 1, skipped: 0, failed: 0 });
  assert.equal(fixture.entitlements[0]?.status, 'expired');
  assert.equal(fixture.serverWiki.layoutKey, 'docs');
  assert.equal(fixture.audits[0]?.action, 'billing.entitlement.expired');
  assert.equal(fixture.audits[0]?.actorAccountId, null);
  assert.ok(fixture.lockQueries.some((query) => query.includes('server_wiki_layout_entitlements') && query.includes('FOR UPDATE')));
  assert.ok(fixture.lockQueries.some((query) => query.includes('server_wikis') && query.includes('FOR UPDATE')));
});

test('expiry reconciliation preserves the selected layout when another current entitlement covers it', async () => {
  const fixture = createFixture({
    entitlements: [
      entitlement(1n),
      entitlement(2n, { expiresAt: new Date('2026-08-01T00:00:00.000Z') }),
    ],
  });

  const result = await fixture.service.processDue(100, now);

  assert.deepEqual(result, { examined: 1, expired: 1, downgraded: 0, skipped: 0, failed: 0 });
  assert.equal(fixture.serverWiki.layoutKey, 'brand');
});

test('expiry reconciliation is idempotent after a due row has already transitioned', async () => {
  const fixture = createFixture({ entitlements: [entitlement(1n)] });

  await fixture.service.processDue(100, now);
  const replay = await fixture.service.processDue(100, now);

  assert.deepEqual(replay, { examined: 0, expired: 0, downgraded: 0, skipped: 0, failed: 0 });
  assert.equal(fixture.audits.length, 1);
});

test('expiry reconciliation rejects unbounded batch sizes before querying', async () => {
  const fixture = createFixture({ entitlements: [] });

  await assert.rejects(() => fixture.service.processDue(0, now), BadRequestException);
  await assert.rejects(() => fixture.service.processDue(101, now), BadRequestException);
  await assert.rejects(() => fixture.service.processDue(Number.NaN, now), BadRequestException);
});
