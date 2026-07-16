import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaService } from '../common/prisma.service';
import { WikiAdminService } from './wiki-admin.service';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';

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
  revisionNo?: { lt?: number };
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
  const operations: string[] = [];
  const prisma = {
    async $transaction<T>(callback: (tx: typeof prisma) => Promise<T>) {
      return callback(prisma);
    },
    async $queryRaw() {
      operations.push('page:lock');
      return [{ id: page.id }];
    },
    wikiRecentChange: {
      async findMany() {
        return changes;
      },
      async create(args: { data: Record<string, unknown> }) {
        operations.push('recent:create');
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
        operations.push('page:update');
        assert.equal(args.where.id, page.id);
        Object.assign(page, args.data);
        return page;
      }
    },
    wikiNamespace: {
      async findUnique() {
        return { id: 1, code: 'main' };
      },
      async findMany() {
        return [{ id: 1, code: 'main' }];
      }
    },
    wikiProfile: {
      async findMany() {
        return [{ id: 1n, displayName: '테스트 편집자' }];
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
      async findMany(args: { where: RevisionWhere; take: number }) {
        return [...revisions.values()]
          .filter((revision) => revision.pageId === args.where.pageId && (args.where.revisionNo?.lt === undefined || revision.revisionNo < args.where.revisionNo.lt))
          .sort((left, right) => right.revisionNo - left.revisionNo)
          .slice(0, args.take);
      },
      async update(args: { where: { id: bigint }; data: Partial<TestRevision> }) {
        operations.push('revision:update');
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
    prisma: prisma as unknown as PrismaService,
    page,
    revisions,
    changes,
    renderCaches,
    operations
  };
}

test('wiki user block updates status and appends immutable history in one transaction', async () => {
  const now = new Date('2026-07-06T00:00:00.000Z');
  const profile = { id: 9n, accountId: null, username: 'user9', displayName: '사용자 9', status: 'active', createdAt: now, updatedAt: now };
  let eventData: Record<string, unknown> | null = null;
  const tx = {
    wikiProfile: {
      async findUnique() { return profile; },
      async updateMany(args: { data: { status: string; updatedAt: Date } }) {
        Object.assign(profile, args.data);
        return { count: 1 };
      }
    },
    accountRole: { async findMany() { return []; } },
    wikiUserBlockEvent: { async create(args: { data: Record<string, unknown> }) { eventData = args.data; return { id: 1n, ...args.data }; } }
  };
  const prisma = {
    wikiProfile: tx.wikiProfile,
    async $transaction(callback: (store: typeof tx) => unknown, options: { isolationLevel: string }) {
      assert.equal(options.isolationLevel, Prisma.TransactionIsolationLevel.Serializable);
      return callback(tx);
    }
  };
  const service = new WikiAdminService(prisma as unknown as PrismaService);

  const result = await service.setUserBlocked({ targetProfileId: '9', actorProfileId: 2n, blocked: true, reason: '반복적인 문서 훼손', publicReason: '문서 훼손이 반복되어 차단했습니다.' });
  assert.equal(result.status, 'blocked');
  assert.deepEqual(eventData && { action: eventData.action, previousStatus: eventData.previousStatus, newStatus: eventData.newStatus }, {
    action: 'block', previousStatus: 'active', newStatus: 'blocked'
  });
  assert.equal(eventData?.publicReason, '문서 훼손이 반복되어 차단했습니다.');
});

test('wiki user block applies atomically to every active profile in the canonical account group', async () => {
  const now = new Date('2026-07-06T00:00:00.000Z');
  const profiles = [
    { id: 9n, accountId: 'account-a', username: 'user-a', displayName: '사용자 A', status: 'active', mergedIntoProfileId: null, createdAt: now, updatedAt: now },
    { id: 10n, accountId: 'account-b', username: 'user-b', displayName: '사용자 B', status: 'active', mergedIntoProfileId: null, createdAt: now, updatedAt: now }
  ];
  const accounts = [
    { id: 'account-a', canonicalAccountId: null },
    { id: 'account-b', canonicalAccountId: 'account-a' }
  ];
  const eventTargets: bigint[] = [];
  const tx = {
    async $queryRaw() { return accounts.map((account) => ({ id: account.id })); },
    account: {
      async findMany() { return accounts; },
      async count() { return accounts.length; },
      async findUnique(args: { where: { id: string } }) { return accounts.find((account) => account.id === args.where.id) ?? null; }
    },
    accountLink: {
      async findMany() { return [{ primaryAccountId: 'account-a', linkedAccountId: 'account-b' }]; }
    },
    wikiProfile: {
      async findUnique(args: { where: { id: bigint } }) { return profiles.find((profile) => profile.id === args.where.id) ?? null; },
      async findMany() { return profiles; },
      async updateMany(args: { where: { id: { in: bigint[] }; status: string }; data: { status: string; updatedAt: Date } }) {
        const targets = profiles.filter((profile) => args.where.id.in.includes(profile.id) && profile.status === args.where.status);
        for (const profile of targets) Object.assign(profile, args.data);
        return { count: targets.length };
      }
    },
    accountRole: { async findMany() { return []; } },
    wikiUserBlockEvent: {
      async create(args: { data: { targetProfileId: bigint } }) { eventTargets.push(args.data.targetProfileId); return { id: BigInt(eventTargets.length), ...args.data }; }
    }
  };
  const prisma = { ...tx, async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); } };
  const service = new WikiAdminService(prisma as unknown as PrismaService);

  const result = await service.setUserBlocked({ targetProfileId: '10', actorProfileId: 2n, blocked: true, reason: '연결 계정 전체 훼손 차단' });

  assert.equal(result.status, 'blocked');
  assert.equal(result.canonicalAccountId, 'account-a');
  assert.deepEqual(result.linkedProfileIds.sort(), ['10', '9']);
  assert.ok(profiles.every((profile) => profile.status === 'blocked'));
  assert.deepEqual(new Set(eventTargets), new Set([9n, 10n]));
});

test('wiki user block keeps public reason optional and bounded', async () => {
  const service = new WikiAdminService({} as PrismaService);
  await assert.rejects(
    service.setUserBlocked({ targetProfileId: '9', actorProfileId: 2n, blocked: true, reason: '충분히 긴 내부 사유', publicReason: '짧음' }),
    BadRequestException
  );
  await assert.rejects(
    service.setUserBlocked({ targetProfileId: '9', actorProfileId: 2n, blocked: true, reason: '충분히 긴 내부 사유', publicReason: '가'.repeat(301) }),
    BadRequestException
  );
});

test('wiki user block rejects a concurrent status change without appending history', async () => {
  const now = new Date('2026-07-06T00:00:00.000Z');
  const profile = { id: 9n, accountId: null, username: 'user9', displayName: '사용자 9', status: 'active', createdAt: now, updatedAt: now };
  let eventCreated = false;
  const tx = {
    wikiProfile: {
      async findUnique() { return profile; },
      async updateMany() { return { count: 0 }; }
    },
    accountRole: { async findMany() { return []; } },
    wikiUserBlockEvent: { async create() { eventCreated = true; } }
  };
  const prisma = { wikiProfile: tx.wikiProfile, async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); } };
  const service = new WikiAdminService(prisma as unknown as PrismaService);

  await assert.rejects(
    service.setUserBlocked({ targetProfileId: '9', actorProfileId: 2n, blocked: true, reason: '반복적인 문서 훼손' }),
    ConflictException
  );
  assert.equal(eventCreated, false);
});

test('wiki user block checks protected roles inside the status transaction', async () => {
  const now = new Date('2026-07-06T00:00:00.000Z');
  const profile = { id: 9n, accountId: 'account-9', username: 'admin9', displayName: '관리자 9', status: 'active', createdAt: now, updatedAt: now };
  let changed = false;
  const tx = {
    async $queryRaw() { return [{ id: 'account-9' }]; },
    account: {
      async findMany() { return [{ id: 'account-9', canonicalAccountId: null }]; },
      async count() { return 1; },
      async findUnique() { return { id: 'account-9', canonicalAccountId: null }; }
    },
    accountLink: { async findMany() { return []; } },
    wikiProfile: {
      async findUnique() { return profile; },
      async findMany() { return [profile]; },
      async updateMany() { changed = true; return { count: 1 }; }
    },
    accountRole: { async findMany() { return [{ role: { code: 'admin' } }]; } },
    wikiUserBlockEvent: { async create() { throw new Error('must not create'); } }
  };
  const prisma = { ...tx, async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); } };
  const service = new WikiAdminService(prisma as unknown as PrismaService);

  await assert.rejects(
    service.setUserBlocked({ targetProfileId: '9', actorProfileId: 2n, blocked: true, reason: '반복적인 문서 훼손' }),
    BadRequestException
  );
  assert.equal(changed, false);
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

test('wiki admin revision listing includes hidden revisions and uses a stable revision cursor', async () => {
  const { service, revisions } = createService();
  const hidden = revisions.get(101n);
  assert.ok(hidden);
  hidden.visibility = 'hidden';

  const first = await service.getPageRevisions('10', undefined, '1');
  assert.equal(first.items.length, 1);
  assert.equal(first.items[0].visibility, 'hidden');
  assert.equal(first.items[0].createdByName, '테스트 편집자');
  assert.equal(first.nextCursor, '2');

  const second = await service.getPageRevisions('10', first.nextCursor ?? undefined, '1');
  assert.deepEqual(second.items.map((revision) => revision.revisionNo), [1]);
  assert.equal(second.nextCursor, null);
});

test('wiki admin revision detail returns raw content with the canonical route path', async () => {
  const fixture = createService();
  const routePaths = {
    async preload() {
      return {
        namespace() { return 'server'; },
        routePath() { return '/server/soul-online/대문'; }
      };
    }
  };
  const service = new WikiAdminService(
    fixture.prisma,
    undefined,
    undefined,
    routePaths as never
  );

  const detail = await service.getRevision('101');
  assert.equal(detail.contentRaw, '두 번째 내용');
  assert.equal(detail.page.namespaceCode, 'server');
  assert.equal(detail.page.routePath, '/server/soul-online/대문');
});

test('wiki admin service hides current revision and falls back to previous public revision', async () => {
  const { service, page, revisions, changes, operations } = createService();

  const result = await service.updateRevisionVisibility({
    revisionId: '101',
    visibility: 'hidden',
    actorProfileId: 99n,
    reason: '테스트 숨김 처리'
  });

  assert.equal(result.visibility, 'hidden');
  assert.equal(revisions.get(101n)?.visibility, 'hidden');
  assert.equal(page.currentRevisionId, 100n);
  assert.equal(changes.at(-1)?.changeType, 'revision_visibility');
  assert.ok(operations.indexOf('page:lock') < operations.indexOf('revision:update'));
  assert.ok(operations.indexOf('revision:update') < operations.indexOf('page:update'));
  assert.ok(operations.indexOf('page:update') < operations.indexOf('recent:create'));
});

test('wiki admin hides a page when its sole public revision is hidden', async () => {
  const { service, page, revisions } = createService();
  revisions.get(100n)!.visibility = 'hidden';

  await service.updateRevisionVisibility({
    revisionId: '101', visibility: 'hidden', actorProfileId: 99n, reason: '법적 요청으로 전체 숨김'
  });

  assert.equal(page.currentRevisionId, null);
  assert.equal(page.status, 'hidden');
});

test('wiki admin promotes a restored newer public revision back to current', async () => {
  const { service, page, revisions } = createService();
  page.currentRevisionId = 100n;
  revisions.get(101n)!.visibility = 'hidden';

  await service.updateRevisionVisibility({
    revisionId: '101', visibility: 'public', actorProfileId: 99n, reason: '검토 완료 후 공개 복구'
  });

  assert.equal(page.currentRevisionId, 101n);
  assert.equal(page.status, 'normal');
});

test('wiki admin refuses to restore a page without a public revision', async () => {
  const { service, page, revisions } = createService();
  page.status = 'deleted';
  revisions.get(100n)!.visibility = 'hidden';
  revisions.get(101n)!.visibility = 'hidden';

  await assert.rejects(
    service.setPageStatus({ pageId: '10', status: 'normal', actorProfileId: 99n, reason: '복구 시도' }),
    ConflictException
  );
  assert.equal(page.status, 'deleted');
});

test('wiki admin visibility change never overwrites a newer current revision', async () => {
  const { service, page, revisions, operations } = createService();
  page.currentRevisionId = 999n;

  await service.updateRevisionVisibility({
    revisionId: '101',
    visibility: 'hidden',
    actorProfileId: 99n,
    reason: '신규 현재판 보존'
  });

  assert.equal(revisions.get(101n)?.visibility, 'hidden');
  assert.equal(page.currentRevisionId, 999n);
  assert.equal(operations.includes('page:update'), false);
});

test('wiki admin revision mutations require an auditable moderation reason', async () => {
  const { service } = createService();
  await assert.rejects(
    service.updateRevisionVisibility({
      revisionId: '101',
      visibility: 'hidden',
      actorProfileId: 99n,
      reason: '  '
    }),
    BadRequestException
  );
  await assert.rejects(
    service.rollback({ pageId: '10', revisionId: '100', actorProfileId: 99n, reason: 'four' }),
    BadRequestException
  );
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

function createEditSummaryModerationFixture(options: { failAudit?: boolean } = {}) {
  const now = new Date('2026-07-17T00:00:00.000Z');
  const page = {
    id: 10n, namespaceId: 1, spaceId: 20n, localPath: '대문', slug: '대문', title: '대문', displayTitle: '대문',
    currentRevisionId: 101n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 1n,
    createdAt: now, updatedAt: now
  };
  const revision = {
    id: 101n, pageId: 10n, revisionNo: 2, parentRevisionId: 100n,
    contentRaw: '변경하지 말아야 할 원문', contentAst: { type: 'root' }, contentHash: 'b'.repeat(64), contentSize: 32,
    syntaxVersion: 'bwm-0.3', editSummary: '보존할 원본 요약', editSummaryHidden: false,
    editSummaryModerationVersion: 0, editSummaryModeratedBy: null as bigint | null,
    editSummaryModeratedAt: null as Date | null, editSummaryModerationReason: null as string | null,
    isMinor: false, editTags: { source: 'test' }, createdBy: 1n, actorUserId: 1n, createdAt: now, visibility: 'public'
  };
  const recentChanges = [{ id: 1n, revisionId: 101n, summary: '보존할 원본 요약' }];
  const renderCaches = [{ id: 1n, pageId: 10n, revisionId: 101n, html: '<p>cached</p>' }];
  const audits: Array<Record<string, unknown>> = [];
  const isolationLevels: string[] = [];
  let transactionCount = 0;
  const tx = {
    wikiPageRevision: {
      async findUnique(args: { where: { id: bigint } }) {
        return args.where.id === revision.id ? revision : null;
      },
      async updateMany(args: {
        where: { id: bigint; editSummaryHidden: boolean; editSummaryModerationVersion: number };
        data: {
          editSummaryHidden: boolean;
          editSummaryModerationVersion: { increment: number };
          editSummaryModeratedBy: bigint;
          editSummaryModeratedAt: Date;
          editSummaryModerationReason: string;
        };
      }) {
        if (
          args.where.id !== revision.id
          || args.where.editSummaryHidden !== revision.editSummaryHidden
          || args.where.editSummaryModerationVersion !== revision.editSummaryModerationVersion
        ) return { count: 0 };
        revision.editSummaryHidden = args.data.editSummaryHidden;
        revision.editSummaryModerationVersion += args.data.editSummaryModerationVersion.increment;
        revision.editSummaryModeratedBy = args.data.editSummaryModeratedBy;
        revision.editSummaryModeratedAt = args.data.editSummaryModeratedAt;
        revision.editSummaryModerationReason = args.data.editSummaryModerationReason;
        return { count: 1 };
      }
    },
    auditEvent: {
      async create(args: { data: Record<string, unknown> }) {
        if (options.failAudit) throw new Error('audit write failed');
        audits.push(args.data);
        return args.data;
      }
    }
  };
  const prisma = {
    wikiPageRevision: tx.wikiPageRevision,
    wikiPage: { async findUnique() { return page; } },
    wikiNamespace: { async findMany() { return [{ id: 1, code: 'main' }]; } },
    wikiProfile: {
      async findMany() {
        return [{ id: 1n, displayName: '편집자' }, { id: 99n, displayName: '요약 관리자' }];
      }
    },
    async $transaction<T>(callback: (store: typeof tx) => Promise<T>, config: { isolationLevel: string }) {
      transactionCount += 1;
      isolationLevels.push(config.isolationLevel);
      const beforeRevision = { ...revision };
      const beforeAudits = audits.length;
      try {
        return await callback(tx);
      } catch (error) {
        Object.assign(revision, beforeRevision);
        audits.splice(beforeAudits);
        throw error;
      }
    }
  };
  return {
    service: new WikiAdminService(prisma as unknown as PrismaService),
    revision, page, recentChanges, renderCaches, audits, isolationLevels,
    transactionCount: () => transactionCount
  };
}

test('edit-summary hide and restore preserve revision content, pointers, visibility, rollback source, and render cache', async () => {
  const fixture = createEditSummaryModerationFixture();
  const immutableRevision = {
    editSummary: fixture.revision.editSummary,
    contentRaw: fixture.revision.contentRaw,
    contentAst: fixture.revision.contentAst,
    contentHash: fixture.revision.contentHash,
    contentSize: fixture.revision.contentSize,
    parentRevisionId: fixture.revision.parentRevisionId,
    visibility: fixture.revision.visibility
  };
  const pointer = fixture.page.currentRevisionId;
  const recentSnapshot = structuredClone(fixture.recentChanges);
  const cacheSnapshot = structuredClone(fixture.renderCaches);

  const hidden = await fixture.service.setRevisionEditSummaryHidden({
    revisionId: '101', hidden: true, expectedVersion: 0, actorProfileId: 99n, reason: '  개인정보가 포함된 요약  '
  });

  assert.equal(hidden.editSummaryHidden, true);
  assert.equal(hidden.editSummaryModerationVersion, 1);
  assert.equal(fixture.revision.editSummary, '보존할 원본 요약');
  assert.deepEqual({
    editSummary: fixture.revision.editSummary,
    contentRaw: fixture.revision.contentRaw,
    contentAst: fixture.revision.contentAst,
    contentHash: fixture.revision.contentHash,
    contentSize: fixture.revision.contentSize,
    parentRevisionId: fixture.revision.parentRevisionId,
    visibility: fixture.revision.visibility
  }, immutableRevision);
  assert.equal(fixture.page.currentRevisionId, pointer);
  assert.deepEqual(fixture.recentChanges, recentSnapshot);
  assert.deepEqual(fixture.renderCaches, cacheSnapshot);
  assert.deepEqual(fixture.isolationLevels, [Prisma.TransactionIsolationLevel.Serializable]);
  assert.equal(fixture.audits[0]?.action, 'wiki.revision_edit_summary.hide');
  assert.deepEqual((fixture.audits[0]?.metadata as Record<string, unknown>)?.originalEditSummary, '보존할 원본 요약');
  assert.deepEqual((fixture.audits[0]?.metadata as Record<string, unknown>)?.reason, '개인정보가 포함된 요약');

  const restored = await fixture.service.setRevisionEditSummaryHidden({
    revisionId: '101', hidden: false, expectedVersion: 1, actorProfileId: 99n, reason: '검토 완료 후 요약 복원'
  });
  assert.equal(restored.editSummaryHidden, false);
  assert.equal(restored.editSummaryModerationVersion, 2);
  assert.equal(fixture.revision.editSummary, '보존할 원본 요약');
  assert.equal(fixture.page.currentRevisionId, pointer);
  assert.deepEqual(fixture.recentChanges, recentSnapshot);
  assert.deepEqual(fixture.renderCaches, cacheSnapshot);
  assert.equal(fixture.audits[1]?.action, 'wiki.revision_edit_summary.restore');
});

test('edit-summary moderation rejects stale concurrent versions without a second audit', async () => {
  const fixture = createEditSummaryModerationFixture();
  await fixture.service.setRevisionEditSummaryHidden({
    revisionId: '101', hidden: true, expectedVersion: 0, actorProfileId: 99n, reason: '첫 번째 숨김 처리'
  });

  await assert.rejects(
    fixture.service.setRevisionEditSummaryHidden({
      revisionId: '101', hidden: false, expectedVersion: 0, actorProfileId: 99n, reason: '오래된 화면에서 복원'
    }),
    ConflictException
  );
  assert.equal(fixture.revision.editSummaryHidden, true);
  assert.equal(fixture.revision.editSummaryModerationVersion, 1);
  assert.equal(fixture.audits.length, 1);
});

test('edit-summary moderation rolls back the state change when durable audit persistence fails', async () => {
  const fixture = createEditSummaryModerationFixture({ failAudit: true });
  await assert.rejects(
    fixture.service.setRevisionEditSummaryHidden({
      revisionId: '101', hidden: true, expectedVersion: 0, actorProfileId: 99n, reason: '감사 실패 원자성 확인'
    }),
    /audit write failed/u
  );
  assert.equal(fixture.revision.editSummaryHidden, false);
  assert.equal(fixture.revision.editSummaryModerationVersion, 0);
  assert.equal(fixture.revision.editSummaryModeratedBy, null);
  assert.equal(fixture.audits.length, 0);
});

test('edit-summary moderation requires a bounded reason and explicit optimistic version', async () => {
  const fixture = createEditSummaryModerationFixture();
  for (const input of [
    { hidden: true, expectedVersion: 0, reason: '짧음' },
    { hidden: true, expectedVersion: 0, reason: '가'.repeat(501) },
    { hidden: true, expectedVersion: undefined, reason: '충분히 긴 사유' }
  ]) {
    await assert.rejects(
      fixture.service.setRevisionEditSummaryHidden({ revisionId: '101', actorProfileId: 99n, ...input }),
      BadRequestException
    );
  }
  assert.equal(fixture.transactionCount(), 0);
});

test('privileged revision detail exposes original summary and latest moderator metadata', async () => {
  const fixture = createEditSummaryModerationFixture();
  await fixture.service.setRevisionEditSummaryHidden({
    revisionId: '101', hidden: true, expectedVersion: 0, actorProfileId: 99n, reason: '관리자 상세 표시 확인'
  });
  const detail = await fixture.service.getRevision('101');
  assert.equal(detail.editSummary, '보존할 원본 요약');
  assert.equal(detail.editSummaryHidden, true);
  assert.equal(detail.editSummaryModerationVersion, 1);
  assert.equal(detail.editSummaryModeration?.action, 'hidden');
  assert.equal(detail.editSummaryModeration?.moderatorProfileId, '99');
  assert.equal(detail.editSummaryModeration?.moderatorName, '요약 관리자');
  assert.equal(detail.editSummaryModeration?.reason, '관리자 상세 표시 확인');
});
