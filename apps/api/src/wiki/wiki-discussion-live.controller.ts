import { Controller, Headers, Param, Req, Sse, UseGuards } from '@nestjs/common';
import type { MessageEvent } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import type { Observable } from 'rxjs';
import { Throttle } from '@nestjs/throttler';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { WikiDiscussionLiveService } from './wiki-discussion-live.service';

@Controller('v1/wiki/discussions')
export class WikiDiscussionLiveController {
  constructor(private readonly live: WikiDiscussionLiveService) {}

  @Sse(':threadId/events')
  @UseGuards(OptionalSessionGuard)
  @Throttle({ default: { limit: 30, ttl: 60 } })
  events(
    @Param('threadId') threadId: string,
    @Req() request: FastifyRequest,
    @Headers('last-event-id') lastEventId?: string
  ): Promise<Observable<MessageEvent>> {
    return this.live.openEvents(threadId, request.sessionPayload ?? null, lastEventId);
  }
}
