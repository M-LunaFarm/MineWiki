import { Controller, Get, Header, NotFoundException, Param, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { WikiPermissionService } from '../wiki/wiki-permission.service';
import { ServerService } from './server.service';
import { buildCanonicalServerWikiPath } from '../wiki/wiki-route-path.resolver';

const slugSchema = z.string().trim().min(1).max(255).regex(/^[a-z0-9][a-z0-9-]*$/u);

@Controller('v1/wiki/server-wikis')
export class ServerWikiPresentationController {
  constructor(
    private readonly servers: ServerService,
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService,
  ) {}

  @Get('sitemap-index')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=300')
  async sitemapIndex() {
    const wikis = await this.prisma.serverWiki.findMany({
      where: { status: 'active', publicationStatus: 'published', publishedReleaseId: { not: null }, siteSlug: { not: null } },
      select: { id: true, voteServerId: true, spaceId: true, slug: true, siteSlug: true, publishedReleaseId: true, publishedRelease: { select: { serverWikiId: true, presentationSnapshot: true } }, space: { select: { status: true, spaceType: true, rootPageId: true } } },
    });
    const serverIds = wikis.flatMap((wiki) => wiki.voteServerId ? [wiki.voteServerId] : []);
    const servers = serverIds.length ? await this.prisma.server.findMany({
      where: { id: { in: serverIds }, listingStatus: 'active' },
      select: { id: true, wikiSpaceId: true, wikiPageId: true, wikiSlug: true },
    }) : [];
    const serverById = new Map(servers.map((server) => [server.id, server]));
    return { items: wikis.filter((wiki) => {
      const server = wiki.voteServerId ? serverById.get(wiki.voteServerId) : null;
      return wiki.space.status === 'active' && wiki.space.spaceType === 'server_wiki'
        && wiki.publishedRelease?.serverWikiId === wiki.id
        && server?.wikiSpaceId === wiki.spaceId && server.wikiPageId === wiki.space.rootPageId && server.wikiSlug === wiki.slug
        && snapshotIndexingEnabled(wiki.publishedRelease?.presentationSnapshot);
    }).map((wiki) => ({ slug: wiki.siteSlug!, releaseId: wiki.publishedReleaseId!.toString() })) };
  }

  @Get(':slug/sitemap')
  @Header('Cache-Control', 'public, max-age=300, stale-while-revalidate=300')
  async sitemap(@Param('slug') slug: string) {
    const parsedSlug = slugSchema.parse(slug);
    const wiki = await this.prisma.serverWiki.findUnique({
      where: { siteSlug: parsedSlug },
      select: {
        id: true, voteServerId: true, spaceId: true, slug: true, siteSlug: true, status: true,
        publicationStatus: true, publishedReleaseId: true,
        publishedRelease: { select: { serverWikiId: true, presentationSnapshot: true, items: { orderBy: [{ localPath: 'asc' }, { id: 'asc' }], select: { serverWikiId: true, spaceId: true, title: true, pageType: true, pageUpdatedAt: true } } } },
        space: { select: { status: true, spaceType: true, rootPageId: true } },
      },
    });
    if (!wiki || wiki.status !== 'active' || wiki.publicationStatus !== 'published' || !wiki.publishedReleaseId
      || !wiki.voteServerId || wiki.space.status !== 'active' || wiki.space.spaceType !== 'server_wiki'
      || wiki.publishedRelease?.serverWikiId !== wiki.id
      || !snapshotIndexingEnabled(wiki.publishedRelease?.presentationSnapshot)) throw new NotFoundException('Server wiki not found.');
    const server = await this.prisma.server.findUnique({ where: { id: wiki.voteServerId }, select: { listingStatus: true, wikiSpaceId: true, wikiPageId: true, wikiSlug: true } });
    if (!server || server.listingStatus !== 'active' || server.wikiSpaceId !== wiki.spaceId
      || server.wikiPageId !== wiki.space.rootPageId || server.wikiSlug !== wiki.slug) throw new NotFoundException('Server wiki not found.');
    return { releaseId: wiki.publishedReleaseId.toString(), items: (wiki.publishedRelease?.items ?? []).flatMap((item) =>
      item.serverWikiId === wiki.id && item.spaceId === wiki.spaceId && item.pageType !== 'redirect'
        ? [{ path: buildCanonicalServerWikiPath(wiki.siteSlug!, item.title, wiki.slug, '/serverWiki'), lastModified: item.pageUpdatedAt.toISOString() }]
        : []) };
  }

  @Get(':slug/presentation')
  @UseGuards(OptionalSessionGuard)
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 120, ttl: 60 } })
  async presentation(@Param('slug') slug: string, @Req() request: FastifyRequest) {
    const parsedSlug = slugSchema.parse(slug);
    const wiki = await this.prisma.serverWiki.findUnique({
      where: { slug: parsedSlug },
      select: { spaceId: true, publicationStatus: true, publishedReleaseId: true }
    });
    let canPreview = false;
    if (wiki) {
      await this.wikiPermissions.assertCanReadSpace({
        accountId: request.sessionPayload?.userId ?? null,
        spaceId: wiki.spaceId,
        requestIp: request.clientIp ?? request.sessionPayload?.requestIp ?? null,
      });
      const session = request.sessionPayload;
      const profile = session
        ? await this.prisma.wikiProfile.findUnique({
            where: { accountId: session.userId },
            select: { id: true, status: true },
          })
        : null;
      canPreview = await this.wikiPermissions.canPreviewServerWikiSpace({
        accountId: session?.userId ?? null,
        actor: session && profile ? this.wikiPermissions.actorFromSession(session, profile) : null,
        spaceId: wiki.spaceId,
      });
    }
    const releaseId = !canPreview && wiki?.publicationStatus === 'published'
      ? wiki.publishedReleaseId ?? undefined
      : undefined;
    return this.servers.getWikiPresentationBySlug(parsedSlug, releaseId);
  }
}

function snapshotIndexingEnabled(value: unknown): boolean {
  return !value || typeof value !== 'object' || Array.isArray(value)
    ? true
    : (value as Record<string, unknown>).seoIndexingEnabled !== false;
}
