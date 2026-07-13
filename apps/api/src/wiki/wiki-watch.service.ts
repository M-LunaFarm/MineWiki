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

  async list(session: SessionPayload): Promise<WikiWatchlistItem[]> {
    const profile = await this.profiles.ensureWikiProfile(session.userId);
    const watches = await this.prisma.wikiPageWatch.findMany({
      where: { profileId: profile.id },
      orderBy: [{ updatedAt: 'desc' }],
      take: 200
    });
    if (watches.length === 0) return [];
    const pages = await this.prisma.wikiPage.findMany({ where: { id: { in: watches.map((watch) => watch.pageId) } } });
    const namespaces = await this.prisma.wikiNamespace.findMany({
      where: { id: { in: [...new Set(pages.map((page) => page.namespaceId))] } },
      select: { id: true, code: true }
    });
    const serverSpaces = [...new Set(pages.filter((page) => namespaces.find((item) => item.id === page.namespaceId)?.code === 'server').map((page) => page.spaceId))];
    const serverWikis = serverSpaces.length > 0
      ? await this.prisma.serverWiki.findMany({ where: { spaceId: { in: serverSpaces } }, select: { spaceId: true, slug: true } })
      : [];
    const pageById = new Map(pages.map((page) => [page.id, page]));
    const namespaceById = new Map(namespaces.map((namespace) => [namespace.id, namespace.code]));
    const serverSlugBySpace = new Map(serverWikis.map((wiki) => [wiki.spaceId, wiki.slug]));
    const items: WikiWatchlistItem[] = [];
    for (const watch of watches) {
      const page = pageById.get(watch.pageId);
      if (!page || page.status === 'deleted') continue;
      try {
        await this.permissions.assertCanReadPage({ accountId: session.userId, page });
      } catch {
        continue;
      }
      const namespace = namespaceById.get(page.namespaceId) ?? 'main';
      const serverSlug = serverSlugBySpace.get(page.spaceId);
      items.push({
        pageId: page.id.toString(),
        title: page.displayTitle,
        namespace,
        routePath: namespace === 'server' && serverSlug
          ? buildServerWikiPagePath(serverSlug, page.localPath)
          : wikiUrl(namespace as Parameters<typeof wikiUrl>[0], page.title),
        watched: true,
        unread: page.currentRevisionId !== watch.lastSeenRevisionId,
        updatedAt: page.updatedAt.toISOString()
      });
    }
    return items;
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
