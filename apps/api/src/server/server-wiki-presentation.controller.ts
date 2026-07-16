import { Controller, Get, Header, Param } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { ServerService } from './server.service';

const slugSchema = z.string().trim().min(1).max(255).regex(/^[a-z0-9][a-z0-9-]*$/u);

@Controller('v1/wiki/server-wikis')
export class ServerWikiPresentationController {
  constructor(private readonly servers: ServerService) {}

  @Get(':slug/presentation')
  @Header('Cache-Control', 'private, no-store')
  @Throttle({ default: { limit: 120, ttl: 60 } })
  presentation(@Param('slug') slug: string) {
    return this.servers.getWikiPresentationBySlug(slugSchema.parse(slug));
  }
}
