import { Logger } from '@minewiki/logger';
import type { JobsOptions } from 'bullmq';
import type { VotifierTarget } from '@minewiki/schemas';
import { connect } from 'node:net';
import { once } from 'node:events';
import { publicEncrypt, constants } from 'node:crypto';
import { TextEncoder } from 'node:util';
import { validateOutboundTarget } from '@minewiki/security';

const RETRYABLE_ERRORS = ['ECONNRESET', 'ETIMEDOUT', 'EHOSTUNREACH', 'ECONNREFUSED'];
const V2_TIMEOUT_MS = 2000;
const V1_TIMEOUT_MS = 2000;

interface DispatchResult {
  readonly success: boolean;
  readonly protocol: 'v2' | 'v1';
  readonly dispatchAttemptId: string;
}

export interface VoteDispatchExecutionTarget extends VotifierTarget {
  readonly targetId: string;
  readonly dispatchAttemptId: string;
  readonly host: string;
  readonly port: number;
}

export interface VoteDispatchExecutionJob {
  readonly voteId: string;
  readonly serverId: string;
  readonly username: string;
  readonly ipAddress?: string;
  readonly votedAt: string;
  readonly targets: VoteDispatchExecutionTarget[];
}

export interface VoteDispatchRecorder {
  markStarted(dispatchAttemptId: string): Promise<boolean>;
  markSucceeded(dispatchAttemptId: string): Promise<void>;
  markFailed(dispatchAttemptId: string, error: unknown): Promise<void>;
}

type ResolveDispatchTarget = (
  target: VoteDispatchExecutionTarget,
) => Promise<{ readonly host: string; readonly port: number }>;

export function createVoteDispatcher(options: {
  recorder?: VoteDispatchRecorder;
  resolveTarget?: ResolveDispatchTarget;
} = {}) {
  const resolveTarget = options.resolveTarget ?? resolvePublicDispatchTarget;

  async function dispatch(job: VoteDispatchExecutionJob): Promise<DispatchResult> {
    let lastError: unknown;
    for (const target of job.targets) {
      const claimed = (await options.recorder?.markStarted(target.dispatchAttemptId)) ?? true;
      if (!claimed) {
        continue;
      }
      try {
        if (target.protocol === 'v2') {
          await sendV2(job, target, await resolveTarget(target));
          await options.recorder?.markSucceeded(target.dispatchAttemptId);
          return { success: true, protocol: 'v2', dispatchAttemptId: target.dispatchAttemptId };
        }
        await sendV1(job, target, await resolveTarget(target));
        await options.recorder?.markSucceeded(target.dispatchAttemptId);
        return { success: true, protocol: 'v1', dispatchAttemptId: target.dispatchAttemptId };
      } catch (error) {
        lastError = error;
        await options.recorder?.markFailed(target.dispatchAttemptId, error);
        Logger.warn(
          {
            err: error,
            serverId: job.serverId,
            voteId: job.voteId,
            dispatchAttemptId: target.dispatchAttemptId,
            protocol: target.protocol,
            host: target.host,
            port: target.port
          },
          'Votifier dispatch attempt failed, trying next target'
        );
      }
    }
    throw lastError ?? new Error('No queued Votifier dispatch attempt was acquired.');
  }

  function jobOptions(): JobsOptions {
    return {
      attempts: 1
    };
  }

  function isRetryable(error: unknown): boolean {
    if (typeof error === 'object' && error && 'code' in error) {
      return RETRYABLE_ERRORS.includes(String((error as { code?: string }).code));
    }
    return false;
  }

  return {
    dispatch,
    jobOptions,
    isRetryable
  };
}

async function resolvePublicDispatchTarget(
  target: VoteDispatchExecutionTarget,
): Promise<{ readonly host: string; readonly port: number }> {
  const validated = await validateOutboundTarget(target.host, target.port, {
    label: 'Votifier dispatch target',
  });
  const address = validated.addresses[0];
  if (!address) {
    throw new Error('Votifier dispatch target did not resolve to a public address.');
  }
  return { host: address.address, port: validated.port };
}

async function sendV2(
  job: VoteDispatchExecutionJob,
  target: VoteDispatchExecutionTarget,
  destination: { readonly host: string; readonly port: number },
): Promise<void> {
  if (!target.token) {
    throw new Error('V2 target is missing token');
  }
  const socket = connect(destination);
  socket.setTimeout(V2_TIMEOUT_MS);
  const payload = JSON.stringify({
    method: 'token',
    token: target.token,
    username: job.username,
    address: job.ipAddress ?? '0.0.0.0',
    timestamp: job.votedAt
  });
  socket.once('connect', () => {
    socket.write(payload + '\n');
    socket.end();
  });
  socket.once('timeout', () => {
    socket.destroy(new Error('V2 dispatch timeout'));
  });
  const [error] = await Promise.race([
    once(socket, 'close').then(() => [null]),
    once(socket, 'error').then((args) => [args[0] as Error])
  ]);
  if (error) {
    throw error;
  }
}

async function sendV1(
  job: VoteDispatchExecutionJob,
  target: VoteDispatchExecutionTarget,
  destination: { readonly host: string; readonly port: number },
): Promise<void> {
  if (!target.publicKey) {
    throw new Error('V1 target is missing publicKey');
  }
  const socket = connect(destination);
  socket.setTimeout(V1_TIMEOUT_MS);
  const handshakePromise = new Promise<void>((resolve, reject) => {
    const onData = (chunk: Buffer) => {
      const text = chunk.toString('utf8');
      if (!text.startsWith('VOTIFIER')) {
        reject(new Error('Unexpected Votifier handshake response'));
        return;
      }
      socket.off('data', onData);
      resolve();
    };
    socket.on('data', onData);
    socket.once('error', reject);
  });
  socket.once('timeout', () => {
    socket.destroy(new Error('V1 dispatch timeout'));
  });
  const connectPromise = once(socket, 'connect');
  await connectPromise;
  await handshakePromise;

  const payload = buildV1Payload(job, target);
  socket.write(payload);
  socket.end();

  const [error] = await Promise.race([
    once(socket, 'close').then(() => [null]),
    once(socket, 'error').then((args) => [args[0] as Error])
  ]);

  if (error) {
    throw error;
  }
}

function buildV1Payload(job: VoteDispatchExecutionJob, target: VoteDispatchExecutionTarget): Buffer {
  const timestamp = Math.floor(Date.parse(job.votedAt) / 1000);
  const lines = [
    'VOTE',
    'MineWiki Servers',
    job.username,
    job.ipAddress ?? '0.0.0.0',
    String(timestamp)
  ];
  const message = lines.join('\n') + '\n';
  const encoder = new TextEncoder();
  const messageBytes = encoder.encode(message);
  return publicEncrypt(
    {
      key: target.publicKey as string,
      padding: constants.RSA_PKCS1_OAEP_PADDING
    },
    messageBytes
  );
}
