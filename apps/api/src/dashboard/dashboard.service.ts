import { Injectable, Logger } from '@nestjs/common';
import type { DashboardOverview } from '@minewiki/schemas';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { isSupportedClaimMethod } from '@minewiki/schemas/claim-methods';
import { ServerService, type ServerWikiReadinessResponse } from '../server/server.service';

@Injectable()
export class DashboardService {
  private readonly logger = new Logger(DashboardService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly serverService: ServerService,
  ) {}

  async getOverview(accountId: string): Promise<DashboardOverview> {
    const servers = await this.prisma.server.findMany({
      where: {
        OR: [{ ownerAccountId: accountId }, { registrantAccountId: accountId }],
      },
      include: { stats: true }
    });

    const wikiEligibleServers = servers.filter((server) => (
      server.ownerAccountId === accountId && !server.ownershipChallengeSuspendedAt
    ));
    const [serverWikis, readinessResults] = await Promise.all([
      wikiEligibleServers.length > 0
        ? this.prisma.serverWiki.findMany({
            where: { voteServerId: { in: wikiEligibleServers.map((server) => server.id) } },
            select: { voteServerId: true, publicationStatus: true },
          })
        : [],
      Promise.allSettled(
        wikiEligibleServers.map((server) => this.serverService.getServerWikiReadiness(server.id)),
      ),
    ]);
    const publicationByServerId = new Map(
      serverWikis.flatMap((serverWiki) => serverWiki.voteServerId
        ? [[serverWiki.voteServerId, normalizePublicationStatus(serverWiki.publicationStatus)] as const]
        : []),
    );
    const wikiOnboardingByServerId = new Map<string, DashboardOverview['servers'][number]['serverWiki']>();
    readinessResults.forEach((result, index) => {
      const server = wikiEligibleServers[index];
      if (!server) return;
      if (result.status === 'rejected') {
        this.logger.warn(`Dashboard server wiki readiness failed for ${server.id}`);
        return;
      }
      wikiOnboardingByServerId.set(
        server.id,
        toDashboardServerWiki(result.value, server, publicationByServerId.get(server.id) ?? null),
      );
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
      registrationLeaseExpiresAt: server.registrationLeaseExpiresAt?.toISOString() ?? null,
      lastSyncedAt: server.stats?.lastUpdatedAt
        ? server.stats.lastUpdatedAt.toISOString()
        : server.updatedAt.toISOString(),
      serverWiki: wikiOnboardingByServerId.get(server.id) ?? null,
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

function toDashboardServerWiki(
  readiness: ServerWikiReadinessResponse,
  server: { readonly id: string; readonly shortCode: string | null },
  publicationStatus: 'draft' | 'published' | 'unpublished' | null,
): NonNullable<DashboardOverview['servers'][number]['serverWiki']> {
  const serverPath = `/servers/${server.shortCode?.trim() || server.id}`;
  const readinessAction = readiness.nextAction
    ? {
        label: readiness.nextAction.label,
        href: readiness.nextAction.href.startsWith('#')
          ? `${serverPath}${readiness.nextAction.href}`
          : readiness.nextAction.href,
      }
    : null;
  const nextAction = readinessAction ?? (
    publicationStatus === 'published' && readiness.wikiUrl
      ? { label: '공개 위키 보기', href: readiness.wikiUrl }
      : publicationStatus
        ? {
            label: '위키 공개 설정 열기',
            href: `${serverPath}/wiki-layouts#server-wiki-publication-title`,
          }
        : null
  );

  return {
    status: readiness.status,
    publicationStatus,
    completedChecks: readiness.completedChecks,
    totalChecks: readiness.totalChecks,
    wikiUrl: readiness.wikiUrl,
    nextAction,
  };
}

function normalizePublicationStatus(value: string): 'draft' | 'published' | 'unpublished' | null {
  return value === 'draft' || value === 'published' || value === 'unpublished' ? value : null;
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
