import { BadRequestException, Body, Controller, Delete, Get, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiDiscussionService, type WikiThreadDetail, type WikiThreadSummary } from './wiki-discussion.service';

@Controller('v1/wiki')
export class WikiDiscussionController {
  constructor(private readonly discussions: WikiDiscussionService) {}

  @Get('pages/:pageId/discussions')
  @UseGuards(OptionalSessionGuard)
  list(@Param('pageId') pageId: string, @Req() request: FastifyRequest): Promise<WikiThreadSummary[]> {
    return this.discussions.listThreads(pageId, request.sessionPayload?.userId ?? null);
  }

  @Get('discussions/:threadId')
  @UseGuards(OptionalSessionGuard)
  get(@Param('threadId') threadId: string, @Req() request: FastifyRequest): Promise<WikiThreadDetail> {
    return this.discussions.getThread(threadId, request.sessionPayload ?? null);
  }

  @Post('pages/:pageId/discussions')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 6, ttl: 60 } })
  create(@Param('pageId') pageId: string, @Body() body: { title?: string; content?: string }, @CurrentSession() session: SessionPayload) {
    return this.discussions.createThread(session, pageId, body);
  }

  @Post('discussions/:threadId/comments')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 12, ttl: 60 } })
  comment(@Param('threadId') threadId: string, @Body() body: { content?: string }, @CurrentSession() session: SessionPayload) {
    return this.discussions.addComment(session, threadId, body);
  }

  @Patch('discussions/:threadId/status')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  status(@Param('threadId') threadId: string, @Body() body: { status?: string }, @CurrentSession() session: SessionPayload) {
    if (body.status !== 'open' && body.status !== 'closed') throw new BadRequestException('Invalid discussion status.');
    return this.discussions.setThreadStatus(session, threadId, body.status);
  }

  @Delete('discussions/:threadId/comments/:commentId')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  removeComment(@Param('threadId') threadId: string, @Param('commentId') commentId: string, @CurrentSession() session: SessionPayload) {
    return this.discussions.deleteComment(session, threadId, commentId);
  }
}
