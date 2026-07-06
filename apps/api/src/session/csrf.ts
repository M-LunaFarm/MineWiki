import { ForbiddenException } from '@nestjs/common';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyRequest } from 'fastify';

const CSRF_HEADER = 'x-csrf-token';
const CSRF_LABEL = 'minewiki:csrf:v1';
const UNSAFE_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);

export function issueCsrfToken(sessionToken: string): string {
  return createHmac('sha256', sessionToken).update(CSRF_LABEL).digest('base64url');
}

export function assertCsrfToken(request: FastifyRequest, sessionToken: string): void {
  if (!UNSAFE_METHODS.has(request.method.toUpperCase())) {
    return;
  }
  if (request.headers.authorization) {
    return;
  }
  const fetchSite = request.headers['sec-fetch-site'];
  if (fetchSite === 'same-origin' || fetchSite === 'same-site') {
    return;
  }
  const supplied = headerValue(request.headers[CSRF_HEADER]);
  if (!supplied || !safeEquals(supplied, issueCsrfToken(sessionToken))) {
    throw new ForbiddenException({
      code: 'CSRF_REQUIRED',
      message: 'CSRF token is required for this request.'
    });
  }
}

function headerValue(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function safeEquals(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}
