import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  HttpCode,
  Param,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import {
  accountRestoreActionSchema,
  accountSuspendActionSchema,
  adminAccountListQuerySchema,
  type AccountModerationResult,
  type AdminAccountDetail,
  type AdminAccountListResponse,
} from '@minewiki/schemas';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { AccountModerationService } from './account-moderation.service';

@Controller('v1/admin/accounts')
@RequireStepUp('account_moderation')
@UseGuards(SessionGuard)
export class AccountModerationController {
  constructor(private readonly moderation: AccountModerationService) {}

  @Get()
  list(
    @CurrentSession() session: SessionPayload,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('limit') limit?: string,
  ): Promise<AdminAccountListResponse> {
    this.assertPermission(session);
    return this.moderation.list(adminAccountListQuerySchema.parse({ q, status, limit }));
  }

  @Get(':accountId')
  detail(
    @Param('accountId') accountId: string,
    @CurrentSession() session: SessionPayload,
  ): Promise<AdminAccountDetail> {
    this.assertPermission(session);
    return this.moderation.getDetail(accountId);
  }

  @Post(':accountId/suspend')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60 } })
  suspend(
    @Param('accountId') accountId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ): Promise<AccountModerationResult> {
    this.assertPermission(session);
    return this.moderation.suspend(
      session.userId,
      accountId,
      accountSuspendActionSchema.parse(body),
    );
  }

  @Post(':accountId/restore')
  @HttpCode(200)
  @Throttle({ default: { limit: 10, ttl: 60 } })
  restore(
    @Param('accountId') accountId: string,
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
  ): Promise<AccountModerationResult> {
    this.assertPermission(session);
    return this.moderation.restore(
      session.userId,
      accountId,
      accountRestoreActionSchema.parse(body),
    );
  }

  private assertPermission(session: SessionPayload): void {
    if (session.permissions?.includes('admin.account.suspend') !== true) {
      throw new ForbiddenException('계정 정지 관리자 권한이 필요합니다.');
    }
  }
}
