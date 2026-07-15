import {
  BadRequestException,
  Controller,
  Get,
  Param,
  ParseUUIDPipe,
  Post,
  UseGuards
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { VoteService } from './vote.service';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';
import { ClaimService } from '../claim/claim.service';

@Controller('v1/servers/:serverId/vote-dispatch-attempts')
export class VoteDispatchController {
  constructor(
    private readonly voteService: VoteService,
    private readonly claimService: ClaimService
  ) {}

  @RequireStepUp('vote_admin')
  @UseGuards(SessionGuard)
  @Get()
  async list(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @CurrentSession() session: SessionPayload
  ) {
    await this.ensureCanManage(serverId, session);
    return this.voteService.listDispatchAttempts(serverId);
  }

  @RequireStepUp('vote_admin')
  @UseGuards(SessionGuard)
  @Post(':attemptId/replay')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  async replay(
    @Param('serverId', new ParseUUIDPipe()) serverId: string,
    @Param('attemptId', new ParseUUIDPipe()) attemptId: string,
    @CurrentSession() session: SessionPayload
  ) {
    await this.ensureCanManage(serverId, session);
    return this.voteService.replayDispatchAttempt(serverId, attemptId);
  }

  private async ensureCanManage(serverId: string, session: SessionPayload): Promise<void> {
    if (
      session.permissions?.includes('server.admin') === true ||
      (await this.claimService.isOwner(serverId, session.userId))
    ) {
      return;
    }
    throw new BadRequestException('해당 서버의 투표 전달 기록을 볼 권한이 없습니다.');
  }
}
