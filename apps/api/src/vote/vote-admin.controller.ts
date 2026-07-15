import {
  Body,
  Controller,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { z } from 'zod';
import { CurrentSession } from '../session/session.decorator';
import { SessionGuard } from '../session/session.guard';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { VoteService } from './vote.service';

const invalidateVoteSchema = z
  .object({ reason: z.string().trim().min(3).max(500) })
  .strict();

@Controller('v1/admin/votes')
@RequireStepUp('vote_admin')
@UseGuards(SessionGuard)
export class VoteAdminController {
  constructor(private readonly votes: VoteService) {}

  @Get()
  list(
    @CurrentSession() session: SessionPayload,
    @Query('serverId') serverId?: string,
    @Query('status') status?: string,
    @Query('search') search?: string,
    @Query('limit') limit?: string,
  ) {
    this.assertAdmin(session);
    const query = z
      .object({
        serverId: z.string().uuid().optional(),
        status: z.enum(['valid', 'invalid']).optional(),
        search: z.string().trim().min(1).max(64).optional(),
        limit: z.coerce.number().int().min(1).max(200).default(100),
      })
      .parse({
        serverId: serverId?.trim() || undefined,
        status: status?.trim() || undefined,
        search: search?.trim() || undefined,
        limit: limit?.trim() || undefined,
      });
    return this.votes.listVotesForModeration({
      serverId: query.serverId,
      status: query.status,
      search: query.search,
      limit: query.limit ?? 100,
    });
  }

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
      !roles.some((role) => role === 'admin' || role === 'owner') &&
      !permissions.some((permission) => permission === 'vote.admin' || permission === 'server.admin')
    ) {
      throw new ForbiddenException('투표 관리 권한이 필요합니다.');
    }
  }
}
