import test from 'node:test';
import assert from 'node:assert/strict';
import { rehomeReviewsForCanonicalMerge } from './review-account-merge';

test('canonical merge preserves report history and leaves exactly one active case', async () => {
  const canonicalAccountId = 'canonical';
  const aliasAccountId = 'alias';
  const reviewId = 'review-1';
  const base = new Date('2026-07-18T00:00:00.000Z');
  const reports = [
    { id: 'open', reviewId, accountId: aliasAccountId, status: 'open', updatedAt: new Date(base.getTime() + 1_000), createdAt: base },
    { id: 'in-review', reviewId, accountId: canonicalAccountId, status: 'in_review', updatedAt: new Date(base.getTime() + 2_000), createdAt: base },
    { id: 'resolved', reviewId, accountId: aliasAccountId, status: 'resolved', updatedAt: new Date(base.getTime() + 3_000), createdAt: base },
    { id: 'dismissed', reviewId, accountId: canonicalAccountId, status: 'dismissed', updatedAt: new Date(base.getTime() + 4_000), createdAt: base },
  ];
  let storedReportCount = 0;
  const tx = {
    serverReview: {
      async updateMany() {},
      async update({ data }: { data: { reports?: number } }) { storedReportCount = data.reports ?? storedReportCount; },
    },
    reviewReport: {
      async updateMany({ where, data }: { where: { accountId?: { in: string[] }; assigneeAccountId?: unknown }; data: { accountId?: string } }) {
        if (where.accountId && data.accountId) {
          for (const report of reports) if (where.accountId.in.includes(report.accountId)) report.accountId = data.accountId;
        }
      },
      async findMany() { return reports; },
      async update({ where, data }: { where: { id: string }; data: { status?: string } }) {
        const report = reports.find((item) => item.id === where.id);
        if (report && data.status) report.status = data.status;
      },
      async count() { return reports.length; },
    },
    reviewSubmissionGate: { async findMany() { return []; } },
    reviewHelpfulVote: { async findMany() { return []; } },
  };

  await rehomeReviewsForCanonicalMerge(tx as never, canonicalAccountId, [canonicalAccountId, aliasAccountId]);

  assert.equal(reports.length, 4);
  assert.equal(reports.every((report) => report.accountId === canonicalAccountId), true);
  assert.equal(reports.filter((report) => ['open', 'in_review'].includes(report.status)).length, 1);
  assert.equal(reports.find((report) => report.id === 'in-review')?.status, 'in_review');
  assert.equal(reports.find((report) => report.id === 'open')?.status, 'dismissed');
  assert.equal(storedReportCount, 4);
});
