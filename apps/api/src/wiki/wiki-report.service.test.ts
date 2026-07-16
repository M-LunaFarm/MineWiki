import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, NotFoundException } from '@nestjs/common';
import type { SessionPayload } from '../session/session.service';
import { WikiReportService } from './wiki-report.service';

const now = new Date('2026-07-16T12:00:00.000Z');
const page = {
  id: 10n,
  namespaceId: 1,
  spaceId: 1n,
  localPath: '/테스트',
  slug: '테스트',
  title: '테스트',
  displayTitle: '테스트',
  currentRevisionId: null,
  pageType: 'article',
  protectionLevel: 'open',
  status: 'normal',
  currentContentSize: 0,
  currentCategoryCount: 0,
  createdBy: 1n,
  ownerProfileId: null,
  createdAt: now,
  updatedAt: now,
};

const reporter = (userId: string): SessionPayload => ({
  sessionId: `session-${userId}`,
  userId,
  tokenVersion: 1,
  isElevated: false,
  authenticatedAt: now.toISOString(),
  permissions: [],
  groups: [],
});

test('same reporter is idempotent for the active target case', async () => {
  const store = reportStore();
  const service = createService(store);

  const first = await service.report(reporter('account-1'), {
    targetType: 'page', targetId: '10', reason: '광고성 문서입니다.',
  });
  const duplicate = await service.report(reporter('account-1'), {
    targetType: 'page', targetId: '10', reason: '같은 대상을 다시 신고합니다.',
  });

  assert.equal(first.reportCount, 1);
  assert.equal(first.deduplicated, false);
  assert.equal(duplicate.caseId, first.caseId);
  assert.equal(duplicate.reportCount, 1);
  assert.equal(duplicate.deduplicated, true);
  assert.equal(store.submissions.size, 1);
});

test('different reporters aggregate an exact count inside serializable transactions', async () => {
  const store = reportStore();
  const service = createService(store);

  await service.report(reporter('account-1'), {
    targetType: 'page', targetId: '10', reason: '첫 번째 신고 사유입니다.',
  });
  const aggregated = await service.report(reporter('account-2'), {
    targetType: 'page', targetId: '10', reason: '두 번째 신고 사유입니다.',
  });

  assert.equal(aggregated.reportCount, 2);
  assert.equal(aggregated.version, 2);
  assert.equal(store.submissions.size, 2);
  assert.deepEqual(store.transactionIsolationLevels, ['Serializable', 'Serializable']);
});

test('missing, ACL-denied, and non-public targets return the same not-found response', async () => {
  const missingStore = reportStore({ pageExists: false });
  const deniedStore = reportStore({ denyRead: true });
  const hiddenCommentStore = reportStore({ hiddenComment: true });
  const input = { targetType: 'page', targetId: '10', reason: '신고할 사유가 있습니다.' };

  for (const operation of [
    () => createService(missingStore).report(reporter('account-1'), input),
    () => createService(deniedStore).report(reporter('account-1'), input),
    () => createService(hiddenCommentStore).report(reporter('account-1'), {
      ...input, targetType: 'comment', targetId: '50',
    }),
  ]) {
    await assert.rejects(operation, (error: unknown) =>
      error instanceof NotFoundException && error.message === 'Wiki report target not found.');
  }
});

test('blocked wiki profiles cannot create reports', async () => {
  const service = createService(reportStore(), { profileStatus: 'blocked' });
  await assert.rejects(
    () => service.report(reporter('account-1'), {
      targetType: 'page', targetId: '10', reason: '신고할 사유가 있습니다.',
    }),
    ForbiddenException,
  );
});

interface ReportCaseRow {
  id: string;
  targetType: 'page' | 'revision' | 'discussion' | 'comment';
  targetId: bigint;
  pageId: bigint;
  status: 'open' | 'in_review';
  activeKey: string;
  reportCount: number;
  evidenceSnapshot: unknown;
  assigneeProfileId: bigint | null;
  assignedAt: Date | null;
  resolution: string | null;
  version: number;
  statusUpdatedAt: Date;
  resolvedAt: Date | null;
  dismissedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

function reportStore(options: { pageExists?: boolean; denyRead?: boolean; hiddenComment?: boolean } = {}) {
  const cases = new Map<string, ReportCaseRow>();
  const submissions = new Map<string, { id: string; caseId: string; reporterProfileId: bigint }>();
  const transactionIsolationLevels: string[] = [];
  let nextCase = 1;
  let nextSubmission = 1;
  const thread = { id: 40n, pageId: 10n, title: '토론', status: 'open', createdBy: 1n, createdAt: now, updatedAt: now, pinnedCommentId: null };
  const comment = { id: 50n, threadId: 40n, content: '신고 대상 댓글', status: options.hiddenComment ? 'hidden' : 'normal', createdBy: 1n, createdAt: now, updatedAt: null, entryType: 'comment', eventType: null, eventBefore: null, eventAfter: null };

  const transaction = {
    wikiReportCase: {
      async findUnique(input: { where: { activeKey?: string; id?: string } }) {
        if (input.where.activeKey) return [...cases.values()].find((row) => row.activeKey === input.where.activeKey) ?? null;
        return input.where.id ? cases.get(input.where.id) ?? null : null;
      },
      async create(input: { data: Omit<ReportCaseRow, 'id' | 'assigneeProfileId' | 'assignedAt' | 'resolution' | 'resolvedAt' | 'dismissedAt'> }) {
        const row: ReportCaseRow = {
          ...input.data,
          id: `00000000-0000-4000-8000-${String(nextCase++).padStart(12, '0')}`,
          assigneeProfileId: null,
          assignedAt: null,
          resolution: null,
          resolvedAt: null,
          dismissedAt: null,
        };
        cases.set(row.id, row);
        return row;
      },
      async update(input: { where: { id: string }; data: { reportCount: { increment: number }; version: { increment: number } } }) {
        const row = cases.get(input.where.id);
        if (!row) throw new Error('case missing');
        row.reportCount += input.data.reportCount.increment;
        row.version += input.data.version.increment;
        row.updatedAt = new Date();
        return row;
      },
    },
    wikiReportSubmission: {
      async findUnique(input: { where: { caseId_reporterProfileId: { caseId: string; reporterProfileId: bigint } } }) {
        const key = `${input.where.caseId_reporterProfileId.caseId}:${input.where.caseId_reporterProfileId.reporterProfileId}`;
        return submissions.get(key) ?? null;
      },
      async create(input: { data: { caseId: string; reporterProfileId: bigint } }) {
        const row = { id: `submission-${nextSubmission++}`, ...input.data };
        submissions.set(`${row.caseId}:${row.reporterProfileId}`, row);
        return row;
      },
    },
  };

  return {
    cases,
    submissions,
    transactionIsolationLevels,
    denyRead: options.denyRead === true,
    wikiPage: { async findUnique() { return options.pageExists === false ? null : page; } },
    wikiPageRevision: { async findUnique() { return null; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionComment: {
      async findUnique() { return comment; },
      async findFirst() { return comment; },
    },
    async $transaction<T>(callback: (tx: typeof transaction) => Promise<T>, optionsInput: { isolationLevel: string }) {
      transactionIsolationLevels.push(optionsInput.isolationLevel);
      return callback(transaction);
    },
  };
}

function createService(
  store: ReturnType<typeof reportStore>,
  options: { profileStatus?: string } = {},
) {
  const profiles = {
    async ensureWikiProfile(accountId: string) {
      return {
        id: accountId === 'account-2' ? 2n : 1n,
        accountId,
        status: options.profileStatus ?? 'active',
      };
    },
  };
  const permissions = {
    actorFromSession(session: SessionPayload, profile: { id: bigint; status: string }) {
      return { accountId: session.userId, profileId: profile.id, status: profile.status };
    },
    async assertCanReadPage() {
      if (store.denyRead) throw new NotFoundException('Wiki page not found.');
    },
    async assertCanReadThread() {
      if (store.denyRead) throw new NotFoundException('Wiki discussion thread not found.');
    },
  };
  return new WikiReportService(store as never, profiles as never, permissions as never);
}
