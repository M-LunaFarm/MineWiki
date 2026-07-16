import { Body, Controller, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { WikiReportService, type WikiReportResponse } from './wiki-report.service';

const reportSchema = z.object({
  targetType: z.enum(['page', 'revision', 'discussion', 'comment']),
  targetId: z.string().regex(/^[1-9]\d*$/).max(20),
  reason: z.string().trim().min(3).max(1_000),
}).strict();

@Controller('v1/wiki/reports')
@UseGuards(SessionGuard)
export class WikiReportController {
  constructor(private readonly reports: WikiReportService) {}

  @Post()
  @Throttle({ default: { limit: 10, ttl: 60 } })
  report(@CurrentSession() session: SessionPayload, @Body() body: unknown): Promise<WikiReportResponse> {
    return this.reports.report(session, reportSchema.parse(body));
  }
}
