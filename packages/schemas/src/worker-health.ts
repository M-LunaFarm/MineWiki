import { z } from 'zod';

export const WORKER_HEARTBEAT_KEY = 'minewiki:worker:heartbeat:v1';
export const WORKER_HEARTBEAT_INTERVAL_MS = 10_000;
export const WORKER_HEARTBEAT_MAX_AGE_MS = 45_000;
export const OBSERVED_WORKER_QUEUES = [
  'server-ping',
  'rank-aggregation',
  'claim-check',
  'vote-dispatch',
  'discord-digest',
  'discord-verify-sync',
] as const;

export const WORKER_QUEUE_STALE_AFTER_MS: Readonly<Record<(typeof OBSERVED_WORKER_QUEUES)[number], number>> = {
  'server-ping': 15 * 60_000,
  'rank-aggregation': 2 * 60 * 60_000,
  'claim-check': 2 * 60 * 60_000,
  'vote-dispatch': 2 * 60_000,
  'discord-digest': 10 * 60_000,
  'discord-verify-sync': 2 * 60_000,
};

export const workerQueueHealthSchema = z.object({
  waiting: z.number().int().nonnegative(),
  active: z.number().int().nonnegative(),
  delayed: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  oldestPendingAt: z.string().datetime().nullable(),
}).strict();

export const workerHeartbeatSchema = z.object({
  version: z.literal(1),
  instanceId: z.string().uuid(),
  pid: z.number().int().positive(),
  workerCount: z.number().int().positive(),
  startedAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  queues: z.record(z.string(), workerQueueHealthSchema),
}).strict();

export type WorkerHeartbeat = z.infer<typeof workerHeartbeatSchema>;
