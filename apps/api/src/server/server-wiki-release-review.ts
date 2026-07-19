import { Prisma } from '@prisma/client';
import type { PrismaService } from '../common/prisma.service';

type ReviewStore = Prisma.TransactionClient | PrismaService;

export interface ServerWikiReleaseReviewContext {
  readonly serverWikiId: bigint;
  readonly spaceId: bigint;
  readonly actorProfileId: bigint | null;
  readonly authority: 'server_admin' | 'owner' | 'manager' | 'reviewer';
}

export interface ServerWikiReleaseReviewState {
  readonly required: boolean;
  readonly approved: boolean;
  readonly reviewerAvailable: boolean;
  readonly canApprove: boolean;
  readonly viewerApproved: boolean;
  readonly approvals: readonly {
    readonly reviewerProfileId: string;
    readonly approvedAt: string;
  }[];
}

export async function requiredServerWikiReleaseApprovalCount(
  store: ReviewStore,
  context: ServerWikiReleaseReviewContext,
  lock: boolean,
): Promise<number> {
  if (lock) {
    await lockReviewerRoles(store, context.spaceId);
  }
  return configuredReviewerApprovalCount(store, context.spaceId);
}

export async function serverWikiReleaseReviewState(
  store: ReviewStore,
  context: ServerWikiReleaseReviewContext,
  candidateId: bigint,
  requiredApprovals: number,
  lock: boolean,
): Promise<ServerWikiReleaseReviewState> {
  if (lock) {
    await lockReviewerRoles(store, context.spaceId);
    await store.$queryRaw<Array<{ id: bigint }>>`
      SELECT id FROM server_wiki_release_approvals
      WHERE server_wiki_id = ${context.serverWikiId} AND candidate_id = ${candidateId}
      ORDER BY id FOR UPDATE
    `;
  }
  const reviewerIds = await activeReviewerIds(store, context.spaceId);
  const configuredApprovals = await configuredReviewerApprovalCount(store, context.spaceId);
  const effectiveRequiredApprovals = Math.max(requiredApprovals, configuredApprovals);
  const approvalRows = reviewerIds.size > 0
    ? await store.serverWikiReleaseApproval.findMany({
        where: {
          serverWikiId: context.serverWikiId,
          spaceId: context.spaceId,
          candidateId,
          reviewerProfileId: { in: [...reviewerIds] },
          revokedAt: null,
        },
        orderBy: [{ approvedAt: 'asc' }, { id: 'asc' }],
        select: { reviewerProfileId: true, approvedAt: true },
      })
    : [];
  return {
    required: effectiveRequiredApprovals > 0,
    approved: approvalRows.length >= effectiveRequiredApprovals,
    reviewerAvailable: reviewerIds.size > 0,
    canApprove: context.authority === 'reviewer',
    viewerApproved: context.actorProfileId !== null
      && approvalRows.some((approval) => approval.reviewerProfileId === context.actorProfileId),
    approvals: approvalRows.map((approval) => ({
      reviewerProfileId: approval.reviewerProfileId.toString(),
      approvedAt: approval.approvedAt.toISOString(),
    })),
  };
}

async function configuredReviewerApprovalCount(store: ReviewStore, spaceId: bigint): Promise<number> {
  const activeReviewers = await activeReviewerIds(store, spaceId);
  return activeReviewers.size > 0 ? 1 : 0;
}

async function activeReviewerIds(store: ReviewStore, spaceId: bigint): Promise<Set<bigint>> {
  const roles = await store.subwikiRole.findMany({
    where: { spaceId, role: 'reviewer', status: 'active' },
    select: { userId: true },
  });
  const profileIds = [...new Set(roles.map((role) => role.userId))];
  const profiles = profileIds.length > 0
    ? await store.wikiProfile.findMany({
        where: { id: { in: profileIds }, status: 'active', mergedIntoProfileId: null },
        select: { id: true },
      })
    : [];
  return new Set(profiles.map((profile) => profile.id));
}

export async function lockServerWikiReviewerPolicy(store: ReviewStore, spaceId: bigint): Promise<void> {
  await store.$queryRaw<Array<{ id: bigint }>>`
    SELECT id FROM subwiki_roles
    WHERE space_id = ${spaceId} AND role = 'reviewer'
    ORDER BY id FOR UPDATE
  `;
}

async function lockReviewerRoles(store: ReviewStore, spaceId: bigint): Promise<void> {
  await lockServerWikiReviewerPolicy(store, spaceId);
}
