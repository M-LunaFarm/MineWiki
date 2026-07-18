import { AsyncLocalStorage } from 'node:async_hooks';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { extractClientIp } from './client-ip';

export interface HttpRequestContext {
  readonly requestIp: string | null;
  readonly requestId: string | null;
  readonly userAgent: string | null;
}

const storage = new AsyncLocalStorage<HttpRequestContext>();

declare module 'fastify' {
  interface FastifyRequest {
    /** Trusted client address populated once by the global onRequest hook. */
    clientIp?: string | null;
    /** Correlation identifier populated by the global onRequest hook. */
    requestId?: string;
  }
}

export function runInHttpRequestContext(
  request: FastifyRequest,
  _reply: FastifyReply,
  done: () => void
): void {
  const requestIp = extractClientIp(request) ?? null;
  request.clientIp = requestIp;
  const requestId = (request.requestId ?? request.id)?.slice(0, 64) || null;
  const header = request.headers['user-agent'];
  const userAgent = (Array.isArray(header) ? header[0] : header)?.slice(0, 512) ?? null;
  storage.run({ requestIp, requestId, userAgent }, done);
}

export function getCurrentRequestIp(): string | null {
  return storage.getStore()?.requestIp ?? null;
}

export function getCurrentHttpRequestContext(): HttpRequestContext {
  return storage.getStore() ?? { requestIp: null, requestId: null, userAgent: null };
}

export function runWithHttpRequestContext<T>(
  requestIp: string | null,
  callback: () => T
): T {
  return storage.run({ requestIp, requestId: null, userAgent: null }, callback);
}

export function runWithFullHttpRequestContext<T>(context: HttpRequestContext, callback: () => T): T {
  return storage.run(context, callback);
}
