import { Controller, Get, Param, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { ServerWikiReleaseReviewQueueService } from './server-wiki-release-review-queue.service';

@Controller('v1/wiki/release-reviews')
@UseGuards(SessionGuard)
export class ServerWikiReleaseReviewQueueController {
  constructor(private readonly reviews: ServerWikiReleaseReviewQueueService) {}

  @Get()
  @Throttle({ default: { limit: 30, ttl: 60 } })
  list(
    @CurrentSession() session: SessionPayload,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reviews.list(session.userId, cursor, limit);
  }

  @Get('summary')
  @Throttle({ default: { limit: 12, ttl: 60 } })
  summary(@CurrentSession() session: SessionPayload) {
    return this.reviews.summary(session.userId);
  }

  @Get(':candidateId/pages')
  @Throttle({ default: { limit: 60, ttl: 60 } })
  pages(
    @CurrentSession() session: SessionPayload,
    @Param('candidateId') candidateId: string,
    @Query('kinds') kinds?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    return this.reviews.pages(session.userId, candidateId, kinds, cursor, limit);
  }

  @Get(':candidateId')
  @Throttle({ default: { limit: 30, ttl: 60 } })
  get(
    @CurrentSession() session: SessionPayload,
    @Param('candidateId') candidateId: string,
  ) {
    return this.reviews.get(session.userId, candidateId);
  }
}
