import type { Prisma } from '@prisma/client';

const REPORT_STATUS_PRIORITY = { in_review: 4, open: 3, resolved: 2, dismissed: 1 } as const;

export async function rehomeReviewsForCanonicalMerge(
  tx: Prisma.TransactionClient,
  canonicalAccountId: string,
  accountIds: readonly string[],
): Promise<void> {
  const allAccountIds = [...accountIds];
  const nonCanonicalFilter = { in: allAccountIds, not: canonicalAccountId };
  await tx.serverReview.updateMany({ where: { authorAccountId: nonCanonicalFilter }, data: { authorAccountId: canonicalAccountId } });
  await tx.reviewReport.updateMany({ where: { assigneeAccountId: nonCanonicalFilter }, data: { assigneeAccountId: canonicalAccountId } });

  const gates = await tx.reviewSubmissionGate.findMany({
    where: { authorAccountId: { in: allAccountIds } },
    orderBy: [{ lastSubmittedAt: 'desc' }, { authorAccountId: 'asc' }],
  });
  for (const serverId of new Set(gates.map((gate) => gate.serverId))) {
    const latest = gates.find((gate) => gate.serverId === serverId);
    if (!latest) continue;
    await tx.reviewSubmissionGate.deleteMany({ where: { serverId, authorAccountId: { in: allAccountIds } } });
    await tx.reviewSubmissionGate.create({ data: { serverId, authorAccountId: canonicalAccountId, lastSubmittedAt: latest.lastSubmittedAt } });
  }

  const helpfulVotes = await tx.reviewHelpfulVote.findMany({
    where: { accountId: { in: allAccountIds } },
    orderBy: [{ lastMarkedAt: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const reviewId of new Set(helpfulVotes.map((vote) => vote.reviewId))) {
    const winner = helpfulVotes.filter((vote) => vote.reviewId === reviewId).sort((left, right) =>
      right.lastMarkedAt.getTime() - left.lastMarkedAt.getTime()
      || Number(right.accountId === canonicalAccountId) - Number(left.accountId === canonicalAccountId)
      || left.createdAt.getTime() - right.createdAt.getTime()
      || left.id.localeCompare(right.id))[0];
    if (!winner) continue;
    await tx.reviewHelpfulVote.deleteMany({ where: { reviewId, accountId: { in: allAccountIds }, id: { not: winner.id } } });
    if (winner.accountId !== canonicalAccountId) {
      await tx.reviewHelpfulVote.update({ where: { id: winner.id }, data: { accountId: canonicalAccountId } });
    }
    const helpfulCount = await tx.reviewHelpfulVote.count({ where: { reviewId, isHelpful: true } });
    await tx.serverReview.update({ where: { id: reviewId }, data: { helpfulCount } });
  }

  const reports = await tx.reviewReport.findMany({
    where: { accountId: { in: allAccountIds } },
    orderBy: [{ updatedAt: 'desc' }, { createdAt: 'asc' }, { id: 'asc' }],
  });
  for (const reviewId of new Set(reports.map((report) => report.reviewId))) {
    const winner = reports.filter((report) => report.reviewId === reviewId).sort((left, right) =>
      REPORT_STATUS_PRIORITY[right.status] - REPORT_STATUS_PRIORITY[left.status]
      || right.updatedAt.getTime() - left.updatedAt.getTime()
      || Number(right.accountId === canonicalAccountId) - Number(left.accountId === canonicalAccountId)
      || left.id.localeCompare(right.id))[0];
    if (!winner) continue;
    await tx.reviewReport.deleteMany({ where: { reviewId, accountId: { in: allAccountIds }, id: { not: winner.id } } });
    if (winner.accountId !== canonicalAccountId) {
      await tx.reviewReport.update({ where: { id: winner.id }, data: { accountId: canonicalAccountId } });
    }
    const reportsCount = await tx.reviewReport.count({ where: { reviewId } });
    await tx.serverReview.update({ where: { id: reviewId }, data: { reports: reportsCount } });
  }
}
