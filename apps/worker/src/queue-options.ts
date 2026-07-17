import type { JobsOptions } from 'bullmq';

export const RETRYABLE_SCHEDULED_JOB_OPTIONS = {
  attempts: 3,
  backoff: { type: 'exponential', delay: 5_000 },
} satisfies JobsOptions;
