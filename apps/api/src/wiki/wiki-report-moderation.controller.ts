import { Body, Controller, ForbiddenException, Get, Param, ParseUUIDPipe, Patch, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { WikiReportModerationService } from './wiki-report-moderation.service';

const queueSchema = z.object({
  status: z.enum(['open', 'in_review', 'resolved', 'dismissed']).optional(),
  targetType: z.enum(['page', 'revision', 'discussion', 'comment']).optional(),
  targetId: z.string().regex(/^[1-9]\d*$/).max(20).optional(),
  assignee: z.union([z.literal('me'), z.literal('unassigned'), z.string().regex(/^[1-9]\d*$/).max(20)]).optional(),
  cursor: z.string().min(1).max(1_024).optional(),
  limit: z.coerce.number().int().min(1).max(50).default(20),
});

const assignSchema = z.object({
  expectedVersion: z.number().int().min(1),
  assigneeProfileId: z.string().regex(/^[1-9]\d*$/).max(20).nullable().optional(),
}).strict();

const transitionSchema = z.object({
  expectedVersion: z.number().int().min(1),
  status: z.enum(['open', 'in_review', 'resolved', 'dismissed']),
  resolution: z.string().trim().min(3).max(1_000).optional(),
}).strict();

@Controller('v1/admin/wiki/reports')
@RequireStepUp('wiki_admin')
@UseGuards(SessionGuard)
export class WikiReportModerationController {
  constructor(private readonly moderation: WikiReportModerationService) {}

  @Get()
  @Throttle({ default: { limit: 60, ttl: 60 } })
  list(
    @CurrentSession() session: SessionPayload,
    @Query('status') status?: string,
    @Query('targetType') targetType?: string,
    @Query('targetId') targetId?: string,
    @Query('assignee') assignee?: string,
    @Query('cursor') cursor?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertModerator(session);
    return this.moderation.listQueue(session, queueSchema.parse({
      status: status?.trim() || undefined,
      targetType: targetType?.trim() || undefined,
      targetId: targetId?.trim() || undefined,
      assignee: assignee?.trim() || undefined,
      cursor: cursor?.trim() || undefined,
      limit: limit?.trim() || undefined,
    }));
  }

  @Patch(':caseId/assignment')
  @Throttle({ default: { limit: 30, ttl: 300 } })
  assign(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ) {
    this.assertModerator(session);
    const payload = assignSchema.parse(body);
    return this.moderation.assign(caseId, session, payload.expectedVersion, payload.assigneeProfileId);
  }

  @Patch(':caseId/status')
  @Throttle({ default: { limit: 20, ttl: 300 } })
  transition(
    @Param('caseId', new ParseUUIDPipe()) caseId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ) {
    this.assertModerator(session);
    return this.moderation.transition(caseId, session, transitionSchema.parse(body));
  }

  private assertModerator(session: SessionPayload): void {
    if (
      session.permissions?.includes('wiki.report.moderate') !== true &&
      session.groups?.some((group) => group === 'owner' || group === 'admin') !== true
    ) {
      throw new ForbiddenException('Wiki report moderation permission is required.');
    }
  }
}
