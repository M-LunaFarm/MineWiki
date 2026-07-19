import { Injectable, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { wikiUrl } from '@minewiki/wiki-core';
import { Prisma } from '@prisma/client';
import { createHmac, timingSafeEqual } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { buildServerWikiPagePath } from './wiki-read.service';

const WATCHLIST_CANDIDATE_BATCH_SIZE = 100;
const MAX_WATCHLIST_CANDIDATE_SCAN = 500;

interface WatchlistCursorPosition {
  readonly pageUpdatedAt: Date;
  readonly watchId: bigint;
}

interface WatchlistCursor extends WatchlistCursorPosition {
  readonly snapshotAt: Date;
  readonly serverWikiId: bigint | null;
  readonly spaceId: bigint | null;
}

interface WatchlistServerWikiScope {
  readonly id: bigint;
  readonly spaceId: bigint;
}

interface WatchlistCandidateRow {
  readonly watchId: bigint;
  readonly pageId: bigint;
  readonly lastSeenRevisionId: bigint | null;
  readonly namespaceId: number;
  readonly spaceId: bigint;
  readonly localPath: string;
  readonly title: string;
  readonly displayTitle: string;
  readonly currentRevisionId: bigint | null;
  readonly protectionLevel: string;
  readonly status: string;
  readonly createdBy: bigint | null;
  readonly pageUpdatedAt: Date;
}

export interface WikiWatchStatus {
  readonly watched: boolean;
  readonly unread: boolean;
}

export interface WikiWatchlistItem extends WikiWatchStatus {
  readonly pageId: string;
  readonly title: string;
  readonly namespace: string;
  readonly routePath: string;
  readonly updatedAt: string;
}

export interface WikiWatchlistResponse {
  readonly items: WikiWatchlistItem[];
  readonly nextCursor: string | null;
}

@Injectable()
export class WikiWatchService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly profiles: WikiProfileService,
    private readonly permissions: WikiPermissionService,
    private readonly config: ConfigService
  ) {}

  async status(session: SessionPayload, pageId: string): Promise<WikiWatchStatus> {
    const { page, profile } = await this.context(session, pageId);
    const watch = await this.prisma.wikiPageWatch.findUnique({
      where: { profileId_pageId: { profileId: profile.id, pageId: page.id } }
    });
    return {
      watched: Boolean(watch),
      unread: Boolean(watch && page.currentRevisionId !== watch.lastSeenRevisionId)
    };
  }

  async watch(session: SessionPayload, pageId: string): Promise<WikiWatchStatus> {
    const { page, profile } = await this.context(session, pageId);
    const now = new Date();
    await this.prisma.wikiPageWatch.upsert({
      where: { profileId_pageId: { profileId: profile.id, pageId: page.id } },
      create: {
        profileId: profile.id,
        pageId: page.id,
        lastSeenRevisionId: page.currentRevisionId,
        createdAt: now,
        updatedAt: now
      },
      update: { lastSeenRevisionId: page.currentRevisionId, updatedAt: now }
    });
    return { watched: true, unread: false };
  }

  async unwatch(session: SessionPayload, pageId: string): Promise<WikiWatchStatus> {
    const { page, profile } = await this.context(session, pageId);
    await this.prisma.wikiPageWatch.deleteMany({ where: { profileId: profile.id, pageId: page.id } });
    return { watched: false, unread: false };
  }

  async markRead(session: SessionPayload, pageId: string): Promise<WikiWatchStatus> {
    const { page, profile } = await this.context(session, pageId);
    const result = await this.prisma.wikiPageWatch.updateMany({
      where: { profileId: profile.id, pageId: page.id },
      data: { lastSeenRevisionId: page.currentRevisionId, updatedAt: new Date() }
    });
    return { watched: result.count > 0, unread: false };
  }

  async list(session: SessionPayload, cursor?: string, requestedLimit = 50, serverSlug?: string): Promise<WikiWatchlistResponse> {
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const limit = Math.min(Math.max(requestedLimit, 1), 100);
    const serverWikiScope = serverSlug ? await this.resolveActiveServerWikiScope(serverSlug) : null;
    const decoded = cursor ? this.decodeCursor(cursor, profile.id, serverWikiScope) : null;
    const snapshotAt = decoded?.snapshotAt ?? new Date();
    const actor = this.permissions.actorFromSession(session, profile);
    const visible: Array<{ row: WatchlistCandidateRow; item: WikiWatchlistItem }> = [];
    let scanPosition: WatchlistCursorPosition | null = decoded;
    let lastScanned: WatchlistCandidateRow | undefined;
    let scannedCandidateCount = 0;
    let hasUnscannedCandidates = false;

    while (visible.length <= limit && scannedCandidateCount < MAX_WATCHLIST_CANDIDATE_SCAN) {
      const take = Math.min(
        WATCHLIST_CANDIDATE_BATCH_SIZE,
        MAX_WATCHLIST_CANDIDATE_SCAN - scannedCandidateCount
      );
      const candidateRows = await this.loadCandidates(profile.id, snapshotAt, scanPosition, take + 1, serverWikiScope?.spaceId ?? null);
      const candidates = candidateRows.slice(0, take);
      hasUnscannedCandidates = candidateRows.length > take;
      if (candidates.length === 0) break;

      scannedCandidateCount += candidates.length;
      lastScanned = candidates.at(-1);
      if (lastScanned) {
        scanPosition = {
          pageUpdatedAt: lastScanned.pageUpdatedAt,
          watchId: lastScanned.watchId
        };
      }
      visible.push(...await this.visibleItems(session, actor, candidates));

      if (visible.length > limit || candidates.length < take || !hasUnscannedCandidates) break;
    }

    const pageRows = visible.slice(0, limit);
    const hasMore = visible.length > limit || hasUnscannedCandidates;
    const cursorRow = visible.length > limit
      ? pageRows.at(-1)?.row
      : hasUnscannedCandidates
        ? lastScanned
        : null;
    return {
      items: pageRows.map((row) => row.item),
      nextCursor: hasMore && cursorRow
        ? this.encodeCursor(snapshotAt, cursorRow.pageUpdatedAt, cursorRow.watchId, profile.id, serverWikiScope)
        : null
    };
  }

  private async loadCandidates(
    profileId: bigint,
    snapshotAt: Date,
    position: WatchlistCursorPosition | null,
    take: number,
    spaceId: bigint | null,
  ): Promise<WatchlistCandidateRow[]> {
    const after = position
      ? Prisma.sql`AND (
          p.updated_at < ${position.pageUpdatedAt}
          OR (p.updated_at = ${position.pageUpdatedAt} AND w.id < ${position.watchId})
        )`
      : Prisma.empty;
    return this.prisma.$queryRaw<WatchlistCandidateRow[]>(Prisma.sql`
      SELECT
        w.id AS watchId,
        w.page_id AS pageId,
        w.last_seen_revision_id AS lastSeenRevisionId,
        p.namespace_id AS namespaceId,
        p.space_id AS spaceId,
        p.local_path AS localPath,
        p.title,
        p.display_title AS displayTitle,
        p.current_revision_id AS currentRevisionId,
        p.protection_level AS protectionLevel,
        p.status,
        p.created_by AS createdBy,
        snapshot_revision.created_at AS pageUpdatedAt
      FROM wiki_page_watches w
      INNER JOIN pages p ON p.id = w.page_id
      INNER JOIN page_revisions snapshot_revision ON snapshot_revision.id = (
        SELECT candidate_revision.id
        FROM page_revisions candidate_revision
        WHERE candidate_revision.page_id = p.id
          AND candidate_revision.created_at <= ${snapshotAt}
        ORDER BY candidate_revision.created_at DESC, candidate_revision.id DESC
        LIMIT 1
      )
      WHERE w.profile_id = ${profileId}
        AND w.created_at <= ${snapshotAt}
        ${spaceId === null ? Prisma.empty : Prisma.sql`AND p.space_id = ${spaceId}`}
        ${after}
      ORDER BY snapshot_revision.created_at DESC, w.id DESC
      LIMIT ${take}
    `);
  }

  private async visibleItems(
    session: SessionPayload,
    actor: ReturnType<WikiPermissionService['actorFromSession']>,
    candidates: readonly WatchlistCandidateRow[]
  ): Promise<Array<{ row: WatchlistCandidateRow; item: WikiWatchlistItem }>> {
    const namespaces = await this.prisma.wikiNamespace.findMany({
      where: { id: { in: [...new Set(candidates.map((row) => row.namespaceId))] } },
      select: { id: true, code: true }
    });
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const serverSpaces = [...new Set(candidates
      .filter((row) => namespaceById.get(row.namespaceId) === 'server')
      .map((row) => row.spaceId))];
    const serverWikis = serverSpaces.length > 0
      ? await this.prisma.serverWiki.findMany({
          where: { spaceId: { in: serverSpaces }, status: 'active' },
          select: {
            id: true,
            spaceId: true,
            slug: true,
            siteSlug: true,
            publicationStatus: true,
            publishedReleaseId: true,
          }
        })
      : [];
    const serverWikiBySpace = new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki]));
    const previewSpaces = new Set<bigint>();
    for (const wiki of serverWikis) {
      if (await this.permissions.canPreviewServerWikiSpace({ accountId: session.userId, actor, spaceId: wiki.spaceId })) {
        previewSpaces.add(wiki.spaceId);
      }
    }
    const releasedScopes = serverWikis.filter((wiki) => !previewSpaces.has(wiki.spaceId)
      && wiki.publicationStatus === 'published' && wiki.publishedReleaseId !== null);
    const releaseItems = releasedScopes.length > 0
      ? await this.prisma.serverWikiReleaseItem.findMany({
          where: {
            OR: releasedScopes.map((wiki) => ({
              releaseId: wiki.publishedReleaseId!,
              serverWikiId: wiki.id,
              spaceId: wiki.spaceId,
            })),
            pageId: { in: candidates.map((row) => row.pageId) },
          },
        })
      : [];
    const releaseItemByPage = new Map(releaseItems.map((item) => [`${item.spaceId}:${item.pageId}`, item]));
    const projectedCandidates = candidates.flatMap((row): WatchlistCandidateRow[] => {
      if (namespaceById.get(row.namespaceId) !== 'server' || previewSpaces.has(row.spaceId)) return [row];
      const item = releaseItemByPage.get(`${row.spaceId}:${row.pageId}`);
      if (!item) return [];
      return [{
        ...row,
        namespaceId: item.namespaceId,
        spaceId: item.spaceId,
        localPath: item.localPath,
        title: item.title,
        displayTitle: item.displayTitle,
        currentRevisionId: item.revisionId,
        protectionLevel: item.protectionLevel,
        status: item.pageStatus,
        createdBy: item.createdBy,
        pageUpdatedAt: item.pageUpdatedAt,
      }];
    });
    const readablePages = await this.permissions.filterReadablePages({
      accountId: session.userId,
      actor,
      pages: projectedCandidates.map((row) => ({
        id: row.pageId,
        namespaceId: row.namespaceId,
        spaceId: row.spaceId,
        title: row.title,
        protectionLevel: row.protectionLevel,
        status: row.status,
        createdBy: row.createdBy
      }))
    });
    const readableIds = new Set(readablePages.map((page) => page.id));
    const readableCandidates = projectedCandidates.filter((row) => readableIds.has(row.pageId));
    if (readableCandidates.length === 0) return [];
    const serverSlugBySpace = new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki.siteSlug ?? wiki.slug]));
    const visible: Array<{ row: WatchlistCandidateRow; item: WikiWatchlistItem }> = [];
    for (const row of readableCandidates) {
      if (row.status === 'deleted') continue;
      const namespace = namespaceById.get(row.namespaceId) ?? 'main';
      const serverSlug = serverSlugBySpace.get(row.spaceId);
      if (namespace === 'server' && !serverSlug) continue;
      visible.push({ row, item: {
        pageId: row.pageId.toString(),
        title: row.displayTitle,
        namespace,
        routePath: namespace === 'server' && serverSlug
          ? buildServerWikiPagePath(serverSlug, row.localPath)
          : wikiUrl(namespace as Parameters<typeof wikiUrl>[0], row.title),
        watched: true,
        unread: row.currentRevisionId !== row.lastSeenRevisionId,
        updatedAt: row.pageUpdatedAt.toISOString()
      } });
    }
    return visible;
  }

  private encodeCursor(
    snapshotAt: Date,
    pageUpdatedAt: Date,
    watchId: bigint,
    profileId: bigint,
    serverWikiScope: WatchlistServerWikiScope | null,
  ): string {
    const payload = Buffer.from(JSON.stringify({
      version: 2,
      snapshotAt: snapshotAt.toISOString(),
      pageUpdatedAt: pageUpdatedAt.toISOString(),
      watchId: watchId.toString(),
      serverWikiId: serverWikiScope?.id.toString() ?? null,
      spaceId: serverWikiScope?.spaceId.toString() ?? null,
    })).toString('base64url');
    return `${payload}.${this.signCursor(payload, profileId, serverWikiScope)}`;
  }

  private decodeCursor(value: string, profileId: bigint, serverWikiScope: WatchlistServerWikiScope | null): WatchlistCursor {
    try {
      const parts = value.split('.');
      if (parts.length !== 2) throw new Error('shape');
      const [payload, signature] = parts as [string, string];
      const expected = Buffer.from(this.signCursor(payload, profileId, serverWikiScope));
      const actual = Buffer.from(signature);
      if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new Error('signature');
      const parsed = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (
        parsed.version !== 2 ||
        typeof parsed.snapshotAt !== 'string' ||
        typeof parsed.pageUpdatedAt !== 'string' ||
        typeof parsed.watchId !== 'string' ||
        !/^\d+$/u.test(parsed.watchId) ||
        (parsed.serverWikiId !== null && (typeof parsed.serverWikiId !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(parsed.serverWikiId))) ||
        (parsed.spaceId !== null && (typeof parsed.spaceId !== 'string' || !/^[1-9][0-9]{0,19}$/u.test(parsed.spaceId))) ||
        parsed.serverWikiId !== (serverWikiScope?.id.toString() ?? null) ||
        parsed.spaceId !== (serverWikiScope?.spaceId.toString() ?? null)
      ) throw new Error('payload');
      const snapshotAt = new Date(parsed.snapshotAt);
      const pageUpdatedAt = new Date(parsed.pageUpdatedAt);
      if (
        Number.isNaN(snapshotAt.getTime()) ||
        Number.isNaN(pageUpdatedAt.getTime()) ||
        pageUpdatedAt > snapshotAt
      ) throw new Error('date');
      return {
        snapshotAt,
        pageUpdatedAt,
        watchId: BigInt(parsed.watchId),
        serverWikiId: serverWikiScope?.id ?? null,
        spaceId: serverWikiScope?.spaceId ?? null,
      };
    } catch {
      throw new NotFoundException('Wiki watchlist cursor not found.');
    }
  }

  private signCursor(payload: string, profileId: bigint, serverWikiScope: WatchlistServerWikiScope | null): string {
    return createHmac('sha256', this.config.get('APP_ENCRYPTION_KEY'))
      .update(`minewiki:wiki-watchlist:v2:${profileId.toString()}:${serverWikiScope?.id.toString() ?? 'global'}:${serverWikiScope?.spaceId.toString() ?? 'global'}:${payload}`)
      .digest('base64url');
  }

  private async resolveActiveServerWikiScope(value: string): Promise<WatchlistServerWikiScope> {
    const slug = value.trim();
    if (!slug || slug.length > 255) throw new NotFoundException('Server wiki not found.');
    const serverWiki = await this.prisma.serverWiki.findFirst({
      where: { status: 'active', OR: [{ siteSlug: slug }, { slug }] },
      select: { id: true, spaceId: true },
    });
    if (!serverWiki) throw new NotFoundException('Server wiki not found.');
    return serverWiki;
  }

  private async context(session: SessionPayload, pageId: string) {
    if (!/^\d+$/.test(pageId)) throw new NotFoundException('Wiki page not found.');
    const page = await this.prisma.wikiPage.findUnique({ where: { id: BigInt(pageId) } });
    if (!page || page.status === 'deleted') throw new NotFoundException('Wiki page not found.');
    await this.permissions.assertCanReadPage({ accountId: session.userId, page });
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    return { page, profile };
  }
}
