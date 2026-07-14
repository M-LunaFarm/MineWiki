import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { extractClientIp } from './client-ip';

interface HttpRequestContext {
  readonly requestIp: string | null;
}

const storage = new AsyncLocalStorage<HttpRequestContext>();

declare module 'fastify' {
  interface FastifyRequest {
    /** Trusted client address populated once by the global onRequest hook. */
    clientIp?: string | null;
  }
}

export function runInHttpRequestContext(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: () => void
): void {
  const requestIp = extractClientIp(request) ?? null;
  request.clientIp = requestIp;
  storage.run({ requestIp }, done);
}

export function getCurrentRequestIp(): string | null {
  return storage.getStore()?.requestIp ?? null;
}

export function runWithHttpRequestContext<T>(
  requestIp: string | null,
  callback: () => T
): T {
  return storage.run({ requestIp }, callback);
}
