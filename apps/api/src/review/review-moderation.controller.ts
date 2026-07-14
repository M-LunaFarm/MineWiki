import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { ReviewModerationService } from './review-moderation.service';

const listQuerySchema = z.object({
  status: z.enum(['open', 'in_review', 'resolved', 'dismissed']).optional(),
  serverId: z.string().uuid().optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().uuid()]).optional(),
  search: z.string().trim().min(1).max(100).optional(),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(50).default(20),
});

const assignSchema = z.object({ assigneeAccountId: z.string().uuid().optional() }).strict();
const resolutionSchema = z
  .object({
    resolution: z.string().trim().min(3).max(1000),
    hideReview: z.boolean().default(false),
  })
  .strict();

@Controller('v1/admin/review-reports')
@UseGuards(SessionGuard)
export class ReviewModerationController {
  constructor(private readonly moderation: ReviewModerationService) {}

  @Get()
  list(
    @CurrentSession() session: SessionPayload,
    @Query('status') status?: string,
    @Query('serverId') serverId?: string,
    @Query('assignee') assignee?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('pageSize') pageSize?: string,
  ) {
    this.assertModerator(session);
    const query = listQuerySchema.parse({
      status: status?.trim() || undefined,
      serverId: serverId?.trim() || undefined,
      assignee: assignee?.trim() || undefined,
      search: search?.trim() || undefined,
      page: page?.trim() || undefined,
      pageSize: pageSize?.trim() || undefined,
    });
    return this.moderation.listReports({
      status: query.status,
      serverId: query.serverId,
      assigneeAccountId:
        query.assignee === 'me'
          ? session.userId
          : query.assignee === 'unassigned'
            ? null
            : query.assignee,
      search: query.search,
      page: query.page,
      pageSize: query.pageSize,
    });
  }

  @Patch(':reportId/assign')
  @Throttle({ default: { limit: 40, ttl: 300 } })
  assign(
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ) {
    this.assertModerator(session);
    const payload = assignSchema.parse(body);
    return this.moderation.assign(
      reportId,
      session.userId,
      payload.assigneeAccountId ?? session.userId,
    );
  }

  @Patch(':reportId/resolve')
  @Throttle({ default: { limit: 40, ttl: 300 } })
  resolve(
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ) {
    this.assertModerator(session);
    const payload = resolutionSchema.parse(body);
    return this.moderation.resolve(
      reportId,
      session.userId,
      'resolved',
      { resolution: payload.resolution!, hideReview: payload.hideReview ?? false },
    );
  }

  @Patch(':reportId/dismiss')
  @Throttle({ default: { limit: 40, ttl: 300 } })
  dismiss(
    @Param('reportId', new ParseUUIDPipe()) reportId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ) {
    this.assertModerator(session);
    const payload = resolutionSchema.parse(body);
    return this.moderation.resolve(
      reportId,
      session.userId,
      'dismissed',
      { resolution: payload.resolution!, hideReview: payload.hideReview ?? false },
    );
  }

  private assertModerator(session: SessionPayload): void {
    if (
      !session.isElevated &&
      !session.groups?.some((role) => role === 'owner' || role === 'admin') &&
      !session.permissions?.includes('review.moderate')
    ) {
      throw new ForbiddenException('리뷰 신고 처리 권한이 필요합니다.');
    }
  }
}
