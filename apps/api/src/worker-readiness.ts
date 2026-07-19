import type Redis from 'ioredis';
import {
  OBSERVED_WORKER_QUEUES,
  WORKER_HEARTBEAT_KEY,
  WORKER_HEARTBEAT_MAX_AGE_MS,
  WORKER_QUEUE_STALE_AFTER_MS,
  WORKER_RECENT_FAILURE_DEGRADED_THRESHOLD,
  workerHeartbeatSchema,
} from '@minewiki/schemas';

export interface WorkerQueueCheck {
  readonly waiting: number;
  readonly active: number;
  readonly delayed: number;
  readonly failed: number;
  readonly recentFailed?: number;
  readonly latestFailedAt?: string | null;
  readonly oldestPendingAt: string | null;
}

export interface WorkerReadinessCheck {
  readonly status: 'ok' | 'degraded' | 'error' | 'disabled';
  readonly latencyMs: number;
  readonly message?: string;
  readonly instanceId?: string;
  readonly updatedAt?: string;
  readonly ageMs?: number;
  readonly failedJobs?: number;
  readonly recentFailedJobs?: number;
  readonly failingQueues?: readonly string[];
  readonly staleQueues?: readonly string[];
  readonly queues?: Readonly<Record<string, WorkerQueueCheck>>;
}

interface ParsedWorkerHeartbeat {
  readonly instanceId: string;
  readonly updatedAt: string;
  readonly queues: Readonly<Record<string, WorkerQueueCheck>>;
}

export async function checkWorkerReadiness(
  redis: Redis,
  now = new Date(),
): Promise<WorkerReadinessCheck> {
  const startedAt = Date.now();
  const rawHeartbeat = await redis.get(WORKER_HEARTBEAT_KEY);
  if (!rawHeartbeat) return failure(startedAt, 'worker_heartbeat_missing');

  let heartbeat;
  try {
    heartbeat = workerHeartbeatSchema.parse(JSON.parse(rawHeartbeat)) as ParsedWorkerHeartbeat;
  } catch {
    return failure(startedAt, 'worker_heartbeat_invalid');
  }

  const ageMs = now.getTime() - Date.parse(heartbeat.updatedAt);
  if (ageMs < -5_000) return failure(startedAt, 'worker_heartbeat_from_future');
  if (ageMs > WORKER_HEARTBEAT_MAX_AGE_MS) return failure(startedAt, 'worker_heartbeat_stale', ageMs);

  const queues = heartbeat.queues;
  if (OBSERVED_WORKER_QUEUES.some((queueName) => !queues[queueName])) {
    return failure(startedAt, 'worker_queue_snapshot_missing', ageMs);
  }
  const failedJobs = OBSERVED_WORKER_QUEUES.reduce(
    (total, queueName) => total + (queues[queueName]?.failed ?? 0),
    0,
  );
  const staleQueues = OBSERVED_WORKER_QUEUES.filter((queueName) => {
    const oldestPendingAt = queues[queueName]?.oldestPendingAt;
    return oldestPendingAt
      ? now.getTime() - Date.parse(oldestPendingAt) > WORKER_QUEUE_STALE_AFTER_MS[queueName]
      : false;
  });
  const recentFailedJobs = OBSERVED_WORKER_QUEUES.reduce(
    (total, queueName) => total + (queues[queueName]?.recentFailed ?? 0),
    0,
  );
  const failingQueues = OBSERVED_WORKER_QUEUES.filter(
    (queueName) => (queues[queueName]?.recentFailed ?? 0) >= WORKER_RECENT_FAILURE_DEGRADED_THRESHOLD,
  );
  const isDegraded = staleQueues.length > 0 || failingQueues.length > 0;
  const message = staleQueues.length > 0
    ? 'worker_queue_stale'
    : failingQueues.length > 0
      ? 'worker_queue_recent_failures'
      : undefined;
  return {
    status: isDegraded ? 'degraded' : 'ok',
    latencyMs: Date.now() - startedAt,
    message,
    instanceId: heartbeat.instanceId,
    updatedAt: heartbeat.updatedAt,
    ageMs: Math.max(0, ageMs),
    failedJobs,
    recentFailedJobs,
    failingQueues,
    staleQueues,
    queues,
  };
}

function failure(
  startedAt: number,
  message: string,
  ageMs?: number,
): WorkerReadinessCheck {
  return {
    status: 'error',
    latencyMs: Date.now() - startedAt,
    message,
    ageMs,
  };
}
