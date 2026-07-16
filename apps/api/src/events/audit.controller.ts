import { Controller, ForbiddenException, Get, Query, UseGuards } from '@nestjs/common';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { BusinessEventService, type AuditEventResponse } from './business-event.service';

@Controller('v1/admin/audit')
@RequireStepUp('audit_read')
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
      session.groups?.some((group) => group === 'owner' || group === 'admin') !== true &&
      !permissions.includes('admin.audit.read')
    ) {
      throw new ForbiddenException('Audit read permission is required.');
    }
  }
}
