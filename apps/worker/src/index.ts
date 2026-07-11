import { Queue, Worker as BullWorker, type JobsOptions, type Processor } from 'bullmq';
import Redis from 'ioredis';
import { Logger, ObservabilityExporter } from '@minewiki/logger';
import { ConfigService, assertSupportedQueueServer } from '@minewiki/config';
import { SpanStatusCode, trace } from '@opentelemetry/api';
import * as Sentry from '@sentry/node';
import { PrismaClient } from '@prisma/client';
import { DateTime } from 'luxon';
import { createVoteDispatcher } from './processors/vote-dispatcher';
import { createServerPinger } from './processors/server-pinger';
import { createClaimVerifier } from './processors/claim-verifier';
import { createRankAggregator } from './processors/rank-aggregator';
import {
  createDiscordDigestSender,
  createDiscordDigestDeliverer,
  type DiscordDigestResult,
} from './processors/discord-digest';
import { createDiscordVerifySyncer } from './processors/discord-verify-sync';
import type {
  ClaimVerificationJob,
  DiscordDigestJob,
  DiscordVerifySyncJob,
  RankAggregationJob,
  ServerPingJob,
  VoteDispatchJob,
} from '@minewiki/schemas';

const PING_INTERVAL_MS = 5 * 60 * 1000;
const RANK_INTERVAL_MS = 60 * 60 * 1000;
const CLAIM_SCAN_INTERVAL_MS = 60 * 60 * 1000;
const CLAIM_PENDING_THRESHOLD_HOURS = 1;
const CLAIM_VERIFIED_THRESHOLD_HOURS = 24;
const MAX_PING_BATCH = 200;
const MAX_CLAIM_BATCH = 200;

const config = new ConfigService();
const redisUrl = config.get('REDIS_URL', 'redis://localhost:6379');
const connection = new Redis(redisUrl, {
  maxRetriesPerRequest: null,
});
const prisma = new PrismaClient();

const observabilityExporter = new ObservabilityExporter({
  endpoint: config.getOptional('OBSERVABILITY_ENDPOINT'),
  apiKey: config.getOptional('OBSERVABILITY_API_KEY'),
  source: 'worker',
});

const sentryDsn = config.getOptional('SENTRY_DSN');
if (sentryDsn) {
  Sentry.init({ dsn: sentryDsn, environment: config.get('NODE_ENV', 'development') });
  Sentry.addEventProcessor((event) => {
    void observabilityExporter.report({
      source: 'worker',
      type: 'sentry',
      level: event.level,
      message: event.message,
      exception: event.exception?.values?.[0]?.value,
      timestamp: new Date().toISOString(),
    });
    return event;
  });
}

connection.on('error', (error) => {
  Logger.error({ err: error }, 'Redis connection error');
});

const dispatcher = createVoteDispatcher({
  recorder: {
    async markStarted(dispatchAttemptId: string): Promise<void> {
      await prisma.voteDispatchAttempt.updateMany({
        where: { id: dispatchAttemptId, status: { not: 'success' } },
        data: {
          status: 'processing',
          attempts: { increment: 1 },
          lastAttemptAt: new Date(),
        },
      });
    },
    async markSucceeded(dispatchAttemptId: string): Promise<void> {
      await prisma.voteDispatchAttempt.update({
        where: { id: dispatchAttemptId },
        data: {
          status: 'success',
          error: null,
          lastAttemptAt: new Date(),
        },
      });
    },
    async markFailed(dispatchAttemptId: string, error: unknown): Promise<void> {
      await prisma.voteDispatchAttempt.update({
        where: { id: dispatchAttemptId },
        data: {
          status: 'failed',
          error: truncateDispatchError(error),
          lastAttemptAt: new Date(),
        },
      });
    },
  },
});
const pinger = createServerPinger(prisma);
const claimVerifier = createClaimVerifier(prisma);
const rankAggregator = createRankAggregator(prisma);
const discordToken = config.getOptional('DISCORD_BOT_TOKEN') ?? '';
const discordDeliverer = createDiscordDigestDeliverer({
  prisma,
  token: discordToken,
});
const discordDigestSender = createDiscordDigestSender(discordDeliverer);
const discordVerifySyncer = createDiscordVerifySyncer({
  prisma,
  token: discordToken,
});
const tracer = trace.getTracer('minewiki-worker');

if (!discordToken) {
  Logger.warn('DISCORD_BOT_TOKEN is missing; digest deliveries will fail until configured.');
}

const queues: Queue[] = [];
const workers: BullWorker[] = [];
const intervals: NodeJS.Timeout[] = [];
type WorkerJobData =
  | ClaimVerificationJob
  | DiscordDigestJob
  | DiscordVerifySyncJob
  | RankAggregationJob
  | ServerPingJob
  | VoteDispatchJob;
type WorkerHandler<Data extends WorkerJobData, Result = unknown> = Processor<Data, Result, string>;

function createQueue(name: string, jobOptions?: JobsOptions): Queue {
  const queue = new Queue(name, {
    connection,
    defaultJobOptions: {
      removeOnComplete: 100,
      removeOnFail: 500,
      ...jobOptions,
    },
  });
  queues.push(queue);
  return queue;
}

function withTelemetry<Data extends WorkerJobData, Result>(
  queueName: string,
  handler: WorkerHandler<Data, Result>,
): WorkerHandler<Data, Result> {
  return async (job) => {
    const span = tracer.startSpan(`worker.${queueName}`, {
      attributes: {
        'queue.name': queueName,
        'job.id': job.id ?? '',
        'job.name': job.name ?? 'dispatch',
        'job.attempts': job.attemptsMade ?? 0,
      },
    });
    const startedAt = Date.now();

    try {
      const result = await handler(job);
      span.setStatus({ code: SpanStatusCode.OK });
      void observabilityExporter.report({
        source: 'worker',
        type: 'queue',
        queue: queueName,
        jobId: job.id ?? '',
        jobName: job.name,
        status: 'completed',
        durationMs: Date.now() - startedAt,
        attempts: job.attemptsMade ?? 0,
        timestamp: new Date().toISOString(),
      });
      return result;
    } catch (error) {
      span.recordException(error as Error);
      span.setStatus({
        code: SpanStatusCode.ERROR,
        message: error instanceof Error ? error.message : 'Unknown worker error',
      });
      if (sentryDsn) {
        Sentry.captureException(error);
      }
      void observabilityExporter.report({
        source: 'worker',
        type: 'queue',
        queue: queueName,
        jobId: job.id ?? '',
        jobName: job.name,
        status: 'failed',
        durationMs: Date.now() - startedAt,
        attempts: job.attemptsMade ?? 0,
        error: error instanceof Error ? error.message : 'unknown_error',
        timestamp: new Date().toISOString(),
      });
      throw error;
    } finally {
      span.end();
    }
  };
}

function createWorker<Data extends WorkerJobData, Result = unknown>(
  name: string,
  processor: WorkerHandler<Data, Result>,
  jobOptions?: JobsOptions,
): Queue {
  const queue = createQueue(name, jobOptions);
  const worker = new BullWorker<Data, Result, string>(name, withTelemetry(name, processor), {
    connection,
    autorun: false,
  });
  workers.push(worker);
  return queue;
}

const voteQueue = createWorker<VoteDispatchJob>(
  'vote-dispatch',
  async (job) => {
    Logger.info({ jobId: job.id, data: job.data }, 'Processing vote dispatch job');
    try {
      const result = await dispatcher.dispatch(job.data);
      Logger.info(
        {
          serverId: job.data.serverId,
          voteId: job.data.voteId,
          dispatchAttemptId: result.dispatchAttemptId,
          protocol: result.protocol,
        },
        'Vote dispatch completed',
      );
      return result;
    } catch (error) {
      const retryable = dispatcher.isRetryable(error);
      Logger.error({ err: error, jobId: job.id, retryable }, 'Vote dispatch failed');
      if (!retryable) {
        throw error;
      }
      throw error;
    }
  },
  dispatcher.jobOptions(),
);

function truncateDispatchError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 512);
}

const serverPingQueue = createWorker<ServerPingJob>('server-ping', async (job) => {
  Logger.info({ jobId: job.id, data: job.data }, 'Processing server ping job');
  return pinger.ping(job.data);
});

const claimVerificationQueue = createWorker<ClaimVerificationJob>('claim-check', async (job) => {
  Logger.info({ jobId: job.id, data: job.data }, 'Processing claim verification job');
  return claimVerifier.verify(job.data);
});

const rankAggregationQueue = createWorker<RankAggregationJob>('rank-aggregation', async (job) => {
  Logger.info({ jobId: job.id, data: job.data }, 'Processing rank aggregation job');
  return rankAggregator.aggregate(job.data);
});

const discordDigestQueue = createWorker<DiscordDigestJob, DiscordDigestResult>(
  'discord-digest',
  async (job) => {
  Logger.info({ jobId: job.id, data: job.data }, 'Processing Discord digest job');
  const result = await discordDigestSender.send(job.data);
  await handleDigestOutcome(job.data, result);
  return result;
  },
);

createWorker<DiscordVerifySyncJob>('discord-verify-sync', async (job) => {
  Logger.info({ jobId: job.id, data: job.data }, 'Processing Discord verify sync job');
  return discordVerifySyncer.sync(job.data);
});

function scheduleInterval(name: string, intervalMs: number, task: () => Promise<void>) {
  let running = false;
  const run = async () => {
    if (running) {
      return;
    }
    running = true;
    try {
      await task();
    } catch (error) {
      Logger.error({ err: error }, `${name} scheduler failed`);
    } finally {
      running = false;
    }
  };
  void run();
  intervals.push(setInterval(run, intervalMs));
}

async function addJobSafely(
  queue: Queue,
  name: string,
  data: Record<string, unknown>,
  jobId?: string,
): Promise<void> {
  try {
    await queue.add(name, data, jobId ? { jobId } : undefined);
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (message.includes('already exists')) {
      return;
    }
    throw error;
  }
}

async function enqueueOrRunDirectly(
  queue: Queue,
  name: string,
  data: Record<string, unknown>,
  jobId: string | undefined,
  runDirectly: () => Promise<unknown>,
): Promise<void> {
  try {
    await addJobSafely(queue, name, data, jobId);
  } catch (error) {
    Logger.warn(
      { err: error, queue: queue.name, jobName: name, jobId },
      'Queue enqueue failed; running scheduled task directly',
    );
    await runDirectly();
  }
}

async function enqueueServerPings(): Promise<void> {
  const threshold = new Date(Date.now() - PING_INTERVAL_MS);
  const dueServers = await prisma.server.findMany({
    where: {
      OR: [
        { stats: { is: null } },
        { stats: { is: { lastPingAt: null } } },
        { stats: { is: { lastPingAt: { lt: threshold } } } },
      ],
    },
    select: { id: true, joinHost: true, joinPort: true, edition: true },
    take: MAX_PING_BATCH,
  });

  if (dueServers.length === 0) {
    return;
  }

  const bucket = Math.floor(Date.now() / PING_INTERVAL_MS);
  await Promise.all(
    dueServers.map((server) => {
      const data: ServerPingJob = {
        serverId: server.id,
        host: server.joinHost,
        port: server.joinPort,
        edition: server.edition,
      };
      return enqueueOrRunDirectly(
        serverPingQueue,
        'ping',
        data,
        `ping-${server.id}-${bucket}`,
        () => pinger.ping(data),
      );
    }),
  );
}

async function enqueueClaimChecks(): Promise<void> {
  const now = DateTime.utc();
  const pendingThreshold = now.minus({ hours: CLAIM_PENDING_THRESHOLD_HOURS }).toJSDate();
  const verifiedThreshold = now.minus({ hours: CLAIM_VERIFIED_THRESHOLD_HOURS }).toJSDate();

  const dueMethods = await prisma.serverClaimMethod.findMany({
    where: {
      method: {
        in: ['plugin', 'dns', 'motd'],
      },
      OR: [
        {
          status: 'pending',
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: pendingThreshold } }],
        },
        {
          status: 'verified',
          OR: [{ lastCheckedAt: null }, { lastCheckedAt: { lt: verifiedThreshold } }],
        },
      ],
    },
    take: MAX_CLAIM_BATCH,
  });

  if (dueMethods.length === 0) {
    return;
  }

  const bucket = Math.floor(Date.now() / CLAIM_SCAN_INTERVAL_MS);
  await Promise.all(
    dueMethods.map((method) => {
      const data: ClaimVerificationJob = {
        serverId: method.serverId,
        method: method.method,
        initiatedAt: now.toISO(),
      };
      return enqueueOrRunDirectly(
        claimVerificationQueue,
        'verify',
        data,
        `claim-${method.serverId}-${method.method}-${bucket}`,
        () => claimVerifier.verify(data),
      );
    }),
  );
}

async function enqueueRankAggregation(): Promise<void> {
  const now = DateTime.utc();
  const bucket = now.toFormat('yyyyLLddHH');
  const data: RankAggregationJob = {
    processedAt: now.toISO(),
  };
  await enqueueOrRunDirectly(rankAggregationQueue, 'aggregate', data, `rank-${bucket}`, () =>
    rankAggregator.aggregate(data),
  );
}

async function handleDigestOutcome(
  job: DiscordDigestJob,
  result: DiscordDigestResult,
): Promise<void> {
  if (result.delivered) {
    const reference = DateTime.fromISO(job.scheduledFor, { zone: 'utc' });
    const effectiveReference = reference.isValid ? reference : DateTime.utc();
    const nextDigestAt = computeNextDigest(job.timezone, effectiveReference.plus({ minutes: 1 }));
    await prisma.discordSubscription
      .update({
        where: { guildId: job.guildId },
        data: { nextDigestAt: nextDigestAt.toUTC().toJSDate() },
      })
      .catch((error) => {
        Logger.warn({ err: error, guildId: job.guildId }, 'Failed to update next digest time');
      });
    return;
  }

  if (result.status === 'missing_permissions' || result.status === 'channel_missing') {
    await prisma.discordSubscription.delete({ where: { guildId: job.guildId } }).catch((error) => {
      Logger.warn({ err: error, guildId: job.guildId }, 'Failed to remove subscription');
    });
    return;
  }

  if (result.status === 'rate_limited' && result.retryAt) {
    await prisma.discordSubscription
      .update({
        where: { guildId: job.guildId },
        data: { nextDigestAt: new Date(result.retryAt) },
      })
      .catch((error) => {
        Logger.warn({ err: error, guildId: job.guildId }, 'Failed to update retry schedule');
      });
  }
}

function computeNextDigest(timezone: string, reference: DateTime): DateTime {
  const zonedNow = reference.setZone(timezone, { keepLocalTime: false });
  if (!zonedNow.isValid) {
    return reference;
  }
  const startOfToday = zonedNow.startOf('day');
  return zonedNow <= startOfToday ? startOfToday : startOfToday.plus({ days: 1 });
}

let shuttingDown = false;

async function closeResources(): Promise<void> {
  intervals.forEach((interval) => clearInterval(interval));
  await Promise.allSettled(workers.map((worker) => worker.close()));
  await Promise.allSettled(queues.map((queue) => queue.close()));
  if (connection.status !== 'end') {
    await connection.quit().catch(() => connection.disconnect());
  }
  await prisma.$disconnect().catch(() => undefined);
}

async function shutdown(signal: string) {
  if (shuttingDown) {
    return;
  }
  shuttingDown = true;
  Logger.warn({ signal }, 'Received shutdown signal, closing workers');
  await closeResources();
  Logger.info('Workers shut down gracefully');
  process.exit(0);
}

process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

async function bootstrapWorker(): Promise<void> {
  await prisma.$connect();
  await connection.ping();
  assertSupportedQueueServer(await connection.info('server'));

  for (const worker of workers) {
    void worker.run().catch((error) => {
      Logger.error({ err: error, worker: worker.name }, 'Worker run loop stopped unexpectedly');
    });
  }

  scheduleInterval('server-ping', PING_INTERVAL_MS, enqueueServerPings);
  scheduleInterval('claim-check', CLAIM_SCAN_INTERVAL_MS, enqueueClaimChecks);
  scheduleInterval('rank-aggregation', RANK_INTERVAL_MS, enqueueRankAggregation);
  Logger.info({ redisUrl, workerCount: workers.length }, 'Worker bootstrapped and waiting for jobs');
}

void bootstrapWorker().catch(async (error) => {
  Logger.error({ err: error }, 'Worker bootstrap failed');
  shuttingDown = true;
  await closeResources();
  process.exit(1);
});

export {
  voteQueue,
  serverPingQueue,
  claimVerificationQueue,
  rankAggregationQueue,
  discordDigestQueue,
};
