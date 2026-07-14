import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { accountDeletionAdminActionSchema } from '@minewiki/schemas';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { AccountDeletionService } from './account-deletion.service';

@Controller('v1/admin/account-deletions')
@UseGuards(SessionGuard)
export class AccountDeletionAdminController {
  constructor(private readonly deletions: AccountDeletionService) {}

  @Get()
  list(@CurrentSession() session: SessionPayload, @Query('status') status?: string) { this.assertAdmin(session); return this.deletions.listAdmin(status); }

  @Post(':requestId/process')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  process(@Param('requestId') requestId: string, @Body() body: unknown, @CurrentSession() session: SessionPayload) {
    this.assertAdmin(session); const payload = accountDeletionAdminActionSchema.parse(body); return this.deletions.process(requestId, session.userId, payload.note);
  }

  @Post(':requestId/reject')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  reject(@Param('requestId') requestId: string, @Body() body: unknown, @CurrentSession() session: SessionPayload) {
    this.assertAdmin(session); const payload = accountDeletionAdminActionSchema.parse(body); return this.deletions.reject(requestId, session.userId, payload.note ?? '관리자 반려');
  }

  private assertAdmin(session: SessionPayload): void {
    if (session.groups?.some((group) => group === 'owner' || group === 'admin') !== true && session.permissions?.includes('admin.account.delete') !== true) throw new ForbiddenException('계정 종료 관리자 권한이 필요합니다.');
  }
}
