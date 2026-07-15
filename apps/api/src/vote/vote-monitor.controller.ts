import { Controller, ForbiddenException, Get, UseGuards } from '@nestjs/common';
import { VoteQueueService } from './vote.queue';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import type { SessionPayload } from '../session/session.service';
import { RequireStepUp } from '../session/step-up.decorator';

@Controller('v1/monitoring/queues')
@RequireStepUp('vote_admin')
@UseGuards(SessionGuard)
export class VoteMonitorController {
  constructor(private readonly queue: VoteQueueService) {}

  @Get('vote-dispatch')
  async summary(@CurrentSession() session: SessionPayload) {
    if (
      session.groups?.includes('admin') !== true &&
      !(session.permissions ?? []).some((permission) => permission.endsWith('.admin'))
    ) {
      throw new ForbiddenException('운영 모니터링 권한이 필요합니다.');
    }
    const counts = await this.queue.getJobCounts();
    return counts;
  }
}
