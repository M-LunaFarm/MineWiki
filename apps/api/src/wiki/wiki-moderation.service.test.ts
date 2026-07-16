import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import type { PrismaService } from '../common/prisma.service';
import type { WikiLinkIndexService } from './wiki-link-index.service';
import { WikiModerationService } from './wiki-moderation.service';
import type { WikiNotificationService } from './wiki-notification.service';

const now = new Date();

interface TestRevision {
  id: bigint;
  pageId: bigint;
  revisionNo: number;
  parentRevisionId: bigint | null;
  contentRaw: string;
  contentAst: null;
  contentHash: string;
  contentSize: number;
  syntaxVersion: string;
  editSummary: string | null;
  isMinor: boolean;
  editTags: unknown;
  createdBy: bigint;
  actorType: string;
  actorUserId: bigint;
  actorIp: null;
  actorIpText: null;
  actorIpHash: null;
  createdAt: Date;
  visibility: string;
}

function revision(id: number, pageId: number, revisionNo: number, createdBy: number, visibility = 'public'): TestRevision {
  return {
    id: BigInt(id), pageId: BigInt(pageId), revisionNo,
    parentRevisionId: revisionNo > 1 ? BigInt(id - 1) : null,
    contentRaw: `내용 ${id}`, contentAst: null, contentHash: 'a'.repeat(64), contentSize: 8,
    syntaxVersion: 'bwm-0.3', editSummary: null, isMinor: false, editTags: null,
    createdBy: BigInt(createdBy), actorType: 'user', actorUserId: BigInt(createdBy),
    actorIp: null, actorIpText: null, actorIpHash: null, createdAt: now, visibility
  };
}

function fixture(options: { failLinks?: boolean; targetStatus?: string } = {}) {
  const lockQueries: string[] = [];
  const state = {
    target: {
      id: 9n, accountId: 'target-account', username: 'target_user',
      displayName: '대상 사용자', status: options.targetStatus ?? 'blocked', createdAt: now, updatedAt: now
    },
    pages: [
      { id: 1n, namespaceId: 1, displayTitle: '문서 1', title: '문서 1', localPath: '문서-1', status: 'normal', currentRevisionId: 3n, updatedAt: now },
      { id: 2n, namespaceId: 1, displayTitle: '문서 2', title: '문서 2', localPath: '문서-2', status: 'normal', currentRevisionId: 5n, updatedAt: now },
      { id: 3n, namespaceId: 1, displayTitle: '문서 3', title: '문서 3', localPath: '문서-3', status: 'normal', currentRevisionId: 8n, updatedAt: now },
      { id: 4n, namespaceId: 1, displayTitle: '문서 4', title: '문서 4', localPath: '문서-4', status: 'normal', currentRevisionId: 10n, updatedAt: now }
    ],
    revisions: [
      revision(1, 1, 1, 1), revision(2, 1, 2, 9), revision(3, 1, 3, 9),
      revision(4, 2, 1, 9), revision(5, 2, 2, 1),
      revision(6, 3, 1, 9), revision(7, 3, 2, 1), revision(8, 3, 3, 9), revision(9, 3, 4, 9, 'hidden'),
      revision(10, 4, 1, 9)
    ] as TestRevision[],
    renderCaches: [] as unknown[],
    recentChanges: [] as unknown[]
  };
  const store = {
    async $transaction<T>(callback: (tx: typeof store) => Promise<T>) {
      const snapshot = structuredClone(state);
      try {
        return await callback(store);
      } catch (error) {
        state.target = snapshot.target;
        state.pages = snapshot.pages;
        state.revisions = snapshot.revisions;
        state.renderCaches = snapshot.renderCaches;
        state.recentChanges = snapshot.recentChanges;
        throw error;
      }
    },
    async $queryRaw(strings: TemplateStringsArray) { lockQueries.push(strings.join('?')); return []; },
    wikiProfile: { async findUnique() { return state.target; } },
    accountRole: { async findMany() { return []; } },
    wikiNamespace: { async findUnique() { return { id: 1, code: 'main' }; } },
    wikiPage: {
      async findUnique(args: { where: { id: bigint } }) { return state.pages.find((page) => page.id === args.where.id) ?? null; },
      async update(args: { where: { id: bigint }; data: Record<string, unknown> }) {
        const page = state.pages.find((entry) => entry.id === args.where.id);
        assert.ok(page); Object.assign(page, args.data); return page;
      }
    },
    wikiPageRevision: {
      async groupBy() {
        return [...new Set(state.revisions.filter((entry) => entry.createdBy === 9n && entry.visibility === 'public').map((entry) => entry.pageId))]
          .map((pageId) => ({ pageId, _max: { createdAt: now } }));
      },
      async findUnique(args: { where: { id: bigint } }) { return state.revisions.find((entry) => entry.id === args.where.id) ?? null; },
      async findMany(args: { where: { pageId: bigint; visibility?: string; revisionNo?: { lte: number } }; take?: number }) {
        return state.revisions
          .filter((entry) => entry.pageId === args.where.pageId)
          .filter((entry) => !args.where.visibility || entry.visibility === args.where.visibility)
          .filter((entry) => !args.where.revisionNo || entry.revisionNo <= args.where.revisionNo.lte)
          .sort((left, right) => right.revisionNo - left.revisionNo)
          .slice(0, args.take);
      },
      async findFirst(args: { where: { pageId: bigint }; orderBy: Array<{ revisionNo: string }> }) {
        return state.revisions.filter((entry) => entry.pageId === args.where.pageId)
          .sort((left, right) => right.revisionNo - left.revisionNo)[0] ?? null;
      },
      async updateMany(args: { where: { id: { in: bigint[] }; pageId: bigint; visibility: string; createdBy: bigint }; data: { visibility: string } }) {
        const rows = state.revisions.filter((entry) => args.where.id.in.includes(entry.id) && entry.pageId === args.where.pageId && entry.visibility === args.where.visibility && entry.createdBy === args.where.createdBy);
        rows.forEach((entry) => { entry.visibility = args.data.visibility; });
        return { count: rows.length };
      },
      async create(args: { data: Omit<TestRevision, 'id'> }) {
        const row = { id: BigInt(Math.max(...state.revisions.map((entry) => Number(entry.id))) + 1), ...args.data } as TestRevision;
        state.revisions.push(row); return row;
      }
    },
    wikiPageRenderCache: { async create(args: { data: unknown }) { state.renderCaches.push(args.data); } },
    wikiRecentChange: { async create(args: { data: unknown }) { state.recentChanges.push(args.data); } }
  };
  let linkCalls = 0;
  const links = {
    async replaceForRevision() {
      linkCalls += 1;
      if (options.failLinks) throw new Error('link index failed');
    }
  } as unknown as WikiLinkIndexService;
  let notificationCalls = 0;
  const notifications = {
    async notifyWatchedRevision() { notificationCalls += 1; }
  } as unknown as WikiNotificationService;
  return {
    state,
    service: new WikiModerationService(store as unknown as PrismaService, links, notifications),
    linkCalls: () => linkCalls,
    notificationCalls: () => notificationCalls,
    lockQueries
  };
}

test('batch rollback preview only removes the current target suffix and preserves normal edits', async () => {
  const { service } = fixture();
  const preview = await service.preview({ targetProfileId: '9', sinceMinutes: 60, limit: 25 });
  const byPage = new Map(preview.candidates.map((candidate) => [candidate.pageId, candidate]));

  assert.deepEqual(byPage.get('1')?.affectedRevisionIds, ['3', '2']);
  assert.equal(byPage.get('1')?.rollbackToRevisionId, '1');
  assert.equal(byPage.get('2')?.skipReason, 'newer_non_target_revision');
  assert.deepEqual(byPage.get('3')?.affectedRevisionIds, ['8']);
  assert.equal(byPage.get('3')?.rollbackToRevisionId, '7');
  assert.equal(byPage.get('4')?.skipReason, 'no_safe_base');
});

test('batch rollback requires a blocked target and exact username confirmation', async () => {
  const active = fixture({ targetStatus: 'active' }).service;
  await assert.rejects(
    active.execute({ targetProfileId: '9', sinceMinutes: 60, reason: '반복적인 문서 훼손', confirmUsername: 'target_user', candidates: [{ pageId: '1', expectedCurrentRevisionId: '3' }], actorProfileId: 2n }),
    ConflictException
  );
  const blocked = fixture().service;
  await assert.rejects(
    blocked.execute({ targetProfileId: '9', sinceMinutes: 60, reason: '반복적인 문서 훼손', confirmUsername: 'wrong', candidates: [{ pageId: '1', expectedCurrentRevisionId: '3' }], actorProfileId: 2n }),
    BadRequestException
  );
});

test('batch rollback hides the target suffix and appends an attributed recovery revision', async () => {
  const { service, state, linkCalls, notificationCalls, lockQueries } = fixture();
  const response = await service.execute({
    targetProfileId: '9', sinceMinutes: 60, reason: '반복적인 문서 훼손', confirmUsername: 'target_user',
    candidates: [{ pageId: '1', expectedCurrentRevisionId: '3' }], actorProfileId: 2n
  });

  assert.equal(response.results[0]?.status, 'rolled_back');
  assert.equal(state.revisions.find((entry) => entry.id === 2n)?.visibility, 'hidden');
  assert.equal(state.revisions.find((entry) => entry.id === 3n)?.visibility, 'hidden');
  const recovery = state.revisions.at(-1)!;
  assert.equal(recovery.revisionNo, 4);
  assert.equal(recovery.parentRevisionId, 3n);
  assert.equal(recovery.createdBy, 2n);
  assert.equal((recovery.editTags as { batchRollback: boolean }).batchRollback, true);
  assert.equal(state.pages[0]?.currentRevisionId, recovery.id);
  assert.equal(linkCalls(), 1);
  assert.equal(notificationCalls(), 1);
  assert.ok(lockQueries.some((query) => query.includes('FROM users')));
  assert.equal(lockQueries.some((query) => query.includes('wiki_profiles')), false);
});

test('batch rollback skips a page whose current revision changed after preview', async () => {
  const { service, state } = fixture();
  state.pages[0]!.currentRevisionId = 1n;
  const response = await service.execute({
    targetProfileId: '9', sinceMinutes: 60, reason: '반복적인 문서 훼손', confirmUsername: 'target_user',
    candidates: [{ pageId: '1', expectedCurrentRevisionId: '3' }], actorProfileId: 2n
  });
  assert.equal(response.results[0]?.status, 'skipped');
  assert.equal(response.results[0]?.reason, 'current_changed');
  assert.equal(state.revisions.filter((entry) => entry.pageId === 1n).length, 3);
});

test('batch rollback rolls back all page mutations when link indexing fails', async () => {
  const { service, state } = fixture({ failLinks: true });
  const response = await service.execute({
    targetProfileId: '9', sinceMinutes: 60, reason: '반복적인 문서 훼손', confirmUsername: 'target_user',
    candidates: [{ pageId: '1', expectedCurrentRevisionId: '3' }], actorProfileId: 2n
  });
  assert.equal(response.results[0]?.status, 'failed');
  assert.equal(state.revisions.find((entry) => entry.id === 2n)?.visibility, 'public');
  assert.equal(state.revisions.find((entry) => entry.id === 3n)?.visibility, 'public');
  assert.equal(state.pages[0]?.currentRevisionId, 3n);
  assert.equal(state.revisions.filter((entry) => entry.pageId === 1n).length, 3);
});
