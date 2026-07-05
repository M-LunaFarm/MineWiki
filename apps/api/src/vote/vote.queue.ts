import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { Queue } from 'bullmq';
import Redis from 'ioredis';
import type { VoteDispatchJob } from '@minewiki/schemas';

@Injectable()
export class VoteQueueService implements OnModuleDestroy {
  private readonly queue: Queue<VoteDispatchJob>;
  private readonly connection: Redis;

  constructor(config: ConfigService) {
    const redisUrl = config.get('REDIS_URL', 'redis://localhost:6379');
    this.connection = new Redis(redisUrl);
    this.queue = new Queue<VoteDispatchJob>('vote-dispatch', {
      connection: this.connection,
      defaultJobOptions: {
        removeOnComplete: 100,
        removeOnFail: 500
      }
    });
  }

  async enqueue(job: VoteDispatchJob): Promise<void> {
    await this.queue.add('dispatch', job);
  }

  async getJobCounts(): Promise<Record<string, number>> {
    return this.queue.getJobCounts('completed', 'failed', 'waiting', 'active', 'delayed');
  }

  async onModuleDestroy(): Promise<void> {
    await this.queue.close();
    await this.connection.quit();
  }
}
