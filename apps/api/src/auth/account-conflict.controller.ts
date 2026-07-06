import { Body, Controller, Get, Post, UseGuards } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import {
  AccountConflictService,
  type LinkConflictResponse,
  type MergeRequestResponse,
} from './account-conflict.service';

@UseGuards(SessionGuard)
@Controller('v1/account')
export class AccountConflictController {
  constructor(private readonly conflicts: AccountConflictService) {}

  @Get('link-conflicts')
  listConflicts(@CurrentSession() session: SessionPayload): Promise<LinkConflictResponse> {
    return this.conflicts.listLinkConflicts(session.userId);
  }

  @Post('merge-requests')
  @Throttle({ default: { limit: 3, ttl: 300 } })
  createMergeRequest(
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ): Promise<MergeRequestResponse> {
    return this.conflicts.createMergeRequest(session.userId, body);
  }
}
