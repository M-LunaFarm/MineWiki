import { Controller, ForbiddenException, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { BusinessEventService, type AuditEventResponse } from './business-event.service';

@Controller('v1/admin/audit')
@UseGuards(SessionGuard)
export class AuditController {
  constructor(private readonly events: BusinessEventService) {}

  @Get()
  async list(
    @CurrentSession() session: SessionPayload,
    @Query('category') category?: string,
    @Query('action') action?: string,
    @Query('limit') limit?: string
  ): Promise<AuditEventResponse[]> {
    this.assertAdmin(session);
    return this.events.listAuditEvents({ category, action, limit });
  }

  private assertAdmin(session: SessionPayload): void {
    const permissions = session.permissions ?? [];
    if (
      session.groups?.includes('admin') !== true &&
      !permissions.some((permission) => permission.endsWith('.admin') || permission === 'support.admin')
    ) {
      throw new ForbiddenException('Audit admin permission is required.');
    }
  }
}
