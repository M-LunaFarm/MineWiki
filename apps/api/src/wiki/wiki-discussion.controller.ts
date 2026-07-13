import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiDiscussionService, type WikiRecentThreadListResponse, type WikiThreadDetail, type WikiThreadSummary } from './wiki-discussion.service';

@Controller('v1/wiki')
export class WikiDiscussionController {
  constructor(private readonly discussions: WikiDiscussionService) {}

  @Get('discussions/recent')
  @UseGuards(OptionalSessionGuard)
  recent(
    @Req() request: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ): Promise<WikiRecentThreadListResponse> {
    return this.discussions.listRecent(request.sessionPayload?.userId ?? null, cursor, limit ?? 30);
  }

  @Get('pages/:pageId/discussions')
  @UseGuards(OptionalSessionGuard)
  list(@Param('pageId') pageId: string, @Req() request: FastifyRequest): Promise<WikiThreadSummary[]> {
    return this.discussions.listThreads(pageId, request.sessionPayload?.userId ?? null);
  }

  @Get('discussions/:threadId')
  @UseGuards(OptionalSessionGuard)
  get(
    @Param('threadId') threadId: string,
    @Req() request: FastifyRequest,
    @Query('commentCursor') commentCursor?: string,
    @Query('focusCommentId') focusCommentId?: string,
    @Query('commentLimit', new ParseIntPipe({ optional: true })) commentLimit?: number
  ): Promise<WikiThreadDetail> {
    return this.discussions.getThread(threadId, request.sessionPayload ?? null, commentCursor, commentLimit ?? 100, focusCommentId);
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

  @Patch('discussions/:threadId/topic')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  topic(@Param('threadId') threadId: string, @Body() body: { title?: string }, @CurrentSession() session: SessionPayload) {
    return this.discussions.updateThreadTopic(session, threadId, body.title);
  }

  @Patch('discussions/:threadId/pin')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 12, ttl: 60 } })
  pin(@Param('threadId') threadId: string, @Body() body: { commentId?: string | null }, @CurrentSession() session: SessionPayload) {
    if (body.commentId !== null && typeof body.commentId !== 'string') throw new BadRequestException('commentId must be a string or null.');
    return this.discussions.setPinnedComment(session, threadId, body.commentId ?? null);
  }

  @Delete('discussions/:threadId/comments/:commentId')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  removeComment(@Param('threadId') threadId: string, @Param('commentId') commentId: string, @CurrentSession() session: SessionPayload) {
    return this.discussions.deleteComment(session, threadId, commentId);
  }

  @Post('discussions/:threadId/subscription')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 12, ttl: 60 } })
  subscribe(@Param('threadId') threadId: string, @Body() body: { subscribed?: boolean }, @CurrentSession() session: SessionPayload) {
    if (typeof body.subscribed !== 'boolean') throw new BadRequestException('subscribed must be boolean.');
    return this.discussions.setSubscription(session, threadId, body.subscribed);
  }
}
