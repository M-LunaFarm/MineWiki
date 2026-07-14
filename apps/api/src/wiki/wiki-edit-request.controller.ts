import { Body, Controller, Get, Param, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiEditRequestService } from './wiki-edit-request.service';

@Controller('v1/wiki')
export class WikiEditRequestController {
  constructor(private readonly requests: WikiEditRequestService) {}

  @Get('pages/:pageId/edit-requests')
  @UseGuards(OptionalSessionGuard)
  list(@Param('pageId') pageId: string, @Req() request: FastifyRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.requests.list(pageId, request.sessionPayload ?? null, cursor, limit);
  }

  @Get('edit-requests/:requestId')
  @UseGuards(OptionalSessionGuard)
  get(@Param('requestId') requestId: string, @Req() request: FastifyRequest) {
    return this.requests.get(requestId, request.sessionPayload?.userId ?? null);
  }

  @Get('edit-requests/:requestId/diff')
  @UseGuards(OptionalSessionGuard)
  diff(@Param('requestId') requestId: string, @Req() request: FastifyRequest) {
    return this.requests.diff(requestId, request.sessionPayload?.userId ?? null);
  }

  @Post('pages/:pageId/edit-requests')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  create(
    @Param('pageId') pageId: string,
    @Body() body: { baseRevisionId?: string; contentRaw?: string; editSummary?: string; isMinor?: boolean },
    @CurrentSession() session: SessionPayload
  ) { return this.requests.create(session, pageId, body); }

  @Post('edit-requests/:requestId/accept')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 10, ttl: 60 } })
  accept(@Param('requestId') requestId: string, @Body() body: { reviewNote?: string }, @CurrentSession() session: SessionPayload) {
    return this.requests.accept(session, requestId, body.reviewNote);
  }

  @Post('edit-requests/:requestId/reject')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 10, ttl: 60 } })
  reject(@Param('requestId') requestId: string, @Body() body: { reviewNote?: string }, @CurrentSession() session: SessionPayload) {
    return this.requests.reject(session, requestId, body.reviewNote);
  }

  @Patch('edit-requests/:requestId')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  update(@Param('requestId') requestId: string, @Body() body: { baseRevisionId?: string; contentRaw?: string; editSummary?: string; isMinor?: boolean }, @CurrentSession() session: SessionPayload) {
    return this.requests.update(session, requestId, body);
  }

  @Post('edit-requests/:requestId/rebase')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  rebase(
    @Param('requestId') requestId: string,
    @Body() body: { contentRaw?: string; currentRevisionId?: string; editSummary?: string; isMinor?: boolean },
    @CurrentSession() session: SessionPayload
  ) {
    return this.requests.rebase(session, requestId, body);
  }

  @Post('edit-requests/:requestId/close')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  close(@Param('requestId') requestId: string, @CurrentSession() session: SessionPayload) {
    return this.requests.close(session, requestId);
  }

  @Post('edit-requests/:requestId/reopen')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  reopen(@Param('requestId') requestId: string, @CurrentSession() session: SessionPayload) {
    return this.requests.reopen(session, requestId);
  }
}
