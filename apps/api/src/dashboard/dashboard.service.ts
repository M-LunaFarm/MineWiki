import { Injectable } from '@nestjs/common';
import type { DashboardOverview } from '@minewiki/schemas';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { isSupportedClaimMethod } from '@minewiki/schemas/claim-methods';

@Injectable()
export class DashboardService {
  constructor(private readonly prisma: PrismaService) {}

  async getOverview(accountId: string): Promise<DashboardOverview> {
    const servers = await this.prisma.server.findMany({
      where: {
        OR: [{ ownerAccountId: accountId }, { registrantAccountId: accountId }],
      },
      include: { stats: true }
    });

    const serverSummaries = servers.map((server) => ({
      id: server.id,
      shortCode: server.shortCode ?? null,
      name: server.name,
      votes24h: server.votes24h,
      votesMonthly: server.votesMonthly ?? undefined,
      reviewsCount: server.reviewsCount,
      verificationGrade:
        (server.verificationGrade === 'Unverified' ? 'Unverified' : 'Verified') as DashboardOverview['servers'][number]['verificationGrade'],
      voteRequiresOwnership: server.voteRequiresOwnership,
      isPendingClaim: server.registrantAccountId === accountId && (
        !server.ownerAccountId || Boolean(server.ownershipChallengeSuspendedAt)
      ),
      ownershipStatus: dashboardOwnershipStatus(server, accountId),
      ownershipChallengeExpiresAt: server.ownershipChallengeExpiresAt?.toISOString() ?? null,
      lastSyncedAt: server.stats?.lastUpdatedAt
        ? server.stats.lastUpdatedAt.toISOString()
        : server.updatedAt.toISOString()
    }));

    const recentReviews = await this.prisma.serverReview.findMany({
      where: {
        server: { ownerAccountId: accountId }
      },
      orderBy: { createdAt: 'desc' },
      take: 10,
      include: { server: { select: { name: true } } }
    });

    const activity = recentReviews.map((review) => ({
      id: review.id,
      serverId: review.serverId,
      serverName: review.server.name,
      body: review.body,
      tags: normalizeReviewTags(review.tags),
      createdAt: review.createdAt.toISOString()
    }));

    const methods = await this.prisma.serverClaimMethod.findMany({
      where: {
        server: {
          OR: [{ ownerAccountId: accountId }, { registrantAccountId: accountId }],
        },
      },
      include: { server: { select: { name: true } } }
    });

    const verification = methods
      .filter((method) => isSupportedClaimMethod(method.method))
      .filter((method) => method.status !== 'verified')
      .map((method) => ({
        serverId: method.serverId,
        serverName: method.server.name,
        method: method.method as DashboardOverview['verification'][number]['method'],
        status: method.status,
        lastCheckedAt: method.lastCheckedAt ? method.lastCheckedAt.toISOString() : null,
        note: method.note ?? null
      }));

    return {
      servers: serverSummaries,
      activity,
      verification
    };
  }
}

function dashboardOwnershipStatus(
  server: {
    readonly ownerAccountId: string | null;
    readonly registrantAccountId: string | null;
    readonly ownershipChallengeStartedAt: Date | null;
    readonly ownershipChallengeSuspendedAt: Date | null;
  },
  accountId: string,
): DashboardOverview['servers'][number]['ownershipStatus'] {
  if (server.ownershipChallengeSuspendedAt) {
    return server.registrantAccountId === accountId && server.ownerAccountId !== accountId
      ? 'takeover_pending'
      : 'ownership_suspended';
  }
  if (!server.ownerAccountId && server.registrantAccountId === accountId) return 'pending_claim';
  if (server.ownerAccountId === accountId && server.ownershipChallengeStartedAt) {
    return 'verification_grace';
  }
  return 'active';
}

function normalizeReviewTags(
  value: Prisma.JsonValue | null | undefined
): DashboardOverview['activity'][number]['tags'] {
  if (!value) {
    return [];
  }
  const items = Array.isArray(value) ? value : [];
  return items.filter((item): item is DashboardOverview['activity'][number]['tags'][number] => {
    return typeof item === 'string' && item.length > 0;
  });
}
