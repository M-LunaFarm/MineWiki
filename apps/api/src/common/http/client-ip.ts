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

function pickForwardedIp(header: string | string[] | undefined): string | undefined {
  if (!header) {
    return undefined;
  }

  const values = Array.isArray(header) ? header.join(',') : header;
  for (const candidate of values.split(',')) {
    const normalized = normalizeIp(candidate);
    if (normalized) {
      return normalized;
    }
  }

  return undefined;
}

export function extractClientIp(request: FastifyRequest): string | undefined {
  return (
    pickForwardedIp(request.headers['x-forwarded-for']) ??
    normalizeIp(
      Array.isArray(request.headers['x-real-ip'])
        ? request.headers['x-real-ip'][0]
        : request.headers['x-real-ip'],
    ) ??
    normalizeIp(request.ip)
  );
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
