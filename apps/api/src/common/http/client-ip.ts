import type { FastifyRequest } from 'fastify';

function normalizeIp(value: string | undefined): string | undefined {
  if (!value) {
    return undefined;
  }

  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unknown') {
    return undefined;
  }

  if (trimmed.startsWith('[')) {
    const closing = trimmed.indexOf(']');
    if (closing > 1) {
      return trimmed.slice(1, closing);
    }
  }

  if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(trimmed)) {
    return trimmed.split(':')[0];
  }

  return trimmed;
}

export function extractClientIp(request: FastifyRequest): string | undefined {
  // Fastify resolves trusted forwarding headers into request.ip. Reading raw
  // headers here would let an untrusted direct client choose its abuse identity.
  return normalizeIp(request.ip);
}

export function isLoopbackIp(ipAddress: string | null | undefined): boolean {
  const normalized = ipAddress?.trim().toLowerCase();
  if (!normalized) {
    return false;
  }
  return (
    normalized === '::1' ||
    normalized === '::ffff:127.0.0.1' ||
    normalized.startsWith('127.')
  );
}
