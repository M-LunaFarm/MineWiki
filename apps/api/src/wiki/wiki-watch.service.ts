import { Injectable, NotFoundException } from '@nestjs/common';
import { wikiUrl } from '@minewiki/wiki-core';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { buildServerWikiPagePath } from './wiki-read.service';

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
    private readonly permissions: WikiPermissionService
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

  async list(session: SessionPayload, cursor?: string, requestedLimit = 50): Promise<WikiWatchlistResponse> {
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const limit = Math.min(Math.max(requestedLimit, 1), 100);
    const decoded = cursor ? this.decodeCursor(cursor) : null;
    const snapshotAt = decoded?.snapshotAt ?? new Date();
    const candidateLimit = Math.min(limit * 5 + 1, 501);
    const watches = await this.prisma.wikiPageWatch.findMany({
      where: {
        profileId: profile.id,
        updatedAt: { lte: snapshotAt },
        ...(decoded ? {
          OR: [
            { updatedAt: { lt: decoded.updatedAt } },
            { updatedAt: decoded.updatedAt, id: { lt: decoded.id } }
          ]
        } : {})
      },
      orderBy: [{ updatedAt: 'desc' }, { id: 'desc' }],
      take: candidateLimit
    });
    if (watches.length === 0) return { items: [], nextCursor: null };
    const pages = await this.prisma.wikiPage.findMany({ where: { id: { in: watches.map((watch) => watch.pageId) } } });
    const actor = this.permissions.actorFromSession(session, profile);
    const readablePages = await this.permissions.filterReadablePages({ accountId: session.userId, actor, pages });
    const namespaces = await this.prisma.wikiNamespace.findMany({
      where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } },
      select: { id: true, code: true }
    });
    const serverSpaces = [...new Set(pages.filter((page) => namespaces.find((item) => item.id === page.namespaceId)?.code === 'server').map((page) => page.spaceId))];
    const serverWikis = serverSpaces.length > 0
      ? await this.prisma.serverWiki.findMany({
          where: { spaceId: { in: serverSpaces }, status: 'active' },
          select: { spaceId: true, slug: true },
        })
      : [];
    const pageById = new Map(readablePages.map((page) => [page.id, page]));
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const serverSlugBySpace = new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki.slug]));
    const visible: Array<{ watch: (typeof watches)[number]; item: WikiWatchlistItem }> = [];
    for (const watch of watches) {
      const page = pageById.get(watch.pageId);
      if (!page || page.status === 'deleted') continue;
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const serverSlug = serverSlugBySpace.get(page.spaceId);
      if (namespace === 'server' && !serverSlug) continue;
      visible.push({ watch, item: {
        pageId: page.id.toString(),
        title: page.displayTitle,
        namespace,
        routePath: namespace === 'server' && serverSlug
          ? buildServerWikiPagePath(serverSlug, page.localPath)
          : wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title),
        watched: true,
        unread: page.currentRevisionId !== watch.lastSeenRevisionId,
        updatedAt: page.updatedAt.toISOString()
      } });
    }
    const pageRows = visible.slice(0, limit);
    const candidateWindowFull = watches.length === candidateLimit;
    const hasMore = visible.length > limit || candidateWindowFull;
    const cursorWatch = visible.length > limit
      ? pageRows.at(-1)?.watch
      : candidateWindowFull
        ? watches.at(-1)
        : null;
    return {
      items: pageRows.map((row) => row.item),
      nextCursor: hasMore && cursorWatch
        ? this.encodeCursor(snapshotAt, cursorWatch.updatedAt, cursorWatch.id)
        : null
    };
  }

  private encodeCursor(snapshotAt: Date, updatedAt: Date, id: bigint): string {
    return Buffer.from(JSON.stringify({ snapshotAt: snapshotAt.toISOString(), updatedAt: updatedAt.toISOString(), id: id.toString() })).toString('base64url');
  }

  private decodeCursor(value: string): { snapshotAt: Date; updatedAt: Date; id: bigint } {
    try {
      const parsed = JSON.parse(Buffer.from(value, 'base64url').toString('utf8')) as Record<string, unknown>;
      if (typeof parsed.snapshotAt !== 'string' || typeof parsed.updatedAt !== 'string' || typeof parsed.id !== 'string' || !/^\d+$/u.test(parsed.id)) throw new Error('shape');
      const snapshotAt = new Date(parsed.snapshotAt);
      const updatedAt = new Date(parsed.updatedAt);
      if (Number.isNaN(snapshotAt.getTime()) || Number.isNaN(updatedAt.getTime()) || updatedAt > snapshotAt) throw new Error('date');
      return { snapshotAt, updatedAt, id: BigInt(parsed.id) };
    } catch {
      throw new NotFoundException('Wiki watchlist cursor not found.');
    }
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
