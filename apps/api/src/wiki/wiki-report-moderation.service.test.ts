import assert from 'node:assert/strict';
import test from 'node:test';
import { ConflictException } from '@nestjs/common';
import type { SessionPayload } from '../session/session.service';
import { WikiReportModerationService } from './wiki-report-moderation.service';

const caseId = '11111111-1111-4111-8111-111111111111';
const now = new Date('2026-07-16T12:00:00.000Z');
const moderatorSession: SessionPayload = {
  sessionId: 'session-1',
  userId: 'account-1',
  tokenVersion: 1,
  isElevated: true,
  authenticatedAt: now.toISOString(),
  permissions: ['wiki.report.moderate'],
  groups: [],
};

test('assignment and lifecycle transitions use optimistic versions and close the active key', async () => {
  const store = moderationStore();
  const service = createModerationService(store);

  const assigned = await service.assign(caseId, moderatorSession, 1);
  assert.equal(assigned.status, 'in_review');
  assert.equal(assigned.assigneeProfileId, '7');
  assert.equal(assigned.version, 2);

  await assert.rejects(
    () => service.transition(caseId, moderatorSession, {
      expectedVersion: 1, status: 'resolved', resolution: '정책 위반을 확인했습니다.',
    }),
    (error: unknown) => error instanceof ConflictException && /version changed/i.test(error.message),
  );

  const resolved = await service.transition(caseId, moderatorSession, {
    expectedVersion: 2, status: 'resolved', resolution: '정책 위반을 확인했습니다.',
  });
  assert.equal(resolved.status, 'resolved');
  assert.equal(resolved.version, 3);
  assert.equal(store.reportCase.activeKey, null);
  assert.equal(store.auditActions.at(-1), 'wiki.report.resolved');

  await assert.rejects(
    () => service.assign(caseId, moderatorSession, 3),
    (error: unknown) => error instanceof ConflictException && /final/i.test(error.message),
  );
});

test('audit persistence failures roll back assignment and finalization state', async () => {
  const assignmentStore = moderationStore();
  assignmentStore.failAudit = true;
  await assert.rejects(
    () => createModerationService(assignmentStore).assign(caseId, moderatorSession, 1),
    /audit unavailable/u,
  );
  assert.equal(assignmentStore.reportCase.status, 'open');
  assert.equal(assignmentStore.reportCase.assigneeProfileId, null);
  assert.equal(assignmentStore.reportCase.version, 1);

  const transitionStore = moderationStore();
  transitionStore.reportCase.status = 'in_review';
  transitionStore.reportCase.assigneeProfileId = 7n;
  transitionStore.reportCase.assignedAt = now;
  transitionStore.failAudit = true;
  await assert.rejects(
    () => createModerationService(transitionStore).transition(caseId, moderatorSession, {
      expectedVersion: 1,
      status: 'resolved',
      resolution: '정책 위반을 확인했습니다.',
    }),
    /audit unavailable/u,
  );
  assert.equal(transitionStore.reportCase.status, 'in_review');
  assert.equal(transitionStore.reportCase.activeKey, 'page:10');
  assert.equal(transitionStore.reportCase.version, 1);
  assert.equal(transitionStore.reportCase.resolution, null);
});

test('queue reads are bounded and use a stable creation-time keyset cursor', async () => {
  const store = moderationStore();
  const service = createModerationService(store);
  store.queueRows = [
    queueCase('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', new Date('2026-07-16T11:00:00.000Z')),
    queueCase('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', new Date('2026-07-16T10:00:00.000Z')),
    queueCase('cccccccc-cccc-4ccc-8ccc-cccccccccccc', new Date('2026-07-16T09:00:00.000Z')),
  ];

  const first = await service.listQueue(moderatorSession, { limit: 2 });
  assert.equal(first.items.length, 2);
  assert.ok(first.nextCursor);
  assert.equal(store.lastFindMany?.take, 3);
  assert.deepEqual(store.lastFindMany?.orderBy, [{ createdAt: 'desc' }, { id: 'desc' }]);

  await service.listQueue(moderatorSession, { limit: 2, cursor: first.nextCursor ?? undefined });
  assert.ok(store.lastFindMany?.where.AND);
});

function moderationStore() {
  const reportCase = queueCase(caseId, now);
  const auditActions: string[] = [];
  const store: {
    reportCase: ReturnType<typeof queueCase>;
    auditActions: string[];
    failAudit: boolean;
    queueRows: Array<ReturnType<typeof queueCase>>;
    lastFindMany?: { where: { AND?: unknown }; orderBy: unknown; take: number };
    wikiReportCase: {
      findUnique(input: { where: { id: string } }): Promise<ReturnType<typeof queueCase> | null>;
      updateMany(input: { where: { id: string; version: number; status: string }; data: Record<string, unknown> }): Promise<{ count: number }>;
      findMany(input: { where: { AND?: unknown }; orderBy: unknown; take: number }): Promise<Array<ReturnType<typeof queueCase>>>;
    };
    wikiProfile: { findUnique(): Promise<{ accountId: string; status: string }> };
    auditEvent: { create(input: { data: { action: string } }): Promise<{ id: string }> };
    $transaction<T>(callback: (tx: typeof store) => Promise<T>): Promise<T>;
  } = {
    reportCase,
    auditActions,
    failAudit: false,
    queueRows: [],
    wikiReportCase: {
      async findUnique() { return { ...store.reportCase, submissions: [...store.reportCase.submissions] }; },
      async updateMany(input) {
        if (input.where.version !== store.reportCase.version || input.where.status !== store.reportCase.status) return { count: 0 };
        const data = input.data;
        for (const [key, value] of Object.entries(data)) {
          if (key === 'version' && typeof value === 'object' && value && 'increment' in value) {
            store.reportCase.version += Number((value as { increment: number }).increment);
          } else {
            (store.reportCase as unknown as Record<string, unknown>)[key] = value;
          }
        }
        store.reportCase.updatedAt = new Date();
        return { count: 1 };
      },
      async findMany(input) {
        store.lastFindMany = input;
        return store.queueRows;
      },
    },
    wikiProfile: { async findUnique() { return { accountId: 'account-1', status: 'active' }; } },
    auditEvent: {
      async create(input) {
        if (store.failAudit) throw new Error('audit unavailable');
        store.auditActions.push(input.data.action);
        return { id: `audit-${store.auditActions.length}` };
      },
    },
    async $transaction(callback) {
      const snapshot = cloneCase(store.reportCase);
      const auditLength = store.auditActions.length;
      try {
        return await callback(store);
      } catch (error) {
        store.reportCase = snapshot;
        store.auditActions.length = auditLength;
        throw error;
      }
    },
  };
  return store;
}

function queueCase(id: string, createdAt: Date) {
  return {
    id,
    targetType: 'page' as const,
    targetId: 10n,
    pageId: 10n,
    status: 'open' as 'open' | 'in_review' | 'resolved' | 'dismissed',
    activeKey: 'page:10' as string | null,
    reportCount: 1,
    evidenceSnapshot: {},
    assigneeProfileId: null as bigint | null,
    assignedAt: null as Date | null,
    resolution: null as string | null,
    version: 1,
    statusUpdatedAt: createdAt,
    resolvedAt: null as Date | null,
    dismissedAt: null as Date | null,
    createdAt,
    updatedAt: createdAt,
    submissions: [{ id: `${id}-submission`, reporterProfileId: 1n as bigint | null, reason: '신고 사유', createdAt }],
  };
}

function cloneCase(reportCase: ReturnType<typeof queueCase>): ReturnType<typeof queueCase> {
  return {
    ...reportCase,
    submissions: reportCase.submissions.map((submission) => ({ ...submission })),
  };
}

function createModerationService(store: ReturnType<typeof moderationStore>) {
  const profiles = {
    async ensureWikiProfile() { return { id: 7n, accountId: 'account-1', status: 'active' }; },
  };
  const roles = {
    async getAccountAccess() { return { roles: ['moderator'], permissions: ['wiki.report.moderate'] }; },
  };
  return new WikiReportModerationService(store as never, profiles as never, roles as never);
}
