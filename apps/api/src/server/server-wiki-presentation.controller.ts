import { Controller, Get, Header, Param, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { z } from 'zod';
import { PrismaService } from '../common/prisma.service';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { WikiPermissionService } from '../wiki/wiki-permission.service';
import { ServerService } from './server.service';

const slugSchema = z.string().trim().min(1).max(255).regex(/^[a-z0-9][a-z0-9-]*$/u);

@Controller('v1/wiki/server-wikis')
export class ServerWikiPresentationController {
  constructor(
    private readonly servers: ServerService,
    private readonly prisma: PrismaService,
    private readonly wikiPermissions: WikiPermissionService,
  ) {}

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
