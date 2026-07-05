import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { Logger } from '@minewiki/logger';
import { UnsafeEndpointError, validateOutboundTarget } from '@minewiki/security';
import { hashContent, parseMarkup } from '@minewiki/wiki-core';
import type {
  ServerDetail,
  ServerStats,
  ServerSummary,
  ServerUpdate,
  VotifierTarget,
} from '@minewiki/schemas';
import { Prisma } from '@prisma/client';
import { status, statusBedrock } from 'minecraft-server-util';
import { resolveSrv } from 'node:dns/promises';
import { randomInt } from 'node:crypto';
import { isIP } from 'node:net';
import { PrismaService } from '../common/prisma.service';
import { type StoredVerificationGrade, type ServerFilters, type ServerSort } from './server.store';
import { FileService, type FileImageUploadRequest, type FileImageUploadResponse } from '../file/file.service';
import { FirestoreTelemetryService } from '../telemetry/firestore-telemetry.service';
import type { ClaimMethod } from '../claim/claim.types';
import { WikiProfileService } from '../wiki/wiki-profile.service';

const ALL_METHODS: ClaimMethod[] = ['plugin', 'dns', 'motd'];
const LIVE_STATS_REFRESH_MS = 2 * 60 * 1000;
const LIVE_PING_TIMEOUT_MS = 5000;
const SAMPLE_RETENTION_DAYS = 7;
const UPTIME_WINDOW_HOURS = 24;
const LIVE_PING_ALLOW_IPV6 = parseBooleanEnv(process.env.SERVER_PING_ALLOW_IPV6);
const SHORT_CODE_ALPHABET = '23456789abcdefghjkmnpqrstuvwxyz';
const SHORT_CODE_LENGTH = 7;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SHORT_CODE_PATTERN = /^[a-z0-9]{5,12}$/;

@Injectable()
export class ServerService {
  private readonly telemetry: Pick<FirestoreTelemetryService, 'record'>;

  constructor(
    private readonly files: FileService,
    private readonly prisma: PrismaService,
    private readonly wikiProfiles: WikiProfileService,
    @Optional() private readonly firestoreTelemetry?: FirestoreTelemetryService,
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
        },
        orderBy: buildOrder(sort),
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
  async detail(idOrShortCode: string): Promise<ServerDetail> {
    const startedAt = Date.now();
    const lookup = normalizeServerLookup(idOrShortCode);
    try {
      const server = await this.prisma.server.findUnique({ where: lookup });
      if (!server) {
        throw new NotFoundException(`Server ${idOrShortCode} not found`);
      }
      const methods = await this.prisma.serverClaimMethod.findMany({
        where: { serverId: server.id },
        select: { method: true },
      });
      const verificationMethods = methods
        .map((method) => method.method)
        .filter(isSupportedClaimMethod)
        .filter((method, index, array) => array.indexOf(method) === index);
      const detail = toDetail(
        server,
        verificationMethods.length > 0 ? verificationMethods : ALL_METHODS,
      );
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
            method: { in: ALL_METHODS },
            verifiedAt: { not: null },
          },
          orderBy: { verifiedAt: 'desc' },
          take: 5,
          select: { method: true, verifiedAt: true },
        }),
        this.prisma.serverReview.findMany({
          where: { serverId: id },
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
    return toServerWikiLinkResponse(server, serverWiki);
  }

  async createServerWiki(serverId: string, accountId: string): Promise<ServerWikiLinkResponse> {
    const server = await this.ensureExists(serverId);
    const existing = await this.findServerWikiForServer(server.id, server.wikiSpaceId);
    if (existing) {
      if (server.wikiSpaceId && server.wikiPageId && server.wikiSlug) {
        return toServerWikiLinkResponse(server, existing);
      }
      return this.linkServerWiki(server.id, { serverWikiId: existing.id.toString() });
    }

    const actor = await this.wikiProfiles.ensureWikiProfile(accountId);
    const now = new Date();
    const slug = await this.generateUniqueServerWikiSlug(
      server.wikiSlug ?? server.shortCode ?? server.joinHost ?? server.name,
      server.id,
    );
    const contentRaw = buildServerMainPageContent(server);

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
          host: server.joinHost,
          port: server.joinPort,
          edition: server.edition,
          supportedVersions: normalizeStringArray(server.supportedVersions).join(', ') || null,
          genres: normalizeStringArray(server.tags).join(', ') || null,
          verifiedStatus: server.verificationGrade === 'Unverified' ? 'none' : 'verified',
          status: 'active',
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
      await tx.wikiPage.update({
        where: { id: page.id },
        data: {
          currentRevisionId: revision.id,
          updatedAt: now,
        },
      });
      await tx.wikiSpace.update({
        where: { id: space.id },
        data: {
          rootPageId: page.id,
          updatedAt: now,
        },
      });
      await tx.wikiRecentChange.create({
        data: {
          pageId: page.id,
          revisionId: revision.id,
          actorId: actor.id,
          changeType: 'create',
          title: page.title,
          namespaceCode: namespace.code,
          summary: revision.editSummary,
          isMinor: revision.isMinor,
          createdAt: now,
        },
      });
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

    return toServerWikiLinkResponse(linked.server, linked.serverWiki);
  }

  async linkServerWiki(
    serverId: string,
    input: ServerWikiLinkRequest,
  ): Promise<ServerWikiLinkResponse> {
    const server = await this.ensureExists(serverId);
    const selector = normalizeServerWikiSelector(input);
    if (!selector) {
      throw new BadRequestException('serverWikiId, spaceId, or wikiSlug is required.');
    }

    const serverWiki = await this.prisma.serverWiki.findFirst({ where: selector });
    if (!serverWiki) {
      throw new NotFoundException('Server wiki link target not found.');
    }
    if (serverWiki.voteServerId && serverWiki.voteServerId !== server.id) {
      throw new ConflictException('Server wiki is already linked to another server.');
    }

    const linked = await this.prisma.$transaction(async (tx) => {
      const space = await tx.wikiSpace.findUnique({ where: { id: serverWiki.spaceId } });
      const page = space?.rootPageId
        ? await tx.wikiPage.findUnique({ where: { id: space.rootPageId } })
        : await tx.wikiPage.findFirst({
            where: { spaceId: serverWiki.spaceId, status: { not: 'deleted' } },
            orderBy: [{ updatedAt: 'desc' }],
          });
      const updatedServerWiki = await tx.serverWiki.update({
        where: { id: serverWiki.id },
        data: {
          voteServerId: server.id,
          serverName: server.name,
          host: server.joinHost,
          port: server.joinPort,
          edition: server.edition,
          updatedAt: new Date(),
        },
      });
      const updatedServer = await tx.server.update({
        where: { id: server.id },
        data: {
          wikiSpaceId: serverWiki.spaceId,
          wikiPageId: page?.id ?? null,
          wikiSlug: serverWiki.slug,
        },
      });
      return { server: updatedServer, serverWiki: updatedServerWiki };
    });

    return toServerWikiLinkResponse(linked.server, linked.serverWiki);
  }

  async incrementReviewCount(id: string): Promise<void> {
    await this.prisma.server.update({
      where: { id },
      data: { reviewsCount: { increment: 1 } },
    });
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
    return toDetail(updated, ALL_METHODS);
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
      token: target.token ?? undefined,
      publicKey: target.publicKey ?? undefined,
    }));
  }

  async updateVotifierTargets(serverId: string, targets: VotifierTarget[]): Promise<void> {
    await this.prisma.$transaction([
      this.prisma.votifierTarget.deleteMany({ where: { serverId } }),
      this.prisma.votifierTarget.createMany({
        data: targets.map((target) => ({
          serverId,
          protocol: target.protocol,
          host: target.host,
          port: target.port,
          token: target.token ?? null,
          publicKey: target.publicKey ?? null,
        })),
      }),
    ]);
  }

  async remove(id: string): Promise<void> {
    const startedAt = Date.now();
    try {
      await this.ensureExists(id);
      await this.prisma.server.delete({
        where: { id },
      });
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
  }): Promise<ServerDetail> {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const shortCode = await this.generateUniqueShortCode();
      try {
        const server = await this.prisma.server.create({
          data: {
            shortCode,
            name: serverInput.name,
            joinHost: serverInput.joinHost,
            joinPort: serverInput.joinPort,
            edition: serverInput.edition,
            supportedVersions: serverInput.supportedVersions,
            tags: serverInput.tags,
            shortDescription: serverInput.shortDescription,
            longDescription: serverInput.longDescription,
            websiteUrl: serverInput.websiteUrl ?? null,
            discordUrl: serverInput.discordUrl ?? null,
            ownerAccountId: serverInput.ownerAccountId ?? null,
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
        return toDetail(server, ALL_METHODS);
      } catch (error) {
        if (!isUniqueConstraintError(error)) {
          throw error;
        }
      }
    }
    throw new Error('Failed to generate unique server short code.');
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

export interface ServerWikiLinkRequest {
  readonly serverWikiId?: string;
  readonly spaceId?: string;
  readonly wikiSlug?: string;
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

function buildOrder(sort: ServerSort): Prisma.ServerOrderByWithRelationInput[] {
  switch (sort) {
    case 'votesMonthly_desc':
      return [{ votesMonthly: 'desc' }, { name: 'asc' }];
    case 'reviews_desc':
      return [{ reviewsCount: 'desc' }, { name: 'asc' }];
    case 'name_asc':
      return [{ name: 'asc' }];
    case 'votes24h_desc':
    default:
      return [{ votes24h: 'desc' }, { name: 'asc' }];
  }
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
  serverWiki: { id: bigint; spaceId: bigint; slug: string } | null,
): ServerWikiLinkResponse {
  const wikiSlug = server.wikiSlug ?? serverWiki?.slug ?? null;
  const wikiSpaceId = server.wikiSpaceId?.toString() ?? serverWiki?.spaceId.toString() ?? null;
  const linked = Boolean(wikiSlug && wikiSpaceId);
  return {
    serverId: server.id,
    serverWikiId: serverWiki?.id.toString() ?? null,
    wikiSpaceId,
    wikiPageId: server.wikiPageId?.toString() ?? null,
    wikiSlug,
    wikiUrl: wikiSlug ? `/server/${encodeURIComponent(wikiSlug)}` : null,
    serverDirectoryPath: buildServerDirectoryPath(server),
    status: linked ? 'linked' : 'unlinked',
  };
}

function buildServerDirectoryPath(server: { id: string; shortCode?: string | null }): string {
  return `/servers/${server.shortCode?.trim() || server.id}`;
}

function buildServerMainPageContent(server: {
  name: string;
  joinHost: string;
  joinPort: number;
  edition: ServerDetail['edition'];
  supportedVersions: Prisma.JsonValue;
  tags: Prisma.JsonValue;
  shortDescription?: string | null;
  longDescription: string;
}): string {
  const versions = normalizeStringArray(server.supportedVersions);
  const tags = normalizeStringArray(server.tags);
  return [
    `= ${server.name} =`,
    '',
    server.longDescription.trim() || normalizeShortDescription(server.shortDescription),
    '',
    '== 서버 정보 ==',
    `* 주소: ${server.joinHost}:${server.joinPort}`,
    `* 에디션: ${server.edition}`,
    versions.length > 0 ? `* 지원 버전: ${versions.join(', ')}` : null,
    tags.length > 0 ? `* 태그: ${tags.join(', ')}` : null,
    '',
    '== 참여 안내 ==',
    '서버 소개, 규칙, 시작 방법을 이 문서에 정리해 주세요.',
    '',
  ]
    .filter((line): line is string => line !== null)
    .join('\n');
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
  isOnline: boolean | null;
  latencyMs: number | null;
}): ServerSummary {
  const supportedVersions = normalizeStringArray(server.supportedVersions);
  const tags = normalizeStringArray(server.tags);
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
    isOnline: server.isOnline ?? null,
    latencyMs: server.latencyMs ?? null,
  };
}

function normalizeShortDescription(value?: string | null): string {
  const trimmed = value?.trim();
  return trimmed ? trimmed : 'No description';
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
  },
  verificationMethods: ClaimMethod[],
): ServerDetail {
  return {
    ...toSummary(server),
    longDescription: server.longDescription,
    bannerUrl: server.bannerUrl ?? null,
    websiteUrl: server.websiteUrl ?? null,
    discordUrl: server.discordUrl ?? null,
    voteCooldownHours: server.voteCooldownHours,
    verificationMethods,
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

function isSupportedClaimMethod(value: string): value is ClaimMethod {
  return value === 'plugin' || value === 'dns' || value === 'motd';
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
    return {
      host: target.host,
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
          return {
            host: validated.host,
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
