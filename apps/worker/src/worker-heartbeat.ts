import type Redis from 'ioredis';
import type { Queue } from 'bullmq';
import {
  WORKER_HEARTBEAT_INTERVAL_MS,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_MAX_AGE_MS,
  workerHeartbeatSchema,
} from '@minewiki/schemas';

export interface WorkerHeartbeatIdentity {
  readonly instanceId: string;
  readonly pid: number;
  readonly workerCount: number;
  readonly startedAt: string;
}

export async function publishWorkerHeartbeat(
  redis: Redis,
  identity: WorkerHeartbeatIdentity,
  queues: readonly Queue[],
  now = new Date(),
): Promise<void> {
  const queueHealth = await collectWorkerQueueHealth(queues);
  const heartbeat = workerHeartbeatSchema.parse({
    version: 1,
    ...identity,
    updatedAt: now.toISOString(),
    queues: queueHealth,
  });
  const ttlSeconds = Math.ceil((WORKER_HEARTBEAT_MAX_AGE_MS + WORKER_HEARTBEAT_INTERVAL_MS) / 1_000);
  await redis.set(WORKER_HEARTBEAT_KEY, JSON.stringify(heartbeat), 'EX', ttlSeconds);
}

export async function collectWorkerQueueHealth(queues: readonly Queue[]) {
  return Object.fromEntries(await Promise.all(queues.map(async (queue) => {
    const [counts, oldest] = await Promise.all([
      queue.getJobCounts('waiting', 'active', 'delayed', 'failed'),
      queue.getJobs(['waiting', 'active'], 0, 0, true),
    ]);
    return [queue.name, {
      waiting: counts.waiting ?? 0,
      active: counts.active ?? 0,
      delayed: counts.delayed ?? 0,
      failed: counts.failed ?? 0,
      oldestPendingAt: oldest[0] ? new Date(oldest[0].timestamp).toISOString() : null,
    }] as const;
  })));
}
