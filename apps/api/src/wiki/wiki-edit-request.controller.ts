import { Body, Controller, Get, Param, Patch, Post, Query, Req, Res, ServiceUnavailableException, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { CurrentSession } from '../session/session.decorator';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiEditRequestService } from './wiki-edit-request.service';
import { WikiCaptchaService } from './wiki-captcha.service';
import type { WikiPolicyAcceptance } from './wiki-contribution-policy.service';
import { clearWikiAnonymousContributorCookie, readWikiAnonymousContributorToken, serializeWikiAnonymousContributorCookie } from './wiki-anonymous-contributor';

@Controller('v1/wiki')
export class WikiEditRequestController {
  constructor(private readonly requests: WikiEditRequestService, private readonly wikiCaptcha: WikiCaptchaService) {}

  @Get('edit-requests')
  @UseGuards(OptionalSessionGuard)
  queue(
    @Req() request: FastifyRequest,
    @Query('status') status?: string,
    @Query('scope') scope?: string,
    @Query('namespace') namespace?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string
  ) {
    return this.requests.listGlobal(request.sessionPayload ?? null, { status, scope, namespace, cursor, limit }, readWikiAnonymousContributorToken(request.headers?.cookie));
  }

  @Get('edit-requests/reviewable-summary')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 12, ttl: 60 } })
  reviewableSummary(@CurrentSession() session: SessionPayload) {
    return this.requests.reviewableSummary(session);
  }

  @Get('pages/:pageId/edit-requests')
  @UseGuards(OptionalSessionGuard)
  list(@Param('pageId') pageId: string, @Req() request: FastifyRequest, @Query('cursor') cursor?: string, @Query('limit') limit?: string) {
    return this.requests.list(pageId, request.sessionPayload ?? null, cursor, limit, readWikiAnonymousContributorToken(request.headers?.cookie));
  }

  @Get('edit-requests/:requestId')
  @UseGuards(OptionalSessionGuard)
  get(@Param('requestId') requestId: string, @Req() request: FastifyRequest) {
    return this.requests.get(requestId, request.sessionPayload?.userId ?? null, readWikiAnonymousContributorToken(request.headers?.cookie));
  }

  @Get('edit-requests/:requestId/context')
  @UseGuards(OptionalSessionGuard)
  context(@Param('requestId') requestId: string, @Req() request: FastifyRequest) {
    return this.requests.context(requestId, request.sessionPayload ?? null, readWikiAnonymousContributorToken(request.headers?.cookie));
  }

  @Get('edit-requests/:requestId/diff')
  @UseGuards(OptionalSessionGuard)
  diff(@Param('requestId') requestId: string, @Req() request: FastifyRequest) {
    return this.requests.diff(requestId, request.sessionPayload?.userId ?? null);
  }

  @Post('pages/:pageId/edit-requests')
  @UseGuards(OptionalSessionGuard)
  @Throttle({ default: { limit: 4, ttl: 300 } })
  async create(
    @Param('pageId') pageId: string,
    @Body() body: { baseRevisionId?: string; contentRaw?: string; editSummary?: string; isMinor?: boolean; captchaToken?: string; policyAcceptance?: WikiPolicyAcceptance },
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const session = request.sessionPayload ?? null;
    if (session) {
      const authenticatedBody = { ...body };
      delete authenticatedBody.captchaToken;
      return this.requests.create(session, pageId, authenticatedBody);
    }
    this.requests.assertAnonymousSubmissionEnabled();
    if (!this.wikiCaptcha.isRequired()) {
      throw new ServiceUnavailableException({
        code: 'WIKI_ANONYMOUS_EDIT_REQUESTS_UNAVAILABLE',
        message: '익명 편집 요청의 로봇 방지 확인이 구성되지 않았습니다.',
      });
    }
    const requestIp = request.clientIp;
    if (!requestIp) throw new ServiceUnavailableException('Validated client address is unavailable.');
    await this.wikiCaptcha.assertVerified(body.captchaToken, requestIp);
    const anonymousBody = { ...body };
    delete anonymousBody.captchaToken;
    const result = await this.requests.createAnonymous(
      pageId,
      anonymousBody,
      requestIp,
      readWikiAnonymousContributorToken(request.headers?.cookie),
    );
    reply.header('Set-Cookie', serializeWikiAnonymousContributorCookie(result.ownerToken));
    return result.request;
  }

  @Post('edit-requests')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async createForNewPage(
    @Body() body: { namespace?: string; title?: string; spaceId?: string; contentRaw?: string; editSummary?: string; isMinor?: boolean; captchaToken?: string; policyAcceptance?: WikiPolicyAcceptance },
    @CurrentSession() session: SessionPayload,
    @Req() request: FastifyRequest
  ) {
    await this.wikiCaptcha.assertVerified(body.captchaToken, request.clientIp ?? session.requestIp);
    const editRequest = { ...body };
    delete editRequest.captchaToken;
    return this.requests.createForNewPage(session, editRequest);
  }

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
  @UseGuards(OptionalSessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  update(@Param('requestId') requestId: string, @Body() body: { baseRevisionId?: string; contentRaw?: string; editSummary?: string; isMinor?: boolean; policyAcceptance?: WikiPolicyAcceptance }, @Req() request: FastifyRequest) {
    return this.requests.update(request.sessionPayload ?? null, requestId, body, readWikiAnonymousContributorToken(request.headers?.cookie), request.clientIp);
  }

  @Post('edit-requests/:requestId/rebase')
  @UseGuards(OptionalSessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  rebase(
    @Param('requestId') requestId: string,
    @Body() body: { contentRaw?: string; currentRevisionId?: string; editSummary?: string; isMinor?: boolean; policyAcceptance?: WikiPolicyAcceptance },
    @Req() request: FastifyRequest,
  ) {
    return this.requests.rebase(request.sessionPayload ?? null, requestId, body, readWikiAnonymousContributorToken(request.headers?.cookie), request.clientIp);
  }

  @Post('edit-requests/:requestId/close')
  @UseGuards(OptionalSessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  close(@Param('requestId') requestId: string, @Req() request: FastifyRequest) {
    return this.requests.close(request.sessionPayload ?? null, requestId, readWikiAnonymousContributorToken(request.headers?.cookie), request.clientIp);
  }

  @Post('edit-requests/:requestId/reopen')
  @UseGuards(OptionalSessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  reopen(@Param('requestId') requestId: string, @Req() request: FastifyRequest) {
    return this.requests.reopen(request.sessionPayload ?? null, requestId, readWikiAnonymousContributorToken(request.headers?.cookie), request.clientIp);
  }

  @Post('edit-requests/:requestId/claim')
  @UseGuards(SessionGuard)
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async claim(
    @Param('requestId') requestId: string,
    @CurrentSession() session: SessionPayload,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const result = await this.requests.claim(session, requestId, readWikiAnonymousContributorToken(request.headers?.cookie));
    if (result.capabilityRevoked) reply.header('Set-Cookie', clearWikiAnonymousContributorCookie());
    return result.request;
  }
}
