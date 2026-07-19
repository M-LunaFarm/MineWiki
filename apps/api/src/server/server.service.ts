import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Logger } from '@minewiki/logger';
import { UnsafeEndpointError, validateOutboundTarget } from '@minewiki/security';
import { buildWikiSearchVector, hashContent, parseMarkup } from '@minewiki/wiki-core';
import type {
  ServerDetail,
  ServerStats,
  ServerSummary,
  ServerUpdate,
  VotifierTarget,
} from '@minewiki/schemas';
import { PUBLIC_SERVER_LISTING_STATUS } from '@minewiki/schemas';
import { Prisma, type Server, type ServerWiki } from '@prisma/client';
import { status, statusBedrock } from 'minecraft-server-util';
import { resolveSrv } from 'node:dns/promises';
import { createHash, randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { assessPlayerMetric, normalizeMinecraftServerHost } from '@minewiki/minecraft';
import { PrismaService } from '../common/prisma.service';
import { writeAuditRecord } from '../events/audit-event-writer';
import { type StoredVerificationGrade, type ServerFilters, type ServerSort } from './server.store';
import { FileService, type FileImageUploadRequest, type FileImageUploadResponse } from '../file/file.service';
import { FirestoreTelemetryService } from '../telemetry/firestore-telemetry.service';
import type { ClaimMethod } from '../claim/claim.types';
import { WikiProfileService } from '../wiki/wiki-profile.service';
import { encryptAppSecret } from '../common/secret-codec';
import { BusinessEventService } from '../events/business-event.service';
import {
  normalizeServerWikiContentSettings,
  renderServerWikiPresentation,
  sourceAuditSummary,
  type ServerWikiContentSettingsInput,
} from './server-wiki-content-settings';
import {
  SERVER_WIKI_LAYOUTS,
  isActiveServerWikiLayoutEntitlement,
  isServerWikiLayoutKey,
  resolveEffectiveServerWikiLayout,
  type ServerWikiLayoutKey,
} from './server-wiki-layout-policy';
import { serverWikiIdentityConflicts } from './server-wiki-identity';
import { buildServerWikiMainPage, buildServerWikiStarterPages } from './server-wiki-scaffold';
import { WikiLinkIndexService } from '../wiki/wiki-link-index.service';
import {
  resolveServerWikiNavigationTree,
  serverWikiPageRelativePath,
  validateServerWikiNavigationDocument,
  type ServerWikiNavigationDocument,
} from '../wiki/server-wiki-navigation-order';
import { buildCanonicalServerWikiPath } from '../wiki/wiki-route-path.resolver';
import { SUPPORTED_CLAIM_METHODS, isSupportedClaimMethod } from '@minewiki/schemas/claim-methods';

const LIVE_STATS_REFRESH_MS = 2 * 60 * 1000;
const LIVE_PING_TIMEOUT_MS = 5000;
const SAMPLE_RETENTION_DAYS = 7;
const UPTIME_WINDOW_HOURS = 24;
const LIVE_PING_ALLOW_IPV6 = parseBooleanEnv(process.env.SERVER_PING_ALLOW_IPV6);
const SHORT_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const SHORT_CODE_LENGTH = 7;
const REGISTRATION_RESERVATION_TTL_MS = 24 * 60 * 60 * 1000;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_CODE_PATTERN = /^[a-z0-9]{5,12}$/;
const SERVER_WIKI_SITE_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{1,61}[a-z0-9])$/;
const RESERVED_SERVER_WIKI_SITE_SLUGS = new Set([
  'admin',
  'api',
  'server',
  'serverwiki',
  'servers',
  'static',
  'www',
]);

export interface ServerProfileUpdateInput {
  readonly name: string;
  readonly tags: string[];
  readonly shortDescription: string;
  readonly longDescription: string;
  readonly websiteUrl: string | null;
  readonly discordUrl: string | null;
}

@Injectable()
export class ServerService {
  private readonly telemetry: Pick<FirestoreTelemetryService, 'record'>;

  constructor(
    private readonly files: FileService,
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    @Optional() private readonly firestoreTelemetry?: FirestoreTelemetryService,
    @Optional() private readonly events?: BusinessEventService,
    @Optional() private readonly wikiLinks?: WikiLinkIndexService,
  ) {
    this.telemetry = firestoreTelemetry ?? {
      record: async () => {},
    };
  }

  async list(
    filters: ServerFilters = {},
    sort: ServerSort = 'votes24h_desc',
  ): Promise<ServerSummary[]> {
    const startedAt = Date.now();
    try {
      const search = filters.search?.trim();
      const searchLower = search?.toLowerCase();
      const servers = await this.prisma.server.findMany({
        where: {
          edition: filters.edition,
          listingStatus: PUBLIC_SERVER_LISTING_STATUS,
        },
        orderBy: buildOrder(sort),
        include: { stats: true },
      });
      const result = servers
        .filter((server) => {
          const tags = normalizeStringArray(server.tags);
          if (filters.tag && !tags.includes(filters.tag)) {
            return false;
          }
          if (!searchLower) {
            return true;
          }
          const normalizedDescription = normalizeShortDescription(
            server.shortDescription,
          ).toLowerCase();
          return (
            server.name.toLowerCase().includes(searchLower) ||
            server.joinHost.toLowerCase().includes(searchLower) ||
            normalizedDescription.includes(searchLower) ||
            tags.some((tag) => tag.toLowerCase() === searchLower)
          );
        })
        .map((server) => toSummary(server));
      void this.telemetry.record('query', 'servers', Date.now() - startedAt, true);
      return result;
    } catch (error) {
      void this.telemetry.record(
        'query',
        'servers',
        Date.now() - startedAt,
        false,
        error instanceof Error ? error.message : 'unknown_error',
      );
      throw error;
    }
  }

  async rankings(input: {
    readonly edition?: 'java' | 'bedrock';
    readonly grade?: 'Verified' | 'Unverified';
    readonly online?: boolean;
    readonly tag?: string;
    readonly search?: string;
    readonly sort: ServerSort;
    readonly page: number;
    readonly pageSize: number;
    readonly rankEpoch?: string;
  }) {
    const search = input.search?.trim();
    const baseWhere: Prisma.ServerWhereInput = {
      listingStatus: PUBLIC_SERVER_LISTING_STATUS,
      edition: input.edition,
      isOnline: input.online,
      verificationGrade:
        input.grade === 'Verified'
          ? { in: ['A', 'B', 'C'] }
          : input.grade === 'Unverified'
            ? 'Unverified'
            : undefined,
      tags: input.tag ? { array_contains: [input.tag] } : undefined,
      OR: search
        ? [
            { name: { contains: search } },
            { joinHost: { contains: search } },
            { shortDescription: { contains: search } },
          ]
        : undefined,
    };
    const skip = (input.page - 1) * input.pageSize;
    return this.prisma.$transaction(async (tx) => {
      const rankAggregate = await tx.serverStats.aggregate({
        where: {
          server: { listingStatus: PUBLIC_SERVER_LISTING_STATUS },
          votesTotal: { gt: 0 },
        },
        _max: { rankCalculatedAt: true },
      });
      const rankEpoch = rankAggregate._max.rankCalculatedAt;
      const requestedRankEpoch = input.rankEpoch ? new Date(input.rankEpoch) : null;
      if (
        input.sort === 'votes24h_desc'
        && requestedRankEpoch
        && requestedRankEpoch.getTime() !== rankEpoch?.getTime()
      ) {
        throw new ConflictException('The ranking snapshot changed. Restart from the first page.');
      }
      const where: Prisma.ServerWhereInput = input.sort === 'votes24h_desc'
        ? {
            AND: [
              baseWhere,
              { stats: { is: { rankCalculatedAt: rankEpoch ?? new Date(0), rankCurrent: { gt: 0 } } } },
            ],
          }
        : baseWhere;
      const [servers, total, baseTotal, online, verified, voteAggregate] = await Promise.all([
        tx.server.findMany({
          where,
          orderBy: buildRankingOrder(input.sort),
          include: { stats: true },
          skip,
          take: input.pageSize,
        }),
        tx.server.count({ where }),
        tx.server.count({ where: baseWhere }),
        tx.server.count({
          where: { AND: [where, { isOnline: true }] },
        }),
        tx.server.count({
          where: {
            AND: [where, { verificationGrade: { in: ['A', 'B', 'C'] } }],
          },
        }),
        tx.server.aggregate({
          where,
          _sum: { votes24h: true },
        }),
      ]);
      const rankUpdatedAt = rankEpoch?.toISOString() ?? null;
      return {
        items: servers.map((server) => toSummary(server)),
        total,
        summary: {
          online,
          verified,
          votes24h: voteAggregate._sum.votes24h ?? 0,
        },
        page: input.page,
        pageSize: input.pageSize,
        totalPages: total === 0 ? 0 : Math.ceil(total / input.pageSize),
        rankUpdatedAt,
        rankEpoch: rankUpdatedAt,
        rankStatus: rankEpoch ? 'ready' as const : 'empty' as const,
        unrankedCount: Math.max(0, baseTotal - total),
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }
  async detail(idOrShortCode: string, viewerAccountId?: string): Promise<ServerDetail> {
    const startedAt = Date.now();
    const lookup = normalizeServerLookup(idOrShortCode);
    try {
      const server = await this.prisma.server.findUnique({
        where: lookup,
        include: { stats: true },
      });
      if (
        !server ||
        (server.listingStatus !== PUBLIC_SERVER_LISTING_STATUS &&
          server.ownerAccountId !== viewerAccountId &&
          server.registrantAccountId !== viewerAccountId)
      ) {
        throw new NotFoundException(`Server ${idOrShortCode} not found`);
      }
      const [methods, serverWiki] = await Promise.all([
        this.prisma.serverClaimMethod.findMany({
          where: { serverId: server.id },
          select: { method: true },
        }),
        server.wikiSlug || server.wikiSpaceId
          ? this.findServerWikiForServer(server.id, server.wikiSpaceId)
          : Promise.resolve(null),
      ]);
      const verificationMethods = methods
        .map((method) => method.method)
        .filter(isSupportedClaimMethod)
        .filter((method, index, array) => array.indexOf(method) === index);
      const hasPublicWiki = hasCanonicalPublishedServerWikiLink(server, serverWiki);
      const detail = {
        ...toDetail(
          hasPublicWiki
            ? server
            : { ...server, wikiSpaceId: null, wikiPageId: null, wikiSlug: null },
          verificationMethods.length > 0 ? verificationMethods : SUPPORTED_CLAIM_METHODS,
        ),
        wikiUrl: hasPublicWiki && serverWiki
          ? `/serverWiki/${encodeURIComponent(serverWiki.siteSlug ?? serverWiki.slug)}`
          : null,
      };
      void this.telemetry.record('get', 'servers', Date.now() - startedAt, true);
      return detail;
    } catch (error) {
      void this.telemetry.record(
        'get',
        'servers',
        Date.now() - startedAt,
        false,
        error instanceof Error ? error.message : 'unknown_error',
      );
      throw error;
    }
  }

  async stats(id: string): Promise<ServerStats> {
    const startedAt = Date.now();
    try {
      const server = await this.ensureExists(id);
      let stats = await this.prisma.serverStats.upsert({
        where: { serverId: id },
        create: {
          serverId: id,
          rankCurrent: 1,
          rankDelta24h: 0,
          rankBest: 1,
          votesLast24h: 0,
          votesLast7d: 0,
          votesMonthToDate: 0,
          votesTotal: 0,
          playersOnline: 0,
          playersMax: 0,
          uptimePercent: 0,
          sparkline: [],
          latencyMs: 0,
        },
        update: {},
      });

      const since = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      let samples = await this.prisma.serverPingSample.findMany({
        where: {
          serverId: id,
          timestamp: { gte: since },
        },
        orderBy: { timestamp: 'asc' },
      });

      if (shouldRefreshLiveStats(stats.lastPingAt, samples.length)) {
        await this.refreshServerPingSnapshot(server);
        const [refreshedStats, refreshedSamples] = await Promise.all([
          this.prisma.serverStats.findUnique({ where: { serverId: id } }),
          this.prisma.serverPingSample.findMany({
            where: {
              serverId: id,
              timestamp: { gte: since },
            },
            orderBy: { timestamp: 'asc' },
          }),
        ]);
        if (refreshedStats) {
          stats = refreshedStats;
          samples = refreshedSamples;
        }
      }

      samples = downsamplePingSamples(samples, 96);

      const payload: ServerStats = {
        serverId: id,
        rank: {
          current: stats.rankCurrent,
          delta24h: stats.rankDelta24h,
          best: stats.rankBest,
        },
        votes: {
          last24h: stats.votesLast24h,
          last7d: stats.votesLast7d,
          monthToDate: stats.votesMonthToDate ?? undefined,
          total: stats.votesTotal,
        },
        players: {
          online: stats.playersOnline,
          max: stats.playersMax,
          lastUpdatedAt: stats.playersLastUpdatedAt
            ? stats.playersLastUpdatedAt.toISOString()
            : null,
        },
        uptimePercent: stats.uptimePercent,
        sparkline: normalizeNumberArray(stats.sparkline),
        latencyMs: stats.latencyMs ?? undefined,
        lastPingAt: stats.lastPingAt ? stats.lastPingAt.toISOString() : null,
        pingSamples: samples.map((sample) => ({
          timestamp: sample.timestamp.toISOString(),
          online: sample.online,
          players: sample.players ?? null,
          maxPlayers: sample.maxPlayers ?? null,
          latency: sample.latency ?? null,
        })),
      };

      void this.telemetry.record('get', 'serverStats', Date.now() - startedAt, true);
      return payload;
    } catch (error) {
      void this.telemetry.record(
        'get',
        'serverStats',
        Date.now() - startedAt,
        false,
        error instanceof Error ? error.message : 'unknown_error',
      );
      throw error;
    }
  }

  private async refreshServerPingSnapshot(server: {
    id: string;
    joinHost: string;
    joinPort: number;
    edition: ServerDetail['edition'];
    verificationGrade?: StoredVerificationGrade;
  }): Promise<void> {
    const target = await resolveLiveProbeTarget({
      host: server.joinHost,
      port: server.joinPort,
      edition: server.edition,
    });
    const now = new Date();
    const context = {
      serverId: server.id,
      host: target?.host ?? server.joinHost,
      port: target?.port ?? server.joinPort,
      edition: server.edition,
    };

    let online = false;
    let playersOnline: number | null = null;
    let playersMax: number | null = null;
    let latency: number | null = null;
    let motd: string | null = null;
    let version: string | null = null;

    try {
      if (!target) {
        throw new Error('live_stats_target_unresolved');
      }
      const response =
        server.edition === 'bedrock'
          ? await statusBedrock(target.host, target.port, { timeout: LIVE_PING_TIMEOUT_MS })
          : await status(target.host, target.port, { timeout: LIVE_PING_TIMEOUT_MS });
      online = true;
      const players = extractPlayers(response);
      playersOnline = players.online;
      playersMax = players.max;
      latency = extractLatency(response);
      motd = extractMotd(response);
      version = extractVersion(response);
    } catch (error) {
      Logger.warn({ err: error, ...context }, 'Live server stats probe failed');
    }

    const latencyValue = latency ? Math.max(0, Math.round(latency)) : 0;
    const playersOnlineValue =
      typeof playersOnline === 'number' ? Math.max(0, Math.round(playersOnline)) : 0;
    const playersMaxValue =
      typeof playersMax === 'number' ? Math.max(0, Math.round(playersMax)) : 0;
    const playerMetric = assessPlayerMetric({
      online,
      playersOnline: online ? playersOnlineValue : null,
      playersMax: online ? playersMaxValue : null,
      serverVerified:
        server.verificationGrade !== undefined && server.verificationGrade !== 'Unverified',
    });
    const retentionStart = new Date(now.getTime() - SAMPLE_RETENTION_DAYS * 24 * 60 * 60 * 1000);
    const uptimeStart = new Date(now.getTime() - UPTIME_WINDOW_HOURS * 60 * 60 * 1000);

    await this.prisma.$transaction(async (tx) => {
      await tx.serverPingSample.create({
        data: {
          serverId: server.id,
          timestamp: now,
          online,
          players: online ? playersOnlineValue : null,
          maxPlayers: online ? playersMaxValue : null,
          playersMetricTrust: playerMetric.trust,
          playersMetricSource: playerMetric.source,
          playersAnomalyReason: playerMetric.anomalyReason,
          latency: online ? latencyValue : null,
          motd,
          version,
        },
      });

      await tx.server.update({
        where: { id: server.id },
        data: {
          isOnline: online,
          latencyMs: online ? latencyValue : null,
          playersOnline: online ? playersOnlineValue : null,
          playersMax: online ? playersMaxValue : null,
          playersLastUpdatedAt: online ? now : null,
          playersMetricTrust: playerMetric.trust,
          playersMetricSource: playerMetric.source,
          playersAnomalyReason: playerMetric.anomalyReason,
        },
      });

      const [totalSamples, onlineSamples] = await Promise.all([
        tx.serverPingSample.count({
          where: { serverId: server.id, timestamp: { gte: uptimeStart } },
        }),
        tx.serverPingSample.count({
          where: { serverId: server.id, timestamp: { gte: uptimeStart }, online: true },
        }),
      ]);
      const uptimePercent =
        totalSamples === 0 ? 0 : Number(((onlineSamples / totalSamples) * 100).toFixed(1));

      await tx.serverStats.upsert({
        where: { serverId: server.id },
        create: {
          serverId: server.id,
          rankCurrent: 1,
          rankDelta24h: 0,
          rankBest: 1,
          votesLast24h: 0,
          votesLast7d: 0,
          votesMonthToDate: 0,
          votesTotal: 0,
          playersOnline: online ? playersOnlineValue : 0,
          playersMax: online ? playersMaxValue : 0,
          playersLastUpdatedAt: online ? now : null,
          uptimePercent,
          sparkline: [],
          latencyMs: online ? latencyValue : 0,
          lastPingAt: now,
        },
        update: {
          playersOnline: online ? playersOnlineValue : 0,
          playersMax: online ? playersMaxValue : 0,
          playersLastUpdatedAt: online ? now : null,
          uptimePercent,
          latencyMs: online ? latencyValue : 0,
          lastPingAt: now,
        },
      });

      await tx.serverPingSample.deleteMany({
        where: {
          serverId: server.id,
          timestamp: { lt: retentionStart },
        },
      });
    });
  }

  async updates(id: string, limit?: number): Promise<ServerUpdate[]> {
    const startedAt = Date.now();
    const safeLimit = normalizeUpdateLimit(limit);
    try {
      const since24h = new Date(Date.now() - 24 * 60 * 60 * 1000);
      const [server, stats, claimMethods, latestReviews, recentVotes] = await Promise.all([
        this.prisma.server.findUnique({
          where: { id },
          select: {
            id: true,
            name: true,
            verificationGrade: true,
            verifiedAt: true,
            updatedAt: true,
          },
        }),
        this.prisma.serverStats.findUnique({
          where: { serverId: id },
          select: { lastPingAt: true },
        }),
        this.prisma.serverClaimMethod.findMany({
          where: {
            serverId: id,
            method: { in: [...SUPPORTED_CLAIM_METHODS] },
            verifiedAt: { not: null },
          },
          orderBy: { verifiedAt: 'desc' },
          take: 5,
          select: { method: true, verifiedAt: true },
        }),
        this.prisma.serverReview.findMany({
          where: { serverId: id, visibility: 'public' },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            authorDisplayName: true,
            rating: true,
            body: true,
            createdAt: true,
          },
        }),
        this.prisma.vote.findMany({
          where: {
            serverId: id,
            status: 'valid',
            votedAt: { gte: since24h },
          },
          orderBy: { votedAt: 'desc' },
          take: 300,
          select: {
            username: true,
            usernameNormalized: true,
            votedAt: true,
          },
        }),
      ]);

      if (!server) {
        throw new NotFoundException(`Server ${id} not found`);
      }

      const events: ServerUpdate[] = [];

      events.push({
        id: `system-${server.id}-${server.updatedAt.getTime()}`,
        serverId: server.id,
        type: 'system',
        title: '서버 정보 업데이트',
        description: `${server.name}의 서버 정보가 최신 상태로 갱신되었습니다.`,
        occurredAt: server.updatedAt.toISOString(),
      });

      if (server.verifiedAt) {
        events.push({
          id: `verification-${server.id}-${server.verifiedAt.getTime()}`,
          serverId: server.id,
          type: 'verification',
          title: `검증 상태 ${toPublicVerificationGrade(server.verificationGrade as StoredVerificationGrade)}`,
          description: '검증 결과가 반영되어 서버 신뢰 등급이 업데이트되었습니다.',
          occurredAt: server.verifiedAt.toISOString(),
        });
      }

      if (stats?.lastPingAt) {
        events.push({
          id: `status-${server.id}-${stats.lastPingAt.getTime()}`,
          serverId: server.id,
          type: 'system',
          title: '실시간 상태 점검',
          description: '서버 핑/접속 상태 모니터링이 갱신되었습니다.',
          occurredAt: stats.lastPingAt.toISOString(),
        });
      }

      for (const method of claimMethods) {
        if (!method.verifiedAt) {
          continue;
        }
        events.push({
          id: `claim-${server.id}-${method.method}-${method.verifiedAt.getTime()}`,
          serverId: server.id,
          type: 'claim',
          title: `${method.method.toUpperCase()} 검증 완료`,
          description: `${method.method.toUpperCase()} 방식의 소유권 검증이 확인되었습니다.`,
          occurredAt: method.verifiedAt.toISOString(),
        });
      }

      for (const review of latestReviews) {
        events.push({
          id: `review-${review.id}`,
          serverId: server.id,
          type: 'review',
          title: `${review.rating}점 리뷰 등록`,
          description: ellipsize(review.body, 120),
          occurredAt: review.createdAt.toISOString(),
          actorDisplayName: review.authorDisplayName,
        });
      }

      if (recentVotes.length > 0) {
        const latestVoteAt = recentVotes[0]?.votedAt ?? new Date();
        const uniqueVoters = new Set(
          recentVotes.map((vote) => vote.usernameNormalized || vote.username.toLowerCase()),
        ).size;

        events.push({
          id: `vote-${server.id}-${latestVoteAt.getTime()}`,
          serverId: server.id,
          type: 'vote',
          title: '24시간 투표 집계',
          description: `최근 24시간 동안 ${recentVotes.length.toLocaleString('ko-KR')}회 투표, ${uniqueVoters.toLocaleString('ko-KR')}명의 유저가 참여했습니다.`,
          occurredAt: latestVoteAt.toISOString(),
        });
      }

      const uniqueById = new Map<string, ServerUpdate>();
      for (const event of events) {
        if (!uniqueById.has(event.id)) {
          uniqueById.set(event.id, event);
        }
      }

      const result = Array.from(uniqueById.values())
        .sort((left, right) => Date.parse(right.occurredAt) - Date.parse(left.occurredAt))
        .slice(0, safeLimit);

      void this.telemetry.record('get', 'serverUpdates', Date.now() - startedAt, true);
      return result;
    } catch (error) {
      void this.telemetry.record(
        'get',
        'serverUpdates',
        Date.now() - startedAt,
        false,
        error instanceof Error ? error.message : 'unknown_error',
      );
      throw error;
    }
  }
  async ensureExists(id: string) {
    const server = await this.prisma.server.findUnique({ where: { id } });
    if (!server) {
      throw new NotFoundException(`Server ${id} not found`);
    }
    return server;
  }

  async getServerWikiLink(serverId: string): Promise<ServerWikiLinkResponse> {
    const server = await this.ensureExists(serverId);
    const serverWiki = await this.findServerWikiForServer(server.id, server.wikiSpaceId);
    if (!hasCanonicalServerWikiLink(server, serverWiki)) {
      return toServerWikiLinkResponse(
        { ...server, wikiSpaceId: null, wikiPageId: null, wikiSlug: null },
        null,
      );
    }
    return toServerWikiLinkResponse(server, serverWiki);
  }

  async getServerWikiReadiness(serverId: string): Promise<ServerWikiReadinessResponse> {
    const server = await this.ensureExists(serverId);
    const serverWiki = await this.findServerWikiForServer(server.id, server.wikiSpaceId);
    if (!serverWiki) {
      return emptyServerWikiReadiness(server.id, 'unlinked');
    }
    if (!hasCanonicalServerWikiLink(server, serverWiki)) {
      return emptyServerWikiReadiness(server.id, 'repair_required');
    }

    const starters = buildServerWikiStarterPages(server);
    const expectedByPath = new Map<string, string>([
      [serverWiki.slug, hashContent(buildServerWikiMainPage(server))],
      ...starters.map((starter) => [
        `${serverWiki.slug}/${starter.path}`,
        hashContent(starter.contentRaw),
      ] as const),
    ]);
    const pages = await this.prisma.wikiPage.findMany({
      where: { spaceId: serverWiki.spaceId, localPath: { in: [...expectedByPath.keys()] } },
      select: {
        localPath: true,
        currentRevisionId: true,
        searchDocument: { select: { revisionId: true } },
      },
    });
    const revisions = await this.prisma.wikiPageRevision.findMany({
      where: { id: { in: pages.flatMap((page) => page.currentRevisionId ? [page.currentRevisionId] : []) } },
      select: { id: true, contentHash: true },
    });
    const revisionHashById = new Map(revisions.map((revision) => [revision.id, revision.contentHash]));
    const pageByPath = new Map(pages.map((page) => [page.localPath, page]));
    const root = pageByPath.get(serverWiki.slug);
    const rules = pageByPath.get(`${serverWiki.slug}/규칙`);
    const requiredDocuments = Object.fromEntries(
      [...expectedByPath.keys()].map((path) => [path, pageByPath.has(path)]),
    );
    const requiredDocumentCount = Object.values(requiredDocuments).filter(Boolean).length;
    const rulesCustomized = Boolean(
      rules?.currentRevisionId
      && revisionHashById.get(rules.currentRevisionId) !== expectedByPath.get(`${serverWiki.slug}/규칙`),
    );
    const introductionCustomized = Boolean(
      root?.currentRevisionId
      && revisionHashById.get(root.currentRevisionId) !== expectedByPath.get(serverWiki.slug),
    );
    const introductionComplete = introductionCustomized || server.longDescription.trim().length >= 80;
    const officialChannels = Boolean(server.websiteUrl || server.discordUrl);
    const searchIndexHealthy = pages.length === expectedByPath.size && pages.every(
      (page) => page.currentRevisionId !== null
        && page.searchDocument?.revisionId === page.currentRevisionId,
    );
    const checks = {
      canonicalLink: true,
      requiredDocuments: requiredDocumentCount === expectedByPath.size,
      introduction: introductionComplete,
      officialRules: rulesCustomized,
      officialChannels,
      searchIndex: searchIndexHealthy,
    };
    const completedChecks = Object.values(checks).filter(Boolean).length;
    const siteSlug = serverWiki.siteSlug ?? serverWiki.slug;
    const wikiUrl = `/serverWiki/${encodeURIComponent(siteSlug)}`;
    const nextAction = !checks.requiredDocuments
      ? { code: 'restore_documents' as const, label: '필수 문서 복구 요청하기', href: '/support/new' }
      : !checks.officialRules
        ? {
            code: 'write_rules' as const,
            label: '공식 규칙 작성하기',
            href: `${wikiUrl}/_tools/edit/${encodeURIComponent('규칙')}`,
          }
        : !checks.introduction
          ? { code: 'write_introduction' as const, label: '서버 소개 보강하기', href: `${wikiUrl}/_tools/edit` }
          : !checks.officialChannels
            ? { code: 'add_official_channels' as const, label: '공식 채널 등록하기', href: '#server-profile-settings' }
            : !checks.searchIndex
              ? { code: 'repair_search_index' as const, label: '검색 인덱스 복구 요청하기', href: '/support/new' }
              : null;

    return {
      serverId: server.id,
      status: completedChecks === Object.keys(checks).length ? 'ready' : 'needs_attention',
      wikiUrl,
      completedChecks,
      totalChecks: Object.keys(checks).length,
      checks,
      requiredDocuments,
      nextAction,
    };
  }

  async createServerWiki(
    serverId: string,
    accountId: string,
    options: ServerWikiLinkOptions = {},
  ): Promise<ServerWikiLinkResponse> {
    const server = await this.ensureExists(serverId);
    const existing = await this.findServerWikiForServer(server.id, server.wikiSpaceId);
    if (existing) {
      if (serverWikiIdentityConflicts(existing, server)) {
        throw new ConflictException('Server wiki identity is inconsistent and requires repair.');
      }
      if (server.wikiSpaceId && server.wikiPageId && server.wikiSlug) {
        return toServerWikiLinkResponse(server, existing);
      }
      return this.linkServerWiki(
        server.id,
        { serverWikiId: existing.id.toString() },
        accountId,
        options,
      );
    }

    const actor = await this.wikiProfiles.ensureWikiProfile(accountId);
    const now = new Date();
    const slug = await this.generateUniqueServerWikiSlug(
      server.wikiSlug ?? server.shortCode ?? server.joinHost ?? server.name,
      server.id,
    );
    const contentRaw = buildServerWikiMainPage(server);

    const linked = await this.prisma.$transaction(async (tx) => {
      const namespace = await tx.wikiNamespace.upsert({
        where: { code: 'server' },
        create: {
          code: 'server',
          displayName: '서버',
          pathPrefix: '/server',
          isContent: true,
        },
        update: {
          displayName: '서버',
          pathPrefix: '/server',
          isContent: true,
        },
      });
      const space = await tx.wikiSpace.create({
        data: {
          code: `server-${server.id}`,
          spaceKey: `server-${server.id}`,
          name: `${server.name} 위키`,
          title: `${server.name} 위키`,
          slug,
          spaceType: 'server_wiki',
          rootNamespaceCode: 'server',
          rootPath: `/server/${slug}`,
          description: server.shortDescription,
          status: 'active',
          createdBy: actor.id,
          ownerUserId: actor.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      const serverWiki = await tx.serverWiki.create({
        data: {
          spaceId: space.id,
          voteServerId: server.id,
          serverName: server.name,
          slug,
          siteSlug: slug,
          host: server.joinHost,
          port: server.joinPort,
          edition: server.edition,
          supportedVersions: normalizeStringArray(server.supportedVersions).join(', ') || null,
          genres: normalizeStringArray(server.tags).join(', ') || null,
          verifiedStatus: server.verificationGrade === 'Unverified' ? 'none' : 'verified',
          status: 'active',
          publicationStatus: 'draft',
          createdBy: actor.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      const parsed = parseMarkup(contentRaw);
      const page = await tx.wikiPage.create({
        data: {
          namespaceId: namespace.id,
          spaceId: space.id,
          localPath: slug,
          slug,
          title: slug,
          displayTitle: `${server.name} 대문`,
          pageType: 'server',
          protectionLevel: 'open',
          status: 'normal',
          createdBy: actor.id,
          createdAt: now,
          updatedAt: now,
        },
      });
      const revision = await tx.wikiPageRevision.create({
        data: {
          pageId: page.id,
          revisionNo: 1,
          parentRevisionId: null,
          contentRaw,
          contentAst: parsed.ast as Prisma.InputJsonValue,
          contentHash: hashContent(contentRaw),
          contentSize: Buffer.byteLength(contentRaw, 'utf8'),
          syntaxVersion: 'bwm-0.3',
          editSummary: '서버 위키 대문 생성',
          isMinor: false,
          createdBy: actor.id,
          actorType: 'user',
          actorUserId: actor.id,
          createdAt: now,
          visibility: 'public',
        },
      });
      await finalizeCreatedServerWikiPage(tx, {
        page,
        revision,
        contentRaw,
        namespaceCode: namespace.code,
        actorId: actor.id,
        now,
        wikiLinks: this.wikiLinks,
      });
      await tx.wikiSpace.update({
        where: { id: space.id },
        data: {
          rootPageId: page.id,
          updatedAt: now,
        },
      });
      for (const starter of buildServerWikiStarterPages(server)) {
        const starterParsed = parseMarkup(starter.contentRaw);
        const starterPage = await tx.wikiPage.create({
          data: {
            namespaceId: namespace.id,
            spaceId: space.id,
            localPath: `${slug}/${starter.path}`,
            slug: `${slug}/${starter.path}`,
            title: `${slug}/${starter.path}`,
            displayTitle: starter.title,
            pageType: 'server',
            protectionLevel: 'open',
            status: 'normal',
            createdBy: actor.id,
            createdAt: now,
            updatedAt: now,
          },
        });
        const starterRevision = await tx.wikiPageRevision.create({
          data: {
            pageId: starterPage.id,
            revisionNo: 1,
            parentRevisionId: null,
            contentRaw: starter.contentRaw,
            contentAst: starterParsed.ast as Prisma.InputJsonValue,
            contentHash: hashContent(starter.contentRaw),
            contentSize: Buffer.byteLength(starter.contentRaw, 'utf8'),
            syntaxVersion: 'bwm-0.3',
            editSummary: `서버 위키 ${starter.title} 생성`,
            isMinor: false,
            createdBy: actor.id,
            actorType: 'user',
            actorUserId: actor.id,
            createdAt: now,
            visibility: 'public',
          },
        });
        await finalizeCreatedServerWikiPage(tx, {
          page: starterPage,
          revision: starterRevision,
          contentRaw: starter.contentRaw,
          namespaceCode: namespace.code,
          actorId: actor.id,
          now,
          wikiLinks: this.wikiLinks,
        });
      }
      const updatedServer = await tx.server.update({
        where: { id: server.id },
        data: {
          wikiSpaceId: space.id,
          wikiPageId: page.id,
          wikiSlug: slug,
        },
      });
      return { server: updatedServer, serverWiki };
    });

    const response = toServerWikiLinkResponse(linked.server, linked.serverWiki);
    await this.events?.audit('server.wiki.create', {
      category: 'server',
      actorAccountId: accountId,
      subjectType: 'server',
      subjectId: server.id,
      metadata: {
        wikiSpaceId: response.wikiSpaceId,
        wikiPageId: response.wikiPageId,
        wikiSlug: response.wikiSlug
      }
    });
    return response;
  }

  async ensureClaimedServerWiki(serverId: string): Promise<ServerWikiLinkResponse> {
    const server = await this.ensureExists(serverId);
    if (!server.ownerAccountId) {
      throw new ConflictException('소유권 검증이 완료된 서버만 위키를 만들 수 있습니다.');
    }
    return this.createServerWiki(serverId, server.ownerAccountId);
  }

  async linkServerWiki(
    serverId: string,
    input: ServerWikiLinkRequest,
    accountId?: string | null,
    options: ServerWikiLinkOptions = {},
  ): Promise<ServerWikiLinkResponse> {
    const selector = normalizeServerWikiSelector(input);
    if (!selector) {
      throw new BadRequestException('serverWikiId, spaceId, or wikiSlug is required.');
    }
    if (!accountId) {
      throw new ForbiddenException('Server wiki linking requires an authenticated account.');
    }

    const selectedTarget = await this.prisma.serverWiki.findFirst({
      where: selector,
      select: { id: true },
    });
    if (!selectedTarget) {
      throw new NotFoundException('Server wiki link target not found.');
    }

    let linked: { server: Server; serverWiki: ServerWiki };
    try {
      linked = await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM \`Server\` WHERE id = ${serverId} FOR UPDATE
        `;
        const server = await tx.server.findUnique({ where: { id: serverId } });
        if (!server) throw new NotFoundException(`Server ${serverId} not found`);

        await tx.$queryRaw<Array<{ id: bigint }>>`
          SELECT id FROM server_wikis WHERE id = ${selectedTarget.id} FOR UPDATE
        `;
        const serverWiki = await tx.serverWiki.findUnique({
          where: { id: selectedTarget.id },
        });
        if (!serverWiki) throw new NotFoundException('Server wiki link target not found.');
        if (serverWiki.voteServerId && serverWiki.voteServerId !== server.id) {
          throw new ConflictException('Server wiki is already linked to another server.');
        }

        await tx.$queryRaw<Array<{ id: bigint }>>`
          SELECT id
          FROM server_wikis
          WHERE space_id = ${serverWiki.spaceId}
          ORDER BY id
          FOR UPDATE
        `;
        const spaceWikiRows = await tx.serverWiki.findMany({
          where: { spaceId: serverWiki.spaceId },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        if (spaceWikiRows.length !== 1 || spaceWikiRows[0]?.id !== serverWiki.id) {
          throw new ConflictException('Server wiki target space has ambiguous linkage.');
        }

        const existingForServer = await tx.serverWiki.findUnique({
          where: { voteServerId: server.id },
          select: { id: true },
        });
        if (existingForServer && existingForServer.id !== serverWiki.id) {
          throw new ConflictException('Server is already linked to another server wiki.');
        }
        if (server.wikiSpaceId && server.wikiSpaceId !== serverWiki.spaceId) {
          throw new ConflictException('Server wiki linkage is inconsistent.');
        }

        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id
          FROM \`Server\`
          WHERE wikiSpaceId = ${serverWiki.spaceId} OR wikiSlug = ${serverWiki.slug}
          ORDER BY id
          FOR UPDATE
        `;
        const competingServer = await tx.server.findFirst({
          where: {
            id: { not: server.id },
            OR: [{ wikiSpaceId: serverWiki.spaceId }, { wikiSlug: serverWiki.slug }],
          },
          select: { id: true },
        });
        if (competingServer) {
          throw new ConflictException('Server wiki is already referenced by another server.');
        }

        await tx.$queryRaw<Array<{ id: bigint }>>`
          SELECT id FROM wiki_spaces WHERE id = ${serverWiki.spaceId} FOR UPDATE
        `;
        const space = await tx.wikiSpace.findUnique({
          where: { id: serverWiki.spaceId },
          select: {
            id: true,
            rootPageId: true,
            ownerUserId: true,
            status: true,
            spaceType: true,
            slug: true,
          },
        });
        if (!space) throw new NotFoundException('Server wiki target space not found.');
        if (
          space.status !== 'active'
          || space.spaceType !== 'server_wiki'
          || space.slug !== serverWiki.slug
          || serverWiki.status !== 'active'
        ) {
          throw new ConflictException('Server wiki target linkage is inconsistent.');
        }
        if (!space.ownerUserId) {
          throw new ForbiddenException('Target server wiki has no active canonical owner.');
        }

        const ownerProfile = await tx.wikiProfile.findUnique({
          where: { id: space.ownerUserId },
          select: { accountId: true, status: true },
        });
        if (!ownerProfile?.accountId || ownerProfile.status !== 'active') {
          throw new ForbiddenException('Target server wiki has no active canonical owner.');
        }

        const actorCanonicalId = await resolveCanonicalAccountId(tx, accountId, true);
        const serverOwnerCanonicalId = server.ownerAccountId
          ? await resolveCanonicalAccountId(tx, server.ownerAccountId, false)
          : null;
        const targetOwnerCanonicalId = await resolveCanonicalAccountId(
          tx,
          ownerProfile.accountId,
          true,
        );
        if (!options.allowTargetAuthorityBypass) {
          if (!serverOwnerCanonicalId || actorCanonicalId !== serverOwnerCanonicalId) {
            throw new ForbiddenException('Only the canonical server owner can link a server wiki.');
          }
          if (targetOwnerCanonicalId !== serverOwnerCanonicalId) {
            throw new ForbiddenException('You do not own the target server wiki.');
          }
        }

        const page = space.rootPageId
          ? await tx.wikiPage.findUnique({
              where: { id: space.rootPageId },
              select: { id: true, spaceId: true },
            })
          : await tx.wikiPage.findFirst({
              where: { spaceId: serverWiki.spaceId, status: { not: 'deleted' } },
              select: { id: true, spaceId: true },
              orderBy: [{ updatedAt: 'desc' }],
            });
        if (page && page.spaceId !== serverWiki.spaceId) {
          throw new ConflictException('Server wiki root page belongs to another space.');
        }
        const claimed = await tx.serverWiki.updateMany({
          where: {
            id: serverWiki.id,
            OR: [{ voteServerId: null }, { voteServerId: server.id }],
          },
          data: {
            voteServerId: server.id,
            serverName: server.name,
            host: server.joinHost,
            port: server.joinPort,
            edition: server.edition,
            updatedAt: new Date(),
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException('Server wiki is already linked to another server.');
        }
        const updatedServerWiki = await tx.serverWiki.findUniqueOrThrow({
          where: { id: serverWiki.id },
        });
        const updatedServer = await tx.server.update({
          where: { id: server.id },
          data: {
            wikiSpaceId: serverWiki.spaceId,
            wikiPageId: page?.id ?? null,
            wikiSlug: serverWiki.slug,
          },
        });
        await writeAuditRecord(tx, {
          data: {
            category: 'server',
            action: 'server.wiki.link',
            severity: 'info',
            actorAccountId: actorCanonicalId,
            subjectType: 'server',
            subjectId: server.id,
            metadata: {
              serverId: server.id,
              serverWikiId: serverWiki.id.toString(),
              wikiSpaceId: serverWiki.spaceId.toString(),
              wikiPageId: page?.id.toString() ?? null,
              wikiSlug: serverWiki.slug,
            },
          },
        });
        return { server: updatedServer, serverWiki: updatedServerWiki };
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : null;
      if (code === 'P2002' || code === 'P2034') {
        throw new ConflictException('Server wiki linking changed concurrently. Please retry.');
      }
      throw error;
    }

    const response = toServerWikiLinkResponse(linked.server, linked.serverWiki);
    return response;
  }

  async updateBanner(id: string, accountId: string, upload: FileImageUploadRequest): Promise<FileImageUploadResponse> {
    const startedAt = Date.now();
    try {
      await this.ensureExists(id);
      const stored = await this.files.createImage(accountId, {
        ...upload,
        usageContext: 'server_banner',
      });
      await this.prisma.server.update({
        where: { id },
        data: { bannerUrl: stored.publicPath },
      });
      void this.telemetry.record('update', 'servers', Date.now() - startedAt, true);
      return stored;
    } catch (error) {
      void this.telemetry.record(
        'update',
        'servers',
        Date.now() - startedAt,
        false,
        error instanceof Error ? error.message : 'unknown_error',
      );
      throw error;
    }
  }

  async updateProfile(
    id: string,
    input: ServerProfileUpdateInput,
    actorAccountId: string,
  ): Promise<ServerDetail> {
    const updated = await this.prisma.$transaction(async (tx) => {
      const server = await tx.server.update({
        where: { id },
        data: {
          name: input.name,
          tags: input.tags,
          shortDescription: input.shortDescription,
          longDescription: input.longDescription,
          websiteUrl: input.websiteUrl,
          discordUrl: input.discordUrl,
        },
      });
      await tx.serverWiki.updateMany({
        where: { voteServerId: id },
        data: { serverName: input.name, updatedAt: new Date() },
      });
      return server;
    });
    await this.events?.audit('server.profile.update', {
      category: 'server',
      actorAccountId,
      subjectType: 'server',
      subjectId: id,
      metadata: {
        name: input.name,
        tagCount: input.tags.length,
        hasWebsite: input.websiteUrl !== null,
        hasDiscord: input.discordUrl !== null,
      },
    });
    return toDetail(updated, SUPPORTED_CLAIM_METHODS);
  }

  async uploadContentImage(accountId: string, upload: FileImageUploadRequest): Promise<FileImageUploadResponse> {
    const startedAt = Date.now();
    try {
      const stored = await this.files.createImage(accountId, {
        ...upload,
        usageContext: 'server_description',
      });
      void this.telemetry.record('create', 'serverAssets', Date.now() - startedAt, true);
      return stored;
    } catch (error) {
      void this.telemetry.record(
        'create',
        'serverAssets',
        Date.now() - startedAt,
        false,
        error instanceof Error ? error.message : 'unknown_error',
      );
      throw error;
    }
  }

  async updateVotePolicy(id: string, requiresOwnership: boolean): Promise<ServerDetail> {
    const updated = await this.prisma.server.update({
      where: { id },
      data: { voteRequiresOwnership: requiresOwnership },
    });
    return toDetail(updated, SUPPORTED_CLAIM_METHODS);
  }

  async listVotifierTargets(serverId: string): Promise<VotifierTarget[]> {
    const targets = await this.prisma.votifierTarget.findMany({
      where: { serverId },
      orderBy: { createdAt: 'asc' },
    });
    return targets.map((target) => ({
      protocol: target.protocol === 'v1' ? 'v1' : 'v2',
      host: target.host,
      port: target.port,
      tokenConfigured: Boolean(target.token),
      publicKey: target.publicKey ?? undefined,
    }));
  }

  async updateVotifierTargets(serverId: string, targets: VotifierTarget[]): Promise<void> {
    const existingTargets = await this.prisma.votifierTarget.findMany({
      where: { serverId },
      orderBy: { createdAt: 'asc' },
    });
    const existingByProtocol = new Map(
      existingTargets.map((target) => [target.protocol, target] as const),
    );
    const data = targets.map((target) => {
      const existing = existingByProtocol.get(target.protocol);
      let token: string | null = null;
      if (target.protocol === 'v2') {
        token = target.token
          ? encryptAppSecret(target.token)
          : target.tokenConfigured
            ? existing?.token ?? null
            : null;
        if (!token) {
          throw new BadRequestException('Votifier v2 토큰을 입력해 주세요.');
        }
      }
      return {
        serverId,
        protocol: target.protocol,
        host: target.host,
        port: target.port,
        token,
        publicKey: target.publicKey ?? null,
      };
    });
    await this.prisma.$transaction([
      this.prisma.votifierTarget.deleteMany({ where: { serverId } }),
      this.prisma.votifierTarget.createMany({
        data,
      }),
    ]);
  }

  async remove(id: string, actorAccountId?: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw<Array<{ id: string }>>`
          SELECT id FROM \`Server\` WHERE id = ${id} FOR UPDATE
        `;
        const server = await tx.server.findUnique({
          where: { id },
          select: {
            id: true,
            ownerAccountId: true,
            registrantAccountId: true,
            wikiSpaceId: true,
            wikiPageId: true,
            wikiSlug: true,
          },
        });
        if (!server) throw new NotFoundException(`Server ${id} not found`);
        const actorStillAuthorized = Boolean(
          actorAccountId
          && (
            server.ownerAccountId === actorAccountId
            || (!server.ownerAccountId && server.registrantAccountId === actorAccountId)
          )
        );
        if (!actorStillAuthorized) {
          throw new BadRequestException('해당 서버를 제거할 권한이 없습니다.');
        }

        const linkageConditions = [Prisma.sql`vote_server_id = ${server.id}`];
        if (server.wikiSpaceId !== null) {
          linkageConditions.push(Prisma.sql`space_id = ${server.wikiSpaceId}`);
        }
        await tx.$queryRaw(Prisma.sql`
          SELECT id
          FROM server_wikis
          WHERE ${Prisma.join(linkageConditions, ' OR ')}
          ORDER BY id
          FOR UPDATE
        `);
        const wikiCandidates = await tx.serverWiki.findMany({
          where: {
            OR: [
              { voteServerId: server.id },
              ...(server.wikiSpaceId !== null ? [{ spaceId: server.wikiSpaceId }] : []),
            ],
          },
          select: {
            id: true,
            voteServerId: true,
            spaceId: true,
            slug: true,
            status: true,
          },
          orderBy: { id: 'asc' },
        });

        const hasServerWikiReference =
          server.wikiSpaceId !== null || server.wikiPageId !== null || server.wikiSlug !== null;
        let archivedServerWikiId: bigint | null = null;
        let archivedWikiSpaceId: bigint | null = null;
        let revokedCollaboratorMemberships = 0;
        let preservedOwnerMemberships = 0;
        const now = new Date();

        if (wikiCandidates.length === 0) {
          if (hasServerWikiReference) {
            throw new ConflictException('Server wiki linkage is inconsistent; deletion was cancelled.');
          }
        } else {
          if (
            wikiCandidates.length !== 1
            || server.wikiSpaceId === null
            || server.wikiSlug === null
          ) {
            throw new ConflictException('Server wiki linkage is ambiguous; deletion was cancelled.');
          }
          const serverWiki = wikiCandidates[0];
          if (
            serverWiki.voteServerId !== server.id
            || serverWiki.spaceId !== server.wikiSpaceId
            || serverWiki.slug !== server.wikiSlug
            || serverWiki.status !== 'active'
          ) {
            throw new ConflictException('Server wiki linkage is inconsistent; deletion was cancelled.');
          }

          await tx.$queryRaw<Array<{ id: bigint }>>`
            SELECT id FROM wiki_spaces WHERE id = ${serverWiki.spaceId} FOR UPDATE
          `;
          const space = await tx.wikiSpace.findUnique({
            where: { id: serverWiki.spaceId },
            select: { id: true, slug: true, spaceType: true, status: true },
          });
          if (
            !space
            || space.slug !== serverWiki.slug
            || space.spaceType !== 'server_wiki'
            || space.status !== 'active'
          ) {
            throw new ConflictException('Server wiki space is inconsistent; deletion was cancelled.');
          }

          await tx.$queryRaw<Array<{ id: string }>>`
            SELECT id
            FROM \`Server\`
            WHERE id <> ${server.id}
              AND (wikiSpaceId = ${space.id} OR wikiSlug = ${serverWiki.slug})
            ORDER BY id
            FOR UPDATE
          `;
          const competingServers = await tx.server.findMany({
            where: {
              id: { not: server.id },
              OR: [{ wikiSpaceId: space.id }, { wikiSlug: serverWiki.slug }],
            },
            select: { id: true },
            take: 1,
          });
          if (competingServers.length > 0) {
            throw new ConflictException('Server wiki is referenced by another tenant; deletion was cancelled.');
          }

          await tx.$queryRaw<Array<{ id: bigint }>>`
            SELECT id
            FROM subwiki_roles
            WHERE space_id = ${space.id}
            ORDER BY id
            FOR UPDATE
          `;
          preservedOwnerMemberships = await tx.subwikiRole.count({
            where: { spaceId: space.id, status: 'active', role: 'owner' },
          });
          const revoked = await tx.subwikiRole.updateMany({
            where: { spaceId: space.id, status: 'active', role: { not: 'owner' } },
            data: {
              status: 'revoked',
              revokedAt: now,
              revokedBy: actorAccountId
                ? (await tx.wikiProfile.findUnique({
                    where: { accountId: actorAccountId },
                    select: { id: true },
                  }))?.id ?? null
                : null,
            },
          });
          revokedCollaboratorMemberships = revoked.count;

          const archivedWiki = await tx.serverWiki.updateMany({
            where: { id: serverWiki.id, voteServerId: server.id, status: 'active' },
            data: { voteServerId: null, status: 'archived', updatedAt: now },
          });
          const archivedSpace = await tx.wikiSpace.updateMany({
            where: { id: space.id, status: 'active' },
            data: { status: 'archived', updatedAt: now },
          });
          if (archivedWiki.count !== 1 || archivedSpace.count !== 1) {
            throw new ConflictException('Server wiki lifecycle changed concurrently; deletion was cancelled.');
          }
          archivedServerWikiId = serverWiki.id;
          archivedWikiSpaceId = space.id;
        }

        const disabledCredentials = await tx.pluginServer.updateMany({
          where: { serverId: id, enabled: true },
          data: { enabled: false },
        });
        await writeAuditRecord(tx, {
          data: {
            category: 'server',
            action: 'server.deleted',
            severity: 'warning',
            actorAccountId: actorAccountId ?? null,
            subjectType: 'server',
            subjectId: id,
            metadata: {
              disabledPluginCredentials: disabledCredentials.count,
              archivedServerWikiId: archivedServerWikiId?.toString() ?? null,
              archivedWikiSpaceId: archivedWikiSpaceId?.toString() ?? null,
              revokedCollaboratorMemberships,
              preservedOwnerMemberships,
            },
            createdAt: now,
          },
        });
        await tx.server.delete({ where: { id } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      void this.telemetry.record('delete', 'servers', Date.now() - startedAt, true);
    } catch (error) {
      void this.telemetry.record(
        'delete',
        'servers',
        Date.now() - startedAt,
        false,
        error instanceof Error ? error.message : 'unknown_error',
      );
      throw error;
    }
  }

  async recheckVerification(
    id: string,
    options: VerificationRecheckOptions,
  ): Promise<VerificationRecheckResult> {
    const current = await this.prisma.server.findUnique({
      where: { id },
      select: { verificationGrade: true },
    });
    if (!current) {
      throw new NotFoundException(`Server ${id} not found`);
    }
    const previousGrade = current.verificationGrade as StoredVerificationGrade;
    const checkedAtIso = normalizeTimestamp(options.checkedAt);

    const nextGrade: StoredVerificationGrade = options.passed ? previousGrade : 'Unverified';
    const downgraded = previousGrade !== nextGrade;

    await this.prisma.server.update({
      where: { id },
      data: {
        verificationGrade: nextGrade,
        verifiedAt: nextGrade === 'Unverified' ? null : new Date(checkedAtIso),
      },
    });

    return {
      serverId: id,
      grade: toPublicVerificationGrade(nextGrade),
      previousGrade: toPublicVerificationGrade(previousGrade),
      downgraded,
      checkedAt: checkedAtIso,
      reason: options.reason ?? (options.passed ? 'verification_passed' : 'recheck_failed'),
    };
  }

  async register(serverInput: {
    name: string;
    joinHost: string;
    joinPort: number;
    edition: 'java' | 'bedrock';
    supportedVersions: string[];
    tags: string[];
    shortDescription: string;
    longDescription: string;
    websiteUrl?: string | null;
    discordUrl?: string | null;
    ownerAccountId?: string;
    registrantAccountId?: string;
  }): Promise<ServerDetail> {
    let normalizedHost: string;
    try {
      normalizedHost = normalizeMinecraftServerHost(serverInput.joinHost);
    } catch (error) {
      throw new BadRequestException(
        error instanceof Error ? error.message : '서버 접속 주소 형식이 올바르지 않습니다.',
      );
    }
    const registrationEndpointKey = createRegistrationEndpointKey(
      serverInput.edition,
      normalizedHost,
      serverInput.joinPort,
    );
    try {
      await validateOutboundTarget(normalizedHost, serverInput.joinPort, {
        label: 'Server registration',
        allowIpv6: LIVE_PING_ALLOW_IPV6,
      });
    } catch {
      throw new BadRequestException(
        isIP(normalizedHost) !== 0
          ? '사설망, 루프백 또는 예약된 IP 주소는 서버 주소로 등록할 수 없습니다.'
          : '공개 인터넷에서 확인할 수 있는 서버 도메인만 등록할 수 있습니다.',
      );
    }
    const existingRegistration = await this.resolveExistingRegistration(
      registrationEndpointKey,
      serverInput,
    );
    if (existingRegistration) {
      return existingRegistration;
    }

    for (let attempt = 0; attempt < 8; attempt += 1) {
      const shortCode = await this.generateUniqueShortCode();
      try {
        const server = await this.prisma.server.create({
          data: {
            shortCode,
            name: serverInput.name,
            joinHost: normalizedHost,
            joinPort: serverInput.joinPort,
            registrationEndpointKey,
            edition: serverInput.edition,
            listingStatus: 'pending',
            supportedVersions: serverInput.supportedVersions,
            tags: serverInput.tags,
            shortDescription: serverInput.shortDescription,
            longDescription: serverInput.longDescription,
            websiteUrl: serverInput.websiteUrl ?? null,
            discordUrl: serverInput.discordUrl ?? null,
            ownerAccountId: serverInput.ownerAccountId ?? null,
            registrantAccountId: serverInput.registrantAccountId ?? null,
            registrationLeaseExpiresAt: serverInput.registrantAccountId && !serverInput.ownerAccountId
              ? new Date(Date.now() + REGISTRATION_RESERVATION_TTL_MS)
              : null,
            voteCooldownHours: 24,
            verificationGrade: 'Unverified',
            votes24h: 0,
            votesMonthly: 0,
            reviewsCount: 0,
            voteRequiresOwnership: false,
            playersOnline: null,
            playersMax: null,
            playersLastUpdatedAt: null,
            isOnline: null,
            latencyMs: null,
            stats: {
              create: {
                rankCurrent: 1,
                rankDelta24h: 0,
                rankBest: 1,
                votesLast24h: 0,
                votesLast7d: 0,
                votesMonthToDate: 0,
                votesTotal: 0,
                playersOnline: 0,
                playersMax: 0,
                uptimePercent: 0,
                sparkline: [],
                latencyMs: 0,
              },
            },
          },
        });
        return toDetail(server, SUPPORTED_CLAIM_METHODS);
      } catch (error) {
        if (isEndpointUniqueConstraintError(error)) {
          const racedRegistration = await this.resolveExistingRegistration(
            registrationEndpointKey,
            serverInput,
          );
          if (racedRegistration) {
            return racedRegistration;
          }
          throw new ConflictException(
            '같은 에디션과 접속 주소를 사용하는 서버가 이미 등록되어 있습니다.',
          );
        }
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
      }
    }
    throw new Error('Failed to generate unique server short code.');
  }

  private async resolveExistingRegistration(
    registrationEndpointKey: string,
    serverInput: {
      name: string;
      joinHost: string;
      joinPort: number;
      edition: 'java' | 'bedrock';
      supportedVersions: string[];
      tags: string[];
      shortDescription: string;
      longDescription: string;
      websiteUrl?: string | null;
      discordUrl?: string | null;
      registrantAccountId?: string;
    },
  ): Promise<ServerDetail | null> {
    const existing = await this.prisma.server.findFirst({
      where: { registrationEndpointKey },
      select: {
        id: true,
        ownerAccountId: true,
        registrantAccountId: true,
        registrationLeaseExpiresAt: true,
        listingStatus: true,
        createdAt: true,
        updatedAt: true,
      },
    });
    if (!existing) {
      return null;
    }

    const isUnclaimedPending = existing.ownerAccountId === null
      && existing.listingStatus === 'pending';
    if (
      isUnclaimedPending
      && serverInput.registrantAccountId
      && existing.registrantAccountId === serverInput.registrantAccountId
    ) {
      return this.detail(existing.id, serverInput.registrantAccountId);
    }

    const reservationExpiresAt = existing.registrationLeaseExpiresAt
      ?? new Date(existing.createdAt.getTime() + REGISTRATION_RESERVATION_TTL_MS);
    const reservationExpired = reservationExpiresAt.getTime() <= Date.now();
    if (!isUnclaimedPending || !reservationExpired || !serverInput.registrantAccountId) {
      throw new ConflictException('같은 에디션과 접속 주소를 사용하는 서버가 이미 등록되어 있습니다.');
    }

    const reclaimed = await this.prisma.$transaction(async (transaction) => {
      const updated = await transaction.server.updateMany({
        where: {
          id: existing.id,
          registrationEndpointKey,
          ownerAccountId: null,
          listingStatus: 'pending',
          registrantAccountId: existing.registrantAccountId,
          registrationLeaseExpiresAt: existing.registrationLeaseExpiresAt,
          updatedAt: existing.updatedAt,
        },
        data: {
          registrantAccountId: serverInput.registrantAccountId,
          registrationLeaseExpiresAt: new Date(Date.now() + REGISTRATION_RESERVATION_TTL_MS),
          name: serverInput.name,
          joinHost: normalizeMinecraftServerHost(serverInput.joinHost),
          joinPort: serverInput.joinPort,
          edition: serverInput.edition,
          supportedVersions: serverInput.supportedVersions,
          tags: serverInput.tags,
          shortDescription: serverInput.shortDescription,
          longDescription: serverInput.longDescription,
          websiteUrl: serverInput.websiteUrl ?? null,
          discordUrl: serverInput.discordUrl ?? null,
          bannerUrl: null,
          verificationGrade: 'Unverified',
          verifiedAt: null,
        },
      });
      if (updated.count !== 1) {
        return false;
      }
      await transaction.serverClaimMethod.deleteMany({
        where: { serverId: existing.id },
      });
      return true;
    });
    if (!reclaimed) {
      throw new ConflictException('서버 등록 상태가 변경되었습니다. 다시 시도해 주세요.');
    }
    return this.detail(existing.id, serverInput.registrantAccountId);
  }

  async getWikiLayoutSettings(serverId: string) {
    const serverWiki = await this.prisma.serverWiki.findUnique({
      where: { voteServerId: serverId },
      select: { id: true, layoutKey: true, layoutUpdatedAt: true }
    });
    if (!serverWiki) {
      throw new NotFoundException('Server wiki not found.');
    }
    const now = new Date();
    const entitlements = await this.prisma.serverWikiLayoutEntitlement.findMany({
      where: {
        serverWikiId: serverWiki.id,
        status: 'active',
      },
      select: { layoutKey: true, status: true, startsAt: true, expiresAt: true, source: true }
    });
    const allowed = new Set<ServerWikiLayoutKey>(['docs']);
    for (const entitlement of entitlements) {
      if (
        isServerWikiLayoutKey(entitlement.layoutKey) &&
        isActiveServerWikiLayoutEntitlement(entitlement, entitlement.layoutKey, now)
      ) allowed.add(entitlement.layoutKey);
    }
    return {
      selected: resolveEffectiveServerWikiLayout(serverWiki.layoutKey, entitlements, now),
      updatedAt: serverWiki.layoutUpdatedAt?.toISOString() ?? null,
      layouts: SERVER_WIKI_LAYOUTS.map((layout) => {
        const entitlement = entitlements.find((item) =>
          isActiveServerWikiLayoutEntitlement(item, layout.key, now),
        );
        return {
          ...layout,
          entitled: allowed.has(layout.key),
          entitlementExpiresAt: entitlement?.expiresAt?.toISOString() ?? null
        };
      })
    };
  }

  async updateWikiLayout(serverId: string, layoutKey: string, actorAccountId?: string | null) {
    if (!isServerWikiLayoutKey(layoutKey)) {
      throw new BadRequestException('Unknown server wiki layout.');
    }
    const settings = await this.getWikiLayoutSettings(serverId);
    const layout = settings.layouts.find((item) => item.key === layoutKey);
    if (!layout?.entitled) {
      throw new ForbiddenException('This premium layout is not included in the server plan.');
    }
    const actorProfile = actorAccountId
      ? await this.wikiProfiles.ensureWikiProfile(actorAccountId)
      : null;
    const updated = await this.prisma.serverWiki.update({
      where: { voteServerId: serverId },
      data: {
        layoutKey,
        layoutUpdatedAt: new Date(),
        layoutUpdatedBy: actorProfile?.id ?? null
      },
      select: { id: true, layoutKey: true, layoutUpdatedAt: true }
    });
    await this.events?.audit('server.wiki.layout.update', {
      category: 'billing',
      actorAccountId: actorAccountId ?? null,
      actorProfileId: actorProfile?.id ?? null,
      subjectType: 'server_wiki',
      subjectId: updated.id,
      metadata: {
        serverId,
        previousEffectiveLayout: settings.selected,
        layoutKey: updated.layoutKey,
      },
    });
    return {
      selected: updated.layoutKey,
      updatedAt: updated.layoutUpdatedAt?.toISOString() ?? null
    };
  }

  async updateWikiSiteSlug(serverId: string, input: string, actorAccountId?: string | null) {
    const siteSlug = input.trim().toLowerCase();
    if (!SERVER_WIKI_SITE_SLUG_PATTERN.test(siteSlug)) {
      throw new BadRequestException('사이트 주소는 영문 소문자, 숫자, 하이픈 조합으로 3~63자여야 합니다.');
    }
    if (RESERVED_SERVER_WIKI_SITE_SLUGS.has(siteSlug)) {
      throw new BadRequestException('예약된 사이트 주소는 사용할 수 없습니다.');
    }
    const current = await this.prisma.serverWiki.findUnique({
      where: { voteServerId: serverId },
      select: { id: true, siteSlug: true },
    });
    if (!current) throw new NotFoundException('Server wiki not found.');
    if (current.siteSlug === siteSlug) {
      return { siteSlug, wikiUrl: `/serverWiki/${encodeURIComponent(siteSlug)}` };
    }
    try {
      await this.prisma.serverWiki.update({
        where: { id: current.id },
        data: { siteSlug },
      });
    } catch (error) {
      if (isUniqueConstraintError(error)) {
        throw new ConflictException('이미 사용 중인 서버 위키 사이트 주소입니다.');
      }
      throw error;
    }
    await this.events?.audit('server.wiki.site_slug.update', {
      category: 'server',
      actorAccountId: actorAccountId ?? null,
      subjectType: 'server_wiki',
      subjectId: current.id,
      metadata: {
        serverId,
        previousSiteSlug: current.siteSlug,
        siteSlug,
      },
    });
    return { siteSlug, wikiUrl: `/serverWiki/${encodeURIComponent(siteSlug)}` };
  }

  async getWikiContentSettings(serverId: string) {
    const settings = await this.prisma.serverWiki.findUnique({
      where: { voteServerId: serverId },
      select: {
        id: true,
        slug: true,
        siteSlug: true,
        contributionPolicySource: true,
        editHelpSource: true,
        topNoticeSource: true,
        bottomNoticeSource: true,
        seoTitle: true,
        seoDescription: true,
        seoIndexingEnabled: true,
        requireContributionPolicyAck: true,
        contributionPolicyVersion: true,
        contentSettingsVersion: true,
        contentSettingsUpdatedAt: true,
        contentSettingsUpdatedBy: true,
      },
    });
    if (!settings) throw new NotFoundException('Server wiki not found.');
    return toWikiContentSettingsResponse(settings);
  }

  async getWikiNavigationSettings(serverId: string) {
    const serverWiki = await this.prisma.serverWiki.findUnique({
      where: { voteServerId: serverId },
      select: {
        id: true,
        spaceId: true,
        slug: true,
        siteSlug: true,
        navigationOrder: true,
        navigationVersion: true,
        navigationUpdatedAt: true,
        navigationUpdatedBy: true,
      },
    });
    if (!serverWiki) throw new NotFoundException('Server wiki not found.');
    const pages = await this.prisma.wikiPage.findMany({
      where: { spaceId: serverWiki.spaceId, pageType: { not: 'redirect' } },
      select: { id: true, title: true, localPath: true, displayTitle: true, status: true },
      orderBy: [{ localPath: 'asc' }, { id: 'asc' }],
    });
    return toWikiNavigationSettingsResponse(serverWiki, pages);
  }

  async updateWikiNavigationSettings(
    serverId: string,
    expectedVersion: number,
    document: unknown,
    actorAccountId: string,
  ) {
    const current = await this.prisma.serverWiki.findUnique({
      where: { voteServerId: serverId },
      select: {
        id: true,
        spaceId: true,
        slug: true,
        siteSlug: true,
        navigationVersion: true,
      },
    });
    if (!current) throw new NotFoundException('Server wiki not found.');
    if (current.navigationVersion !== expectedVersion) {
      throwWikiNavigationConflict(current.navigationVersion);
    }
    const pages = await this.prisma.wikiPage.findMany({
      where: { spaceId: current.spaceId, pageType: { not: 'redirect' } },
      select: { id: true, title: true, localPath: true, displayTitle: true, status: true },
      orderBy: [{ localPath: 'asc' }, { id: 'asc' }],
    });
    let normalized: ServerWikiNavigationDocument;
    try {
      normalized = validateServerWikiNavigationDocument(
        document,
        pages.map((page) => page.id.toString()),
        8,
        pages.find((page) => serverWikiPageRelativePath(current.slug, page) === '')?.id.toString(),
      );
    } catch (error) {
      throw new BadRequestException({
        statusCode: 400,
        code: error instanceof Error ? error.message : 'SERVER_WIKI_NAVIGATION_INVALID_DOCUMENT',
        message: '서버 위키 문서 구조가 올바르지 않습니다.',
      });
    }
    const actor = await this.wikiProfiles.ensureWikiProfile(actorAccountId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.serverWiki.updateMany({
        where: { id: current.id, navigationVersion: expectedVersion },
        data: {
          navigationOrder: normalized as unknown as Prisma.InputJsonValue,
          navigationVersion: { increment: 1 },
          navigationUpdatedAt: new Date(),
          navigationUpdatedBy: actor.id,
        },
      });
      if (changed.count !== 1) {
        const latest = await tx.serverWiki.findUnique({
          where: { id: current.id },
          select: { navigationVersion: true },
        });
        throwWikiNavigationConflict(latest?.navigationVersion ?? expectedVersion + 1);
      }
      return tx.serverWiki.findUniqueOrThrow({
        where: { id: current.id },
        select: {
          id: true,
          spaceId: true,
          slug: true,
          siteSlug: true,
          navigationOrder: true,
          navigationVersion: true,
          navigationUpdatedAt: true,
          navigationUpdatedBy: true,
        },
      });
    });
    await this.events?.audit('server.wiki.navigation.update', {
      category: 'server',
      actorAccountId,
      actorProfileId: actor.id,
      subjectType: 'server_wiki',
      subjectId: current.id,
      metadata: {
        previousVersion: expectedVersion,
        version: updated.navigationVersion,
        pageCount: pages.length,
        groupCount: normalized.nodes.filter((node) => node.kind === 'group').length,
      },
    });
    return toWikiNavigationSettingsResponse(updated, pages);
  }

  async updateWikiContentSettings(
    serverId: string,
    input: ServerWikiContentSettingsInput,
    actorAccountId: string,
  ) {
    const normalized = normalizeServerWikiContentSettings(input);
    const current = await this.prisma.serverWiki.findUnique({
      where: { voteServerId: serverId },
      select: {
        id: true,
        slug: true,
        siteSlug: true,
        contributionPolicySource: true,
        editHelpSource: true,
        topNoticeSource: true,
        bottomNoticeSource: true,
        seoTitle: true,
        seoDescription: true,
        seoIndexingEnabled: true,
        requireContributionPolicyAck: true,
        contributionPolicyVersion: true,
        contentSettingsVersion: true,
      },
    });
    if (!current) throw new NotFoundException('Server wiki not found.');
    if (current.contentSettingsVersion !== normalized.expectedVersion) {
      throwWikiSettingsConflict(current.contentSettingsVersion);
    }

    const sourceFields = [
      'contributionPolicySource',
      'editHelpSource',
      'topNoticeSource',
      'bottomNoticeSource',
    ] as const;
    const changedFields: string[] = sourceFields.filter(
      (field) => current[field] !== normalized[field],
    );
    if (current.requireContributionPolicyAck !== normalized.requireContributionPolicyAck) {
      changedFields.push('requireContributionPolicyAck');
    }
    for (const field of ['seoTitle', 'seoDescription', 'seoIndexingEnabled'] as const) {
      if (current[field] !== normalized[field]) changedFields.push(field);
    }
    const policyChanged =
      current.contributionPolicySource !== normalized.contributionPolicySource
      || current.requireContributionPolicyAck !== normalized.requireContributionPolicyAck;
    const actor = await this.wikiProfiles.ensureWikiProfile(actorAccountId);
    const updated = await this.prisma.$transaction(async (tx) => {
      const result = await tx.serverWiki.updateMany({
        where: {
          id: current.id,
          contentSettingsVersion: normalized.expectedVersion,
        },
        data: {
          contributionPolicySource: normalized.contributionPolicySource,
          editHelpSource: normalized.editHelpSource,
          topNoticeSource: normalized.topNoticeSource,
          bottomNoticeSource: normalized.bottomNoticeSource,
          seoTitle: normalized.seoTitle,
          seoDescription: normalized.seoDescription,
          seoIndexingEnabled: normalized.seoIndexingEnabled,
          requireContributionPolicyAck: normalized.requireContributionPolicyAck,
          contributionPolicyVersion: policyChanged ? { increment: 1 } : undefined,
          contentSettingsVersion: { increment: 1 },
          contentSettingsUpdatedAt: new Date(),
          contentSettingsUpdatedBy: actor.id,
        },
      });
      if (result.count !== 1) {
        const latest = await tx.serverWiki.findUnique({
          where: { id: current.id },
          select: { contentSettingsVersion: true },
        });
        throwWikiSettingsConflict(latest?.contentSettingsVersion ?? normalized.expectedVersion + 1);
      }
      return tx.serverWiki.findUniqueOrThrow({
        where: { id: current.id },
        select: {
          id: true,
          slug: true,
          siteSlug: true,
          contributionPolicySource: true,
          editHelpSource: true,
          topNoticeSource: true,
          bottomNoticeSource: true,
          seoTitle: true,
          seoDescription: true,
          seoIndexingEnabled: true,
          requireContributionPolicyAck: true,
          contributionPolicyVersion: true,
          contentSettingsVersion: true,
          contentSettingsUpdatedAt: true,
          contentSettingsUpdatedBy: true,
        },
      });
    });

    await this.events?.audit('server.wiki.settings.update', {
      category: 'server',
      actorAccountId,
      actorProfileId: actor.id,
      subjectType: 'server_wiki',
      subjectId: current.id,
      metadata: {
        changedFields,
        previousVersion: current.contentSettingsVersion,
        version: updated.contentSettingsVersion,
        previousPolicyVersion: current.contributionPolicyVersion,
        policyVersion: updated.contributionPolicyVersion,
        sources: Object.fromEntries(sourceFields.map((field) => [
          field,
          sourceAuditSummary(updated[field]),
        ])),
      },
    });
    return toWikiContentSettingsResponse(updated);
  }

  async getWikiPresentationBySlug(slug: string, releaseId?: bigint) {
    const settings = await this.prisma.serverWiki.findUnique({
      where: { slug },
      select: {
        slug: true,
        contributionPolicySource: true,
        editHelpSource: true,
        topNoticeSource: true,
        bottomNoticeSource: true,
        seoTitle: true,
        seoDescription: true,
        seoIndexingEnabled: true,
        requireContributionPolicyAck: true,
        contributionPolicyVersion: true,
        contentSettingsVersion: true,
        publishedRelease: releaseId
          ? {
              select: { id: true, presentationSnapshot: true },
            }
          : false,
      },
    });
    if (!settings) throw new NotFoundException('Server wiki not found.');
    if (releaseId && settings.publishedRelease?.id !== releaseId) {
      throw new NotFoundException('Server wiki release not found.');
    }
    const snapshot = settings.publishedRelease?.presentationSnapshot
      && typeof settings.publishedRelease.presentationSnapshot === 'object'
      && !Array.isArray(settings.publishedRelease.presentationSnapshot)
      ? settings.publishedRelease.presentationSnapshot as Record<string, Prisma.JsonValue>
      : null;
    const presentationSettings = snapshot
      ? {
          contributionPolicySource: jsonNullableString(snapshot.contributionPolicySource),
          editHelpSource: jsonNullableString(snapshot.editHelpSource),
          topNoticeSource: jsonNullableString(snapshot.topNoticeSource),
          bottomNoticeSource: jsonNullableString(snapshot.bottomNoticeSource),
          requireContributionPolicyAck: snapshot.requireContributionPolicyAck === true,
          seoTitle: jsonNullableString(snapshot.seoTitle),
          seoDescription: jsonNullableString(snapshot.seoDescription),
          seoIndexingEnabled: snapshot.seoIndexingEnabled !== false,
        }
      : settings;
    const rendered = renderServerWikiPresentation(presentationSettings);
    return {
      slug: settings.slug,
      settingsVersion: snapshot && typeof snapshot.contentSettingsVersion === 'number'
        ? snapshot.contentSettingsVersion
        : settings.contentSettingsVersion,
      policy: {
        html: rendered.policyHtml,
        version: snapshot && typeof snapshot.contributionPolicyVersion === 'number'
          ? snapshot.contributionPolicyVersion
          : settings.contributionPolicyVersion,
        required: presentationSettings.requireContributionPolicyAck && Boolean(rendered.policyHtml),
      },
      editHelpHtml: rendered.editHelpHtml,
      topNoticeHtml: rendered.topNoticeHtml,
      bottomNoticeHtml: rendered.bottomNoticeHtml,
      seoTitle: presentationSettings.seoTitle,
      seoDescription: presentationSettings.seoDescription,
      seoIndexingEnabled: presentationSettings.seoIndexingEnabled,
    };
  }

  private async findServerWikiForServer(serverId: string, wikiSpaceId?: bigint | null) {
    const linkedByServer = await this.prisma.serverWiki.findUnique({
      where: { voteServerId: serverId },
    });
    if (linkedByServer || !wikiSpaceId) {
      return linkedByServer;
    }
    return this.prisma.serverWiki.findFirst({
      where: { spaceId: wikiSpaceId },
    });
  }

  private async generateUniqueServerWikiSlug(source: string, serverId: string): Promise<string> {
    const base = normalizeServerWikiSlug(source);
    const suffix = serverId.replace(/-/g, '').slice(0, 8);
    const first = `${base}-${suffix}`.slice(0, 255);
    if (await this.isServerWikiSlugAvailable(first)) {
      return first;
    }
    for (let attempt = 2; attempt < 20; attempt += 1) {
      const candidate = `${base}-${suffix}-${attempt}`.slice(0, 255);
      if (await this.isServerWikiSlugAvailable(candidate)) {
        return candidate;
      }
    }
    throw new Error('Failed to generate unique server wiki slug.');
  }

  private async isServerWikiSlugAvailable(slug: string): Promise<boolean> {
    const [serverWiki, space, namespace] = await Promise.all([
      this.prisma.serverWiki.findUnique({ where: { slug } }),
      this.prisma.wikiSpace.findFirst({
        where: {
          OR: [{ slug }, { rootPath: `/server/${slug}` }],
        },
      }),
      this.prisma.wikiNamespace.findUnique({ where: { code: 'server' } }),
    ]);
    if (serverWiki || space) {
      return false;
    }
    if (!namespace) {
      return true;
    }
    const page = await this.prisma.wikiPage.findUnique({
      where: {
        namespaceId_slug: {
          namespaceId: namespace.id,
          slug,
        },
      },
    });
    return !page;
  }

  private async generateUniqueShortCode(): Promise<string> {
    for (let attempt = 0; attempt < 16; attempt += 1) {
      const shortCode = generateShortCode();
      const existing = await this.prisma.server.findUnique({
        where: { shortCode },
        select: { id: true },
      });
      if (!existing) {
        return shortCode;
      }
    }
    throw new Error('Failed to generate unique server short code.');
  }
}

function jsonNullableString(value: Prisma.JsonValue | undefined): string | null {
  return typeof value === 'string' ? value : null;
}

export function downsamplePingSamples<T>(samples: readonly T[], maxSamples = 96): T[] {
  if (maxSamples < 2 || samples.length <= maxSamples) {
    return [...samples];
  }
  const lastIndex = samples.length - 1;
  const selected: T[] = [];
  let previousIndex = -1;
  for (let slot = 0; slot < maxSamples; slot += 1) {
    const index = Math.round((slot / (maxSamples - 1)) * lastIndex);
    if (index !== previousIndex) {
      selected.push(samples[index]);
      previousIndex = index;
    }
  }
  return selected;
}

export interface ServerWikiLinkRequest {
  readonly serverWikiId?: string;
  readonly spaceId?: string;
  readonly wikiSlug?: string;
}

export interface ServerWikiLinkOptions {
  readonly allowTargetAuthorityBypass?: boolean;
}

export interface ServerWikiLinkResponse {
  readonly serverId: string;
  readonly serverWikiId: string | null;
  readonly wikiSpaceId: string | null;
  readonly wikiPageId: string | null;
  readonly wikiSlug: string | null;
  readonly wikiUrl: string | null;
  readonly serverDirectoryPath: string;
  readonly status: 'linked' | 'unlinked';
}

export interface ServerWikiReadinessResponse {
  readonly serverId: string;
  readonly status: 'unlinked' | 'repair_required' | 'needs_attention' | 'ready';
  readonly wikiUrl: string | null;
  readonly completedChecks: number;
  readonly totalChecks: number;
  readonly checks: {
    readonly canonicalLink: boolean;
    readonly requiredDocuments: boolean;
    readonly introduction: boolean;
    readonly officialRules: boolean;
    readonly officialChannels: boolean;
    readonly searchIndex: boolean;
  };
  readonly requiredDocuments: Readonly<Record<string, boolean>>;
  readonly nextAction: {
    readonly code: 'create_wiki' | 'repair_link' | 'restore_documents' | 'write_rules' | 'write_introduction' | 'add_official_channels' | 'repair_search_index';
    readonly label: string;
    readonly href: string;
  } | null;
}

interface ServerWikiContentSettingsRecord {
  readonly id: bigint;
  readonly slug: string;
  readonly siteSlug: string | null;
  readonly contributionPolicySource: string | null;
  readonly editHelpSource: string | null;
  readonly topNoticeSource: string | null;
  readonly bottomNoticeSource: string | null;
  readonly seoTitle: string | null;
  readonly seoDescription: string | null;
  readonly seoIndexingEnabled: boolean;
  readonly requireContributionPolicyAck: boolean;
  readonly contributionPolicyVersion: number;
  readonly contentSettingsVersion: number;
  readonly contentSettingsUpdatedAt: Date | null;
  readonly contentSettingsUpdatedBy: bigint | null;
}

interface ServerWikiNavigationSettingsRecord {
  readonly id: bigint;
  readonly spaceId: bigint;
  readonly slug: string;
  readonly siteSlug: string | null;
  readonly navigationOrder: Prisma.JsonValue | null;
  readonly navigationVersion: number;
  readonly navigationUpdatedAt: Date | null;
  readonly navigationUpdatedBy: bigint | null;
}

function toWikiNavigationSettingsResponse(
  settings: ServerWikiNavigationSettingsRecord,
  pages: ReadonlyArray<{
    readonly id: bigint;
    readonly title: string;
    readonly localPath: string;
    readonly displayTitle: string;
    readonly status: string;
  }>,
) {
  const siteSlug = settings.siteSlug ?? settings.slug;
  const tree = resolveServerWikiNavigationTree(settings.slug, pages, settings.navigationOrder);
  return {
    serverWikiId: settings.id.toString(),
    version: settings.navigationVersion,
    updatedAt: settings.navigationUpdatedAt?.toISOString() ?? null,
    updatedByProfileId: settings.navigationUpdatedBy?.toString() ?? null,
    document: {
      version: 1 as const,
      nodes: tree.map((node) => node.kind === 'group'
        ? { id: node.id, kind: 'group' as const, title: node.title, parentId: node.parentId }
        : { id: node.id, kind: 'page' as const, pageId: node.page.id.toString(), parentId: node.parentId }),
    },
    items: tree.map((node) => node.kind === 'group'
      ? { id: node.id, kind: 'group' as const, title: node.title, parentId: node.parentId, depth: node.depth }
      : {
          id: node.id,
          kind: 'page' as const,
          pageId: node.page.id.toString(),
          title: node.page.displayTitle,
          path: buildCanonicalServerWikiPath(siteSlug, node.page.title, settings.slug, '/serverWiki'),
          status: node.page.status,
          parentId: node.parentId,
          depth: node.depth,
        }),
  };
}

function toWikiContentSettingsResponse(settings: ServerWikiContentSettingsRecord) {
  return {
    serverWikiId: settings.id.toString(),
    slug: settings.slug,
    siteSlug: settings.siteSlug ?? settings.slug,
    wikiUrl: `/serverWiki/${encodeURIComponent(settings.siteSlug ?? settings.slug)}`,
    version: settings.contentSettingsVersion,
    contributionPolicyVersion: settings.contributionPolicyVersion,
    contributionPolicySource: settings.contributionPolicySource,
    editHelpSource: settings.editHelpSource,
    topNoticeSource: settings.topNoticeSource,
    bottomNoticeSource: settings.bottomNoticeSource,
    seoTitle: settings.seoTitle,
    seoDescription: settings.seoDescription,
    seoIndexingEnabled: settings.seoIndexingEnabled,
    requireContributionPolicyAck: settings.requireContributionPolicyAck,
    updatedAt: settings.contentSettingsUpdatedAt?.toISOString() ?? null,
    updatedByProfileId: settings.contentSettingsUpdatedBy?.toString() ?? null,
  };
}

function throwWikiSettingsConflict(currentVersion: number): never {
  throw new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_SETTINGS_CONFLICT',
    message: '다른 관리자가 서버 위키 설정을 먼저 변경했습니다.',
    currentVersion,
  });
}

function throwWikiNavigationConflict(currentVersion: number): never {
  throw new ConflictException({
    statusCode: 409,
    code: 'SERVER_WIKI_NAVIGATION_CONFLICT',
    message: '다른 관리자가 서버 위키 문서 구조를 먼저 변경했습니다.',
    currentVersion,
  });
}

export interface VerificationRecheckOptions {
  readonly passed: boolean;
  readonly checkedAt?: string;
  readonly reason?: string;
}

export interface VerificationRecheckResult {
  readonly serverId: string;
  readonly grade: ServerDetail['verificationGrade'];
  readonly previousGrade: ServerDetail['verificationGrade'];
  readonly downgraded: boolean;
  readonly checkedAt: string;
  readonly reason: string;
}

function normalizeTimestamp(timestamp?: string): string {
  if (timestamp) {
    const parsed = new Date(timestamp);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }
  return new Date().toISOString();
}

export function buildOrder(sort: ServerSort): Prisma.ServerOrderByWithRelationInput[] {
  switch (sort) {
    case 'votesMonthly_desc':
      return [{ votesMonthly: 'desc' }, { name: 'asc' }];
    case 'reviews_desc':
      return [{ reviewsCount: 'desc' }, { name: 'asc' }];
    case 'playersOnline_desc':
      return [
        { isOnline: { sort: 'desc', nulls: 'last' } },
        { playersMetricTrust: 'asc' },
        { playersOnline: { sort: 'desc', nulls: 'last' } },
        { name: 'asc' },
      ];
    case 'name_asc':
      return [{ name: 'asc' }];
    case 'latest':
      return [{ createdAt: 'desc' }, { name: 'asc' }];
    case 'votes24h_desc':
    default:
      return [
        { votes24h: 'desc' },
        { stats: { votesLast7d: 'desc' } },
        { reviewsCount: 'desc' },
        { name: 'asc' },
      ];
  }
}

export function buildRankingOrder(sort: ServerSort): Prisma.ServerOrderByWithRelationInput[] {
  if (sort === 'votes24h_desc') {
    return [{ stats: { rankCurrent: 'asc' } }, { name: 'asc' }];
  }
  return buildOrder(sort);
}

function normalizeServerLookup(value: string): Prisma.ServerWhereUniqueInput {
  const normalized = value.trim().toLowerCase();
  if (UUID_PATTERN.test(normalized)) {
    return { id: normalized };
  }
  if (!SHORT_CODE_PATTERN.test(normalized)) {
    throw new NotFoundException(`Server ${value} not found`);
  }
  return { shortCode: normalized };
}

function generateShortCode(): string {
  let value = '';
  for (let index = 0; index < SHORT_CODE_LENGTH; index += 1) {
    value += SHORT_CODE_ALPHABET[randomInt(SHORT_CODE_ALPHABET.length)];
  }
  return value;
}

function isUniqueConstraintError(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}

function isEndpointUniqueConstraintError(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
    return false;
  }
  const target = error.meta?.target;
  return Array.isArray(target)
    ? target.includes('registrationEndpointKey')
    : String(target ?? '').includes('registrationEndpointKey');
}

function createRegistrationEndpointKey(
  edition: ServerDetail['edition'],
  host: string,
  port: number,
): string {
  return createHash('sha256').update(`${edition}:${host}:${port}`).digest('hex');
}


function normalizeServerWikiSelector(
  input: ServerWikiLinkRequest,
): Prisma.ServerWikiWhereInput | null {
  if (input.serverWikiId?.trim()) {
    return { id: parseUnsignedBigInt(input.serverWikiId, 'serverWikiId') };
  }
  if (input.spaceId?.trim()) {
    return { spaceId: parseUnsignedBigInt(input.spaceId, 'spaceId') };
  }
  if (input.wikiSlug?.trim()) {
    return { slug: input.wikiSlug.trim() };
  }
  return null;
}

async function resolveCanonicalAccountId(
  tx: Prisma.TransactionClient,
  accountId: string,
  requireSeedActive: boolean,
): Promise<string> {
  const visited = new Set<string>();
  let currentId = accountId;
  for (let depth = 0; depth < 8; depth += 1) {
    if (visited.has(currentId)) {
      throw new ConflictException('Canonical account ownership contains a cycle.');
    }
    visited.add(currentId);
    const account = await tx.account.findUnique({
      where: { id: currentId },
      select: { id: true, canonicalAccountId: true, lifecycleStatus: true },
    });
    if (!account) {
      throw new ForbiddenException('Canonical account owner could not be resolved.');
    }
    if (depth === 0 && requireSeedActive && account.lifecycleStatus !== 'active') {
      throw new ForbiddenException('Canonical account owner is not active.');
    }
    const nextId = account.canonicalAccountId;
    if (!nextId || nextId === account.id) {
      if (account.lifecycleStatus !== 'active') {
        throw new ForbiddenException('Canonical account owner is not active.');
      }
      return account.id;
    }
    currentId = nextId;
  }
  throw new ConflictException('Canonical account ownership chain is too deep.');
}

function parseUnsignedBigInt(value: string, label: string): bigint {
  const trimmed = value.trim();
  if (!/^\d+$/.test(trimmed)) {
    throw new BadRequestException(`${label} must be an unsigned integer.`);
  }
  return BigInt(trimmed);
}

function normalizeServerWikiSlug(source: string): string {
  const normalized = source
    .trim()
    .normalize('NFKC')
    .toLowerCase()
    .replace(/['']/g, '')
    .replace(/[^\p{Letter}\p{Number}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || 'server';
}

function toServerWikiLinkResponse(
  server: {
    id: string;
    shortCode?: string | null;
    wikiSpaceId?: bigint | null;
    wikiPageId?: bigint | null;
    wikiSlug?: string | null;
  },
  serverWiki: { id: bigint; spaceId: bigint; slug: string; siteSlug?: string | null } | null,
): ServerWikiLinkResponse {
  const wikiSlug = server.wikiSlug ?? serverWiki?.slug ?? null;
  const siteSlug = serverWiki?.siteSlug ?? wikiSlug;
  const wikiSpaceId = server.wikiSpaceId?.toString() ?? serverWiki?.spaceId.toString() ?? null;
  const linked = Boolean(wikiSlug && wikiSpaceId);
  return {
    serverId: server.id,
    serverWikiId: serverWiki?.id.toString() ?? null,
    wikiSpaceId,
    wikiPageId: server.wikiPageId?.toString() ?? null,
    wikiSlug,
    wikiUrl: siteSlug ? `/serverWiki/${encodeURIComponent(siteSlug)}` : null,
    serverDirectoryPath: buildServerDirectoryPath(server),
    status: linked ? 'linked' : 'unlinked',
  };
}

function hasCanonicalServerWikiLink(
  server: { wikiSpaceId?: bigint | null; wikiSlug?: string | null; name: string; joinHost: string },
  serverWiki: Pick<ServerWiki, 'spaceId' | 'slug' | 'status' | 'serverName' | 'host'> | null,
): boolean {
  return Boolean(
    serverWiki
    && serverWiki.status === 'active'
    && serverWiki.slug === server.wikiSlug
    && serverWiki.spaceId === server.wikiSpaceId
    && !serverWikiIdentityConflicts(serverWiki, server),
  );
}

function hasCanonicalPublishedServerWikiLink(
  server: { wikiSpaceId?: bigint | null; wikiSlug?: string | null; name: string; joinHost: string },
  serverWiki: Pick<ServerWiki, 'spaceId' | 'slug' | 'status' | 'serverName' | 'host' | 'publicationStatus' | 'publishedReleaseId'> | null,
): boolean {
  return hasCanonicalServerWikiLink(server, serverWiki)
    && serverWiki?.publicationStatus === 'published'
    && serverWiki.publishedReleaseId !== null;
}

function emptyServerWikiReadiness(
  serverId: string,
  status: 'unlinked' | 'repair_required',
): ServerWikiReadinessResponse {
  return {
    serverId,
    status,
    wikiUrl: null,
    completedChecks: 0,
    totalChecks: 6,
    checks: {
      canonicalLink: false,
      requiredDocuments: false,
      introduction: false,
      officialRules: false,
      officialChannels: false,
      searchIndex: false,
    },
    requiredDocuments: {},
    nextAction: status === 'unlinked'
      ? { code: 'create_wiki', label: '서버 위키 만들기', href: '#server-wiki-management' }
      : { code: 'repair_link', label: '연결 복구 요청하기', href: '/support/new' },
  };
}

function buildServerDirectoryPath(server: { id: string; shortCode?: string | null }): string {
  return `/servers/${server.shortCode?.trim() || server.id}`;
}

function toSummary(server: {
  id: string;
  shortCode?: string | null;
  wikiSpaceId?: bigint | null;
  wikiPageId?: bigint | null;
  wikiSlug?: string | null;
  name: string;
  joinHost: string;
  joinPort: number;
  edition: ServerDetail['edition'];
  supportedVersions: Prisma.JsonValue;
  tags: Prisma.JsonValue;
  shortDescription?: string | null;
  verificationGrade: StoredVerificationGrade;
  verifiedAt: Date | null;
  votes24h: number;
  votesMonthly: number | null;
  reviewsCount: number;
  voteRequiresOwnership: boolean;
  bannerUrl: string | null;
  websiteUrl: string | null;
  playersOnline: number | null;
  playersMax: number | null;
  playersLastUpdatedAt: Date | null;
  playersMetricTrust?: 'trusted' | 'self_reported' | 'anomalous' | 'unknown';
  playersMetricSource?: 'status_ping' | null;
  playersAnomalyReason?: string | null;
  isOnline: boolean | null;
  latencyMs: number | null;
  stats?: {
    rankCurrent: number;
    rankDelta24h: number;
    rankBest: number;
    votesTotal: number;
    rankCalculatedAt: Date | null;
    lastUpdatedAt: Date;
  } | null;
}): ServerSummary {
  const supportedVersions = normalizeStringArray(server.supportedVersions);
  const tags = normalizeStringArray(server.tags);
  const playerMetric = assessPlayerMetric({
    online: server.isOnline === true,
    playersOnline: server.playersOnline,
    playersMax: server.playersMax,
    serverVerified: server.verificationGrade !== 'Unverified',
  });
  return {
    id: server.id,
    shortCode: server.shortCode ?? null,
    wikiSpaceId: server.wikiSpaceId?.toString() ?? null,
    wikiPageId: server.wikiPageId?.toString() ?? null,
    wikiSlug: server.wikiSlug ?? null,
    name: server.name,
    joinHost: server.joinHost,
    joinPort: server.joinPort,
    edition: server.edition,
    supportedVersions,
    tags,
    shortDescription: normalizeShortDescription(server.shortDescription),
    verificationGrade: toPublicVerificationGrade(server.verificationGrade),
    verifiedAt: server.verifiedAt ? server.verifiedAt.toISOString() : undefined,
    votes24h: server.votes24h,
    votesMonthly: server.votesMonthly ?? undefined,
    reviewsCount: server.reviewsCount,
    voteRequiresOwnership: server.voteRequiresOwnership,
    bannerUrl: server.bannerUrl ?? null,
    websiteUrl: server.websiteUrl ?? null,
    playersOnline: server.playersOnline ?? null,
    playersMax: server.playersMax ?? null,
    playersLastUpdatedAt: server.playersLastUpdatedAt
      ? server.playersLastUpdatedAt.toISOString()
      : null,
    playersMetricTrust: server.playersMetricTrust ?? playerMetric.trust,
    playersMetricSource: server.playersMetricSource ?? playerMetric.source,
    playersAnomalyReason: server.playersAnomalyReason ?? playerMetric.anomalyReason,
    isOnline: server.isOnline ?? null,
    latencyMs: server.latencyMs ?? null,
    rank:
      server.stats &&
      server.stats.rankCalculatedAt &&
      server.stats.votesTotal > 0 &&
      server.stats.rankCurrent > 0 &&
      server.stats.rankBest > 0
      ? {
          current: server.stats.rankCurrent,
          delta24h: server.stats.rankDelta24h,
          best: server.stats.rankBest,
          updatedAt: server.stats.rankCalculatedAt.toISOString(),
        }
      : null,
  };
}

function normalizeShortDescription(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'No description';
}

async function finalizeCreatedServerWikiPage(
  tx: Prisma.TransactionClient,
  input: {
    readonly page: {
      readonly id: bigint;
      readonly spaceId: bigint;
      readonly localPath: string;
      readonly title: string;
      readonly displayTitle: string;
    };
    readonly revision: {
      readonly id: bigint;
      readonly contentSize: number;
      readonly editSummary: string;
      readonly isMinor: boolean;
    };
    readonly contentRaw: string;
    readonly namespaceCode: string;
    readonly actorId: bigint;
    readonly now: Date;
    readonly wikiLinks?: WikiLinkIndexService;
  },
): Promise<void> {
  await tx.wikiPage.update({
    where: { id: input.page.id },
    data: {
      currentRevisionId: input.revision.id,
      currentContentSize: input.revision.contentSize,
      updatedAt: input.now,
    },
  });
  if (input.wikiLinks) {
    const parsed = parseMarkup(input.contentRaw);
    await input.wikiLinks.replaceForRevision(
      tx,
      input.page.id,
      input.revision.id,
      parsed.links,
      parsed.categories,
      parsed.includes,
      {
        contentSize: input.revision.contentSize,
        contentRaw: input.contentRaw,
        fileNames: [],
        redirectTarget: parsed.redirectTarget,
      },
    );
  } else {
    await tx.wikiSearchDocument.create({
      data: {
        pageId: input.page.id,
        revisionId: input.revision.id,
        searchVector: buildWikiSearchVector([
          input.page.title,
          input.page.displayTitle,
          input.contentRaw,
        ]),
        updatedAt: input.now,
      },
    });
  }
  await tx.wikiRecentChange.create({
    data: {
      pageId: input.page.id,
      revisionId: input.revision.id,
      previousPublicRevisionId: null,
      actorId: input.actorId,
      spaceId: input.page.spaceId,
      changeType: 'create',
      title: input.page.title,
      localPath: input.page.localPath,
      namespaceCode: input.namespaceCode,
      summary: input.revision.editSummary,
      sizeDelta: input.revision.contentSize,
      eventAudience: 'restricted',
      isMinor: input.revision.isMinor,
      createdAt: input.now,
    },
  });
}

function toDetail(
  server: {
    id: string;
    shortCode?: string | null;
    wikiSpaceId?: bigint | null;
    wikiPageId?: bigint | null;
    wikiSlug?: string | null;
    name: string;
    joinHost: string;
    joinPort: number;
    edition: ServerDetail['edition'];
    supportedVersions: Prisma.JsonValue;
    tags: Prisma.JsonValue;
    shortDescription?: string | null;
    longDescription: string;
    bannerUrl: string | null;
    websiteUrl: string | null;
    discordUrl: string | null;
    voteCooldownHours: number;
    verificationGrade: StoredVerificationGrade;
    verifiedAt: Date | null;
    votes24h: number;
    votesMonthly: number | null;
    reviewsCount: number;
    voteRequiresOwnership: boolean;
    createdAt: Date;
    updatedAt: Date;
    playersOnline: number | null;
    playersMax: number | null;
    playersLastUpdatedAt: Date | null;
    isOnline: boolean | null;
    latencyMs: number | null;
    stats?: {
      rankCurrent: number;
      rankDelta24h: number;
      rankBest: number;
      votesTotal: number;
      rankCalculatedAt: Date | null;
      lastUpdatedAt: Date;
    } | null;
  },
  verificationMethods: readonly ClaimMethod[],
): ServerDetail {
  return {
    ...toSummary(server),
    longDescription: server.longDescription,
    bannerUrl: server.bannerUrl ?? null,
    websiteUrl: server.websiteUrl ?? null,
    discordUrl: server.discordUrl ?? null,
    voteCooldownHours: server.voteCooldownHours,
    verificationMethods: [...verificationMethods],
    createdAt: server.createdAt.toISOString(),
    lastUpdatedAt: server.updatedAt.toISOString(),
  };
}

function toPublicVerificationGrade(
  grade: StoredVerificationGrade,
): ServerDetail['verificationGrade'] {
  return grade === 'Unverified' ? 'Unverified' : 'Verified';
}

function normalizeStringArray(value: Prisma.JsonValue | string[] | null | undefined): string[] {
  if (!value) {
    return [];
  }
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
}

function normalizeNumberArray(value: Prisma.JsonValue | number[] | null | undefined): number[] {
  if (!value) {
    return [];
  }
  const items = Array.isArray(value) ? value : [];
  return items
    .map((item) => (typeof item === 'number' ? item : Number(item)))
    .filter((item) => Number.isFinite(item));
}

function normalizeUpdateLimit(limit?: number): number {
  if (!Number.isFinite(limit)) {
    return 12;
  }
  const normalized = Math.floor(limit as number);
  return Math.max(3, Math.min(30, normalized));
}

function ellipsize(value: string, maxLength: number): string {
  const trimmed = value.trim();
  if (trimmed.length <= maxLength) {
    return trimmed;
  }
  return `${trimmed.slice(0, Math.max(0, maxLength - 1))}…`;
}


function shouldRefreshLiveStats(lastPingAt: Date | null, sampleCount: number): boolean {
  if (sampleCount === 0) {
    return true;
  }
  if (!lastPingAt) {
    return true;
  }
  return Date.now() - lastPingAt.getTime() > LIVE_STATS_REFRESH_MS;
}

async function resolveLiveProbeTarget(input: {
  host: string;
  port: number;
  edition: ServerDetail['edition'];
}): Promise<{ host: string; port: number } | null> {
  const baseOptions = {
    label: 'Server stats live probe',
    allowIpv6: LIVE_PING_ALLOW_IPV6,
  } as const;
  try {
    const target = await validateOutboundTarget(input.host, input.port, baseOptions);
    const address = target.addresses.find((entry) => entry.family === 4) ?? target.addresses[0];
    if (!address) {
      throw new UnsafeEndpointError('resolve_failed', 'Server stats live probe: no validated address');
    }
    return {
      host: address.address,
      port: target.port,
    };
  } catch (error) {
    if (
      input.edition === 'java' &&
      error instanceof UnsafeEndpointError &&
      error.reason === 'resolve_failed'
    ) {
      const srvTarget = await resolveJavaSrvTarget(input.host);
      if (srvTarget) {
        try {
          const validated = await validateOutboundTarget(srvTarget.host, srvTarget.port, {
            ...baseOptions,
            label: 'Server stats live probe (SRV)',
          });
          const address = validated.addresses.find((entry) => entry.family === 4) ?? validated.addresses[0];
          if (!address) {
            throw new UnsafeEndpointError('resolve_failed', 'Server stats live probe (SRV): no validated address');
          }
          return {
            host: address.address,
            port: validated.port,
          };
        } catch (srvError) {
          Logger.warn(
            {
              err: srvError,
              host: input.host,
              port: input.port,
              resolvedHost: srvTarget.host,
              resolvedPort: srvTarget.port,
            },
            'Server stats SRV target validation failed',
          );
        }
      }
    }
    Logger.warn(
      { err: error, host: input.host, port: input.port, edition: input.edition },
      'Server stats target validation failed',
    );
    return null;
  }
}

async function resolveJavaSrvTarget(host: string): Promise<{ host: string; port: number } | null> {
  const normalizedHost = host.trim();
  if (!normalizedHost || isIP(normalizedHost) !== 0) {
    return null;
  }
  try {
    const records = await resolveSrv(`_minecraft._tcp.${normalizedHost}`);
    if (!records || records.length === 0) {
      return null;
    }
    const [selected] = [...records].sort(
      (left, right) => left.priority - right.priority || right.weight - left.weight,
    );
    if (!selected) {
      return null;
    }
    const resolvedHost = selected.name.trim().replace(/\.$/, '');
    if (!resolvedHost) {
      return null;
    }
    return {
      host: resolvedHost,
      port: selected.port,
    };
  } catch {
    return null;
  }
}

function parseBooleanEnv(raw: string | undefined): boolean {
  if (!raw) {
    return false;
  }
  const normalized = raw.trim().toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on';
}

function extractPlayers(response: unknown): { online: number | null; max: number | null } {
  if (!response || typeof response !== 'object') {
    return { online: null, max: null };
  }
  const data = response as {
    players?: { online?: number; max?: number };
    onlinePlayers?: number;
    maxPlayers?: number;
  };
  const online =
    typeof data.players === 'object' && data.players
      ? Number(data.players.online ?? data.onlinePlayers ?? Number.NaN)
      : Number(data.onlinePlayers ?? Number.NaN);
  const max =
    typeof data.players === 'object' && data.players
      ? Number(data.players.max ?? data.maxPlayers ?? Number.NaN)
      : Number(data.maxPlayers ?? Number.NaN);
  return {
    online: Number.isFinite(online) ? online : null,
    max: Number.isFinite(max) ? max : null,
  };
}

function extractLatency(response: unknown): number | null {
  if (!response || typeof response !== 'object') {
    return null;
  }
  const data = response as { roundTripLatency?: number; latency?: number; ping?: number };
  const latency = data.roundTripLatency ?? data.latency ?? data.ping ?? Number.NaN;
  return Number.isFinite(latency) ? latency : null;
}

function extractMotd(response: unknown): string | null {
  if (!response || typeof response !== 'object') {
    return null;
  }
  const data = response as {
    motd?: string | { clean?: string | string[]; raw?: string | string[] };
  };
  if (typeof data.motd === 'string') {
    return data.motd;
  }
  if (data.motd && typeof data.motd === 'object') {
    const motd = data.motd;
    if (typeof motd.clean === 'string') {
      return motd.clean;
    }
    if (Array.isArray(motd.clean)) {
      return motd.clean.join(' ');
    }
    if (typeof motd.raw === 'string') {
      return motd.raw;
    }
    if (Array.isArray(motd.raw)) {
      return motd.raw.join(' ');
    }
  }
  return null;
}

function extractVersion(response: unknown): string | null {
  if (!response || typeof response !== 'object') {
    return null;
  }
  const data = response as { version?: { name?: string; nameRaw?: string }; versionName?: string };
  if (data.version && typeof data.version.name === 'string') {
    return data.version.name;
  }
  if (data.version && typeof data.version.nameRaw === 'string') {
    return data.version.nameRaw;
  }
  if (typeof data.versionName === 'string') {
    return data.versionName;
  }
  return null;
}
