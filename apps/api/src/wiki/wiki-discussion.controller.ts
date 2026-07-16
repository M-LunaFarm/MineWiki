import { BadRequestException, Body, Controller, Delete, Get, Param, ParseIntPipe, Patch, Post, Query, Req, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiDiscussionService, type WikiDiscussionPollInput, type WikiDiscussionStatus, type WikiDiscussionStatusFilter, type WikiRecentThreadListResponse, type WikiThreadDetail, type WikiThreadListResponse, type WikiThreadSummary } from './wiki-discussion.service';
import { WikiCaptchaService } from './wiki-captcha.service';

@Controller('v1/wiki')
export class WikiDiscussionController {
  constructor(private readonly discussions: WikiDiscussionService, private readonly wikiCaptcha: WikiCaptchaService) {}

  @Get('discussions/recent')
  @UseGuards(OptionalSessionGuard)
  recent(
    @Req() request: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number
  ): Promise<WikiRecentThreadListResponse> {
    return this.discussions.listRecent(request.sessionPayload ?? null, cursor, limit ?? 30);
  }

  @Get('pages/:pageId/discussions')
  @UseGuards(OptionalSessionGuard)
  list(@Param('pageId') pageId: string, @Req() request: FastifyRequest): Promise<WikiThreadSummary[]> {
    return this.discussions.listThreads(pageId, request.sessionPayload ?? null);
  }

  @Get('pages/:pageId/discussion-threads')
  @UseGuards(OptionalSessionGuard)
  listPage(
    @Param('pageId') pageId: string,
    @Req() request: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('status') status?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('preview') preview?: string
  ): Promise<WikiThreadListResponse> {
    if (status !== undefined && !['all', 'active', 'open', 'paused', 'closed'].includes(status)) {
      throw new BadRequestException('Invalid discussion status filter.');
    }
    if (preview !== undefined && preview !== 'first-latest') {
      throw new BadRequestException('Invalid discussion preview mode.');
    }
    return this.discussions.listThreadsPage(
      pageId,
      request.sessionPayload ?? null,
      cursor,
      limit ?? 30,
      (status ?? 'all') as WikiDiscussionStatusFilter,
      preview === 'first-latest'
    );
  }

  @Get('pages/:pageId/discussion-permissions')
  @UseGuards(OptionalSessionGuard)
  permissions(@Param('pageId') pageId: string, @Req() request: FastifyRequest): Promise<{ readonly canCreateThread: boolean }> {
    return this.discussions.getPageDiscussionPermissions(pageId, request.sessionPayload ?? null);
  }

  @Get('discussions/:threadId')
  @UseGuards(OptionalSessionGuard)
  get(
    @Param('threadId') threadId: string,
    @Req() request: FastifyRequest,
    @Query('commentCursor') commentCursor?: string,
    @Query('focusCommentId') focusCommentId?: string,
    @Query('commentDirection') commentDirection?: string,
    @Query('commentLimit', new ParseIntPipe({ optional: true })) commentLimit?: number
  ): Promise<WikiThreadDetail> {
    if (commentDirection !== undefined && commentDirection !== 'older' && commentDirection !== 'newer') {
      throw new BadRequestException('commentDirection must be older or newer.');
    }
    const direction: 'older' | 'newer' = commentDirection === 'newer' ? 'newer' : 'older';
    return this.discussions.getThread(
      threadId,
      request.sessionPayload ?? null,
      commentCursor,
      commentLimit ?? 100,
      focusCommentId,
      direction
    );
  }

  @Post('pages/:pageId/discussions')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 6, ttl: 60 } })
  async create(
    @Param('pageId') pageId: string,
    @Body() body: { title?: string; content?: string; poll?: WikiDiscussionPollInput; captchaToken?: string },
    @CurrentSession() session: SessionPayload,
    @Req() request: FastifyRequest
  ) {
    await this.wikiCaptcha.assertVerified(body.captchaToken, request.clientIp ?? session.requestIp);
    const thread = { ...body };
    delete thread.captchaToken;
    return this.discussions.createThread(session, pageId, thread);
  }

  @Post('discussions/:threadId/comments')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 12, ttl: 60 } })
  comment(@Param('threadId') threadId: string, @Body() body: { content?: string; poll?: WikiDiscussionPollInput }, @CurrentSession() session: SessionPayload) {
    return this.discussions.addComment(session, threadId, body);
  }

  @Post('discussions/:threadId/polls/:pollId/vote')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 20, ttl: 60 } })
  votePoll(
    @Param('threadId') threadId: string,
    @Param('pollId') pollId: string,
    @Body() body: { optionId?: string },
    @CurrentSession() session: SessionPayload
  ) {
    return this.discussions.votePoll(session, threadId, pollId, body.optionId);
  }

  @Post('discussions/:threadId/polls/:pollId/close')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 6, ttl: 60 } })
  closePoll(
    @Param('threadId') threadId: string,
    @Param('pollId') pollId: string,
    @CurrentSession() session: SessionPayload
  ) {
    return this.discussions.closePoll(session, threadId, pollId);
  }

  @Patch('discussions/:threadId/status')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  status(@Param('threadId') threadId: string, @Body() body: { status?: string }, @CurrentSession() session: SessionPayload) {
    if (body.status !== 'open' && body.status !== 'paused' && body.status !== 'closed') {
      throw new BadRequestException('Invalid discussion status.');
    }
    return this.discussions.setThreadStatus(session, threadId, body.status as WikiDiscussionStatus);
  }

  @Patch('discussions/:threadId/topic')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  topic(@Param('threadId') threadId: string, @Body() body: { title?: string }, @CurrentSession() session: SessionPayload) {
    return this.discussions.updateThreadTopic(session, threadId, body.title);
  }

  @Patch('discussions/:threadId/page')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 6, ttl: 60 } })
  move(
    @Param('threadId') threadId: string,
    @Body() body: { pageId?: string; reason?: string },
    @CurrentSession() session: SessionPayload
  ) {
    return this.discussions.moveThread(session, threadId, body.pageId, body.reason);
  }

  @Delete('discussions/:threadId')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 6, ttl: 60 } })
  remove(
    @Param('threadId') threadId: string,
    @Body() body: { reason?: string },
    @CurrentSession() session: SessionPayload
  ) {
    return this.discussions.deleteThread(session, threadId, body.reason);
  }

  @Get('discussions/:threadId/comments/:commentId/raw')
  @UseGuards(OptionalSessionGuard)
  rawComment(
    @Param('threadId') threadId: string,
    @Param('commentId') commentId: string,
    @Req() request: FastifyRequest
  ): Promise<string> {
    return this.discussions.getCommentRaw(threadId, commentId, request.sessionPayload ?? null);
  }

  @Patch('discussions/:threadId/comments/:commentId/visibility')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 12, ttl: 60 } })
  visibility(
    @Param('threadId') threadId: string,
    @Param('commentId') commentId: string,
    @Body() body: { status?: string; reason?: string },
    @CurrentSession() session: SessionPayload
  ) {
    if (body.status !== 'normal' && body.status !== 'hidden') throw new BadRequestException('Invalid comment visibility status.');
    return this.discussions.setCommentVisibility(session, threadId, commentId, body.status, body.reason);
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
