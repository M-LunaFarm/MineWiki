import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseIntPipe,
  ParseUUIDPipe,
  Patch,
  Post,
  Query,
  Req,
  UseGuards
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { ServerReview } from '@minewiki/schemas';
import {
  ReviewService,
  type ReviewListOptions,
  type ReviewPageResponse,
  type ReviewSort,
  isReviewTag
} from './review.service';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';
import type { FastifyRequest } from 'fastify';
import { SessionService } from '../session/session.service';
import { ClaimService } from '../claim/claim.service';
import { z } from 'zod';

const reviewReportRequestSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();
const reviewReplyRequestSchema = z
  .object({ body: z.string().trim().max(300) })
  .strict();

@Controller('v1/servers/:serverId/reviews')
export class ReviewController {
  constructor(
    private readonly reviewService: ReviewService,
    private readonly sessions: SessionService,
    private readonly claims: ClaimService
  ) {}

  @Get()
  async list(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Req() request: FastifyRequest,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('rating', new ParseIntPipe({ optional: true })) ratingParam?: number,
    @Query('tag') tag?: string | string[],
    @Query('sort') sortParam?: string
  ): Promise<ServerReview[]> {
    const rating = ratingParam && ratingParam >= 1 && ratingParam <= 5 ? ratingParam : undefined;
    const normalizedTag = Array.isArray(tag) ? tag.at(0) : tag;
    const tagFilter = isReviewTag(normalizedTag) ? normalizedTag : undefined;
    const sort = normalizeReviewSort(sortParam);
    const options: ReviewListOptions = {
      limit,
      rating,
      tag: tagFilter,
      sort
    };
    const sessionToken = extractSessionToken(request);
    const sessionRecord = sessionToken ? await this.sessions.getSessionByToken(sessionToken) : undefined;
    return this.reviewService.list(serverId, options, sessionRecord?.userId);
  }

  @Get('gate')
  async gate(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Req() request: FastifyRequest
  ) {
    const sessionToken = extractSessionToken(request);
    const sessionRecord = sessionToken ? await this.sessions.getSessionByToken(sessionToken) : undefined;
    const payload = sessionRecord ? this.sessions.toPayload(sessionRecord) : undefined;
    return this.reviewService.getGateStatus(serverId, payload);
  }

  @Get('page')
  async page(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Req() request: FastifyRequest,
    @Query('cursor') cursor?: string,
    @Query('limit', new ParseIntPipe({ optional: true })) limit?: number,
    @Query('rating', new ParseIntPipe({ optional: true })) ratingParam?: number,
    @Query('tag') tag?: string | string[],
    @Query('sort') sortParam?: string
  ): Promise<ReviewPageResponse> {
    if (cursor && cursor.length > 2048) {
      throw new BadRequestException('리뷰 페이지 커서가 너무 깁니다.');
    }
    const rating = ratingParam && ratingParam >= 1 && ratingParam <= 5 ? ratingParam : undefined;
    const normalizedTag = Array.isArray(tag) ? tag.at(0) : tag;
    const tagFilter = isReviewTag(normalizedTag) ? normalizedTag : undefined;
    const sessionToken = extractSessionToken(request);
    const sessionRecord = sessionToken ? await this.sessions.getSessionByToken(sessionToken) : undefined;
    return this.reviewService.listPage(serverId, {
      cursor,
      limit,
      rating,
      tag: tagFilter,
      sort: normalizeReviewSort(sortParam)
    }, sessionRecord?.userId);
  }

  @UseGuards(SessionGuard)
  @Get('staff')
  async listAll(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload
  ): Promise<ServerReview[]> {
    if (!(await this.claims.isOwner(serverId, session.userId))) {
      throw new ForbiddenException('서버 리뷰를 조회할 권한이 없습니다.');
    }
    return this.reviewService.listAll(serverId, session.userId);
  }

  @UseGuards(SessionGuard)
  @Get('mine')
  async listMine(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload
  ): Promise<ServerReview[]> {
    return this.reviewService.listMine(serverId, session.userId);
  }

  @UseGuards(SessionGuard)
  @Post()
  @Throttle({ default: { limit: 3, ttl: 60 } })
  async create(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ): Promise<ServerReview> {
    return this.reviewService.create(serverId, body, session);
  }

  @UseGuards(SessionGuard)
  @Patch(':reviewId')
  @Throttle({ default: { limit: 6, ttl: 60 } })
  async update(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ): Promise<ServerReview> {
    return this.reviewService.update(serverId, reviewId, body, session);
  }

  @UseGuards(SessionGuard)
  @Delete(':reviewId')
  @Throttle({ default: { limit: 4, ttl: 60 } })
  async remove(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
    @CurrentSession() session: SessionPayload
  ): Promise<{ deleted: true }> {
    await this.reviewService.remove(serverId, reviewId, session);
    return { deleted: true };
  }

  @UseGuards(SessionGuard)
  @Post(':reviewId/helpful')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async markHelpful(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
    @CurrentSession() session: SessionPayload,
    @Body('isHelpful') isHelpful?: boolean
  ): Promise<ServerReview> {
    return this.reviewService.markHelpful(serverId, reviewId, session.userId, isHelpful ?? true);
  }

  @UseGuards(SessionGuard)
  @Post(':reviewId/report')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async report(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown
  ): Promise<ServerReview> {
    const payload = reviewReportRequestSchema.parse(body);
    return this.reviewService.report(serverId, reviewId, session.userId, payload.reason);
  }

  @UseGuards(SessionGuard)
  @Post(':reviewId/reply')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  async reply(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('reviewId', new ParseUUIDPipe()) reviewId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload
  ): Promise<ServerReview> {
    if (!(await this.claims.isOwner(serverId, session.userId))) {
      throw new ForbiddenException('서버 리뷰에 답글을 남길 권한이 없습니다.');
    }
    const payload = reviewReplyRequestSchema.parse(body);
    const responder = '운영진';
    return this.reviewService.setAdminReply(
      serverId,
      reviewId,
      responder,
      payload.body,
      session.userId,
    );
  }
}

const REVIEW_SORTS: ReviewSort[] = ['wilson', 'newest'];

function normalizeReviewSort(value?: string): ReviewSort {
  if (!value) {
    return 'wilson';
  }
  return (REVIEW_SORTS.includes(value as ReviewSort) ? value : 'wilson') as ReviewSort;
}

function extractSessionToken(request: FastifyRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === 'mw_session') {
      return decodeURIComponent(value ?? '');
    }
  }
  return undefined;
}
