import { Controller, Get } from '@nestjs/common';
import { VoteQueueService } from './vote.queue';

@Controller('v1/monitoring/queues')
export class VoteMonitorController {
  constructor(private readonly queue: VoteQueueService) {}

  @Get('vote-dispatch')
  async summary() {
    const counts = await this.queue.getJobCounts();
    return counts;
  }
}
