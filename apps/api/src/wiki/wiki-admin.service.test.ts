import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../common/prisma.service';
import { WikiAdminService } from './wiki-admin.service';
import { BadRequestException } from '@nestjs/common';

interface TestRevision {
  id: bigint;
  pageId: bigint;
  revisionNo: number;
  contentRaw: string;
  visibility: string;
  [key: string]: unknown;
}

interface TestRecentChange extends Record<string, unknown> {
  changeType?: string;
  summary?: string;
}

interface RevisionWhere {
  pageId?: bigint;
  visibility?: string;
  id?: { not?: bigint };
}

function createService() {
  const now = new Date('2026-07-06T00:00:00.000Z');
  const page = {
    id: 10n,
    namespaceId: 1,
    spaceId: 20n,
    localPath: '대문',
    slug: '대문',
    title: '대문',
    displayTitle: '대문',
    currentRevisionId: 101n,
    pageType: 'article',
    protectionLevel: 'open',
    status: 'normal',
    createdBy: 1n,
    createdAt: now,
    updatedAt: now
  };
  const revisions = new Map<bigint, TestRevision>([
    [100n, {
      id: 100n,
      pageId: 10n,
      revisionNo: 1,
      parentRevisionId: null,
      contentRaw: '처음 내용',
      contentAst: null,
      contentHash: 'a'.repeat(64),
      contentSize: 13,
      syntaxVersion: 'bwm-0.3',
      editSummary: '처음',
      isMinor: false,
      createdBy: 1n,
      actorUserId: 1n,
      createdAt: now,
      visibility: 'public'
    }],
    [101n, {
      id: 101n,
      pageId: 10n,
      revisionNo: 2,
      parentRevisionId: 100n,
      contentRaw: '두 번째 내용',
      contentAst: null,
      contentHash: 'b'.repeat(64),
      contentSize: 17,
      syntaxVersion: 'bwm-0.3',
      editSummary: '수정',
      isMinor: false,
      createdBy: 1n,
      actorUserId: 1n,
      createdAt: now,
      visibility: 'public'
    }]
  ]);
  const changes: TestRecentChange[] = [];
  const renderCaches: Array<Record<string, unknown>> = [];
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) {
      return callback(prisma);
    },
    async $queryRaw() {
      return [{ id: page.id }];
    },
    wikiRecentChange: {
      async findMany() {
        return changes;
      },
      async create(args: { data: Record<string, unknown> }) {
        changes.push({ id: BigInt(changes.length + 1), ...args.data });
        return changes[changes.length - 1];
      }
    },
    wikiPage: {
      async findMany() {
        return [page];
      },
      async findUnique(args: { where: { id: bigint } }) {
        return args.where.id === page.id ? page : null;
      },
      async update(args: { where: { id: bigint }; data: Record<string, unknown> }) {
        assert.equal(args.where.id, page.id);
        Object.assign(page, args.data);
        return page;
      }
    },
    wikiNamespace: {
      async findUnique() {
        return { id: 1, code: 'main' };
      }
    },
    wikiPageRevision: {
      async findUnique(args: { where: { id: bigint } }) {
        return revisions.get(args.where.id) ?? null;
      },
      async findFirst(args: { where: RevisionWhere; orderBy?: Array<Record<string, string>> }) {
        const list = [...revisions.values()].filter((revision) => {
          if (args.where.pageId !== undefined && revision.pageId !== args.where.pageId) return false;
          if (args.where.visibility !== undefined && revision.visibility !== args.where.visibility) return false;
          if (args.where.id?.not !== undefined && revision.id === args.where.id.not) return false;
          return true;
        });
        if (args.orderBy?.[0]?.revisionNo === 'asc') {
          list.sort((left, right) => left.revisionNo - right.revisionNo);
        } else {
          list.sort((left, right) => right.revisionNo - left.revisionNo);
        }
        return list[0] ?? null;
      },
      async update(args: { where: { id: bigint }; data: Partial<TestRevision> }) {
        const revision = revisions.get(args.where.id);
        assert.ok(revision);
        Object.assign(revision, args.data);
        return revision;
      },
      async create(args: { data: Record<string, unknown> }) {
        const revision = { id: 102n, ...args.data } as TestRevision;
        revisions.set(revision.id, revision);
        return revision;
      }
    },
    wikiPageRenderCache: {
      async create(args: { data: Record<string, unknown> }) {
        renderCaches.push(args.data);
        return { id: BigInt(renderCaches.length), ...args.data };
      }
    }
  };
  return {
    service: new WikiAdminService(prisma as unknown as PrismaService),
    page,
    revisions,
    changes,
    renderCaches
  };
}

test('wiki user block updates status and appends immutable history in one transaction', async () => {
  const now = new Date('2026-07-06T00:00:00.000Z');
  const profile = { id: 9n, accountId: 'account-9', username: 'user9', displayName: '사용자 9', status: 'active', createdAt: now, updatedAt: now };
  let eventData: Record<string, unknown> | null = null;
  const tx = {
    wikiProfile: { async update(args: { data: { status: string; updatedAt: Date } }) { Object.assign(profile, args.data); return profile; } },
    wikiUserBlockEvent: { async create(args: { data: Record<string, unknown> }) { eventData = args.data; return { id: 1n, ...args.data }; } }
  };
  const prisma = {
    wikiProfile: { async findUnique() { return profile; } },
    accountRole: { async findMany() { return []; } },
    async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); }
  };
  const service = new WikiAdminService(prisma as unknown as PrismaService);

  const result = await service.setUserBlocked({ targetProfileId: '9', actorProfileId: 2n, blocked: true, reason: '반복적인 문서 훼손' });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(eventData && { action: eventData.action, previousStatus: eventData.previousStatus, newStatus: eventData.newStatus }, {
    action: 'block', previousStatus: 'active', newStatus: 'blocked'
  });
});

test('wiki user block rejects self-targeting before data access', async () => {
  const service = new WikiAdminService({} as PrismaService);
  await assert.rejects(
    service.setUserBlocked({ targetProfileId: '2', actorProfileId: 2n, blocked: true, reason: '충분히 긴 사유' }),
    BadRequestException
  );
});

test('wiki admin service updates page protection and records recent change', async () => {
  const { service, page, changes } = createService();

  const updated = await service.updateProtection({
    pageId: '10',
    protectionLevel: 'locked',
    actorProfileId: 99n,
    reason: '반달 대응'
  });

  assert.equal(updated.protectionLevel, 'locked');
  assert.equal(page.protectionLevel, 'locked');
  assert.equal(changes.at(-1)?.changeType, 'protect');
  assert.equal(changes.at(-1)?.summary, '반달 대응');
});

test('wiki admin service hides current revision and falls back to previous public revision', async () => {
  const { service, page, revisions, changes } = createService();

  const result = await service.updateRevisionVisibility({
    revisionId: '101',
    visibility: 'hidden',
    actorProfileId: 99n
  });

  assert.equal(result.visibility, 'hidden');
  assert.equal(revisions.get(101n)?.visibility, 'hidden');
  assert.equal(page.currentRevisionId, 100n);
  assert.equal(changes.at(-1)?.changeType, 'revision_visibility');
});

test('wiki admin service rollback creates new public revision and render cache', async () => {
  const { service, page, revisions, renderCaches, changes } = createService();

  const result = await service.rollback({
    pageId: '10',
    revisionId: '100',
    actorProfileId: 99n,
    reason: '관리자 복구'
  });

  assert.equal(result.revisionNo, 3);
  assert.equal(page.currentRevisionId, 102n);
  assert.equal(revisions.get(102n)?.contentRaw, '처음 내용');
  assert.equal(renderCaches.length, 1);
  assert.equal(changes.at(-1)?.changeType, 'rollback');
});

test('wiki admin rollback does not persist viewer-dependent include HTML', async () => {
  const { service, revisions, renderCaches } = createService();
  const source = revisions.get(100n);
  assert.ok(source);
  source.contentRaw = '[include(틀:권한별 안내)]';

  await service.rollback({
    pageId: '10',
    revisionId: '100',
    actorProfileId: 99n,
    reason: 'include 복구'
  });

  assert.equal(renderCaches.length, 0);
});
