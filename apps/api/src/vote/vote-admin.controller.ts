import {
  Body,
  Controller,
  ForbiddenException,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { VoteService } from './vote.service';

const invalidateVoteSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

@Controller('v1/admin/votes')
@UseGuards(SessionGuard)
export class VoteAdminController {
  constructor(private readonly votes: VoteService) {}

  @Post(':voteId/invalidate')
  @Throttle({ default: { limit: 30, ttl: 300 } })
  invalidate(
    @Param('voteId', new ParseUUIDPipe()) voteId: string,
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ) {
    this.assertAdmin(session);
    const payload = invalidateVoteSchema.parse(body);
    return this.votes.invalidateVote(voteId, session.userId, payload.reason);
  }

  private assertAdmin(session: SessionPayload): void {
    const roles = session.groups ?? [];
    const permissions = session.permissions ?? [];
    if (
      !session.isElevated &&
      !roles.some((role) => role === 'admin' || role === 'owner') &&
      !permissions.some((permission) => permission === 'vote.admin' || permission === 'server.admin')
    ) {
      throw new ForbiddenException('투표 관리 권한이 필요합니다.');
    }
  }
}
