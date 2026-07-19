import { Controller, Delete, Get, Param, ParseIntPipe, Post, Put, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiWatchService } from './wiki-watch.service';

@Controller('v1/wiki')
@UseGuards(SessionGuard)
export class WikiWatchController {
  constructor(private readonly watches: WikiWatchService) {}

  @Get('watchlist')
  list(
    @CurrentSession() session: SessionPayload,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('serverSlug') serverSlug?: string,
  ) { return this.watches.list(session, cursor, limit ?? 50, serverSlug); }

  @Get('pages/:pageId/watch')
  status(@Param('pageId') pageId: string, @CurrentSession() session: SessionPayload) { return this.watches.status(session, pageId); }

  @Put('pages/:pageId/watch')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  watch(@Param('pageId') pageId: string, @CurrentSession() session: SessionPayload) { return this.watches.watch(session, pageId); }

  @Delete('pages/:pageId/watch')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  unwatch(@Param('pageId') pageId: string, @CurrentSession() session: SessionPayload) { return this.watches.unwatch(session, pageId); }

  @Post('pages/:pageId/watch/read')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  read(@Param('pageId') pageId: string, @CurrentSession() session: SessionPayload) { return this.watches.markRead(session, pageId); }
}
