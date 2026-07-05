import { Controller, Get, UseGuards } from '@nestjs/common';
import { DashboardService } from './dashboard.service';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';

@UseGuards(SessionGuard)
@Controller('v1/dashboard')
export class DashboardController {
  constructor(private readonly dashboard: DashboardService) {}

  @Get('overview')
  overview(@CurrentSession() session: SessionPayload) {
    return this.dashboard.getOverview(session.userId);
  }
}