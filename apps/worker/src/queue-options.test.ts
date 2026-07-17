import assert from 'node:assert/strict';
import test from 'node:test';
import { RETRYABLE_SCHEDULED_JOB_OPTIONS } from './queue-options';
import { createVoteDispatcher } from './processors/vote-dispatcher';

test('idempotent scheduled jobs use bounded exponential retries', () => {
  assert.equal(RETRYABLE_SCHEDULED_JOB_OPTIONS.attempts, 3);
  assert.deepEqual(RETRYABLE_SCHEDULED_JOB_OPTIONS.backoff, {
    type: 'exponential',
    delay: 5_000,
  });
});

test('vote dispatch keeps its explicit single-attempt safety boundary', () => {
  assert.equal(createVoteDispatcher().jobOptions().attempts, 1);
});
