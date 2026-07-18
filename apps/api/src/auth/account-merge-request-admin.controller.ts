import { Body, Controller, ForbiddenException, Get, Param, Post, Query, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { AccountMergeRequestService } from './account-merge-request.service';

@Controller('v1/admin/account-merge-requests')
@RequireStepUp('account_merge_admin')
@UseGuards(SessionGuard)
export class AccountMergeRequestAdminController {
  constructor(private readonly requests: AccountMergeRequestService) {}

  @Get()
  list(@CurrentSession() session: SessionPayload, @Query('status') status?: string) {
    this.assertAdmin(session);
    return this.requests.list(status);
  }

  @Post(':requestId/approve')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  approve(
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    this.assertAdmin(session);
    return this.requests.approve(requestId, session.userId, body);
  }

  @Post(':requestId/reject')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  reject(
    @Param('requestId') requestId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ) {
    this.assertAdmin(session);
    return this.requests.reject(requestId, session.userId, body);
  }

  private assertAdmin(session: SessionPayload): void {
    const privileged = session.groups?.some((group) => group === 'owner' || group === 'admin') === true;
    if (!privileged && session.permissions?.includes('admin.account.merge') !== true) {
      throw new ForbiddenException('계정 병합 관리자 권한이 필요합니다.');
    }
  }
}
