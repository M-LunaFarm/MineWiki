import test from 'node:test';
import assert from 'node:assert/strict';
import { ForbiddenException } from '@nestjs/common';
import type { FastifyRequest } from 'fastify';
import { assertCsrfToken, issueCsrfToken } from './csrf';

test('csrf token validates for unsafe cookie-auth requests', () => {
  const sessionToken = 'session-token';
  const request = requestWith({
    method: 'POST',
    headers: {
      'x-csrf-token': issueCsrfToken(sessionToken)
    }
  });

  assert.doesNotThrow(() => assertCsrfToken(request, sessionToken));
});

test('csrf rejects unsafe request without token', () => {
  const request = requestWith({ method: 'PATCH', headers: {} });

  assert.throws(() => assertCsrfToken(request, 'session-token'), ForbiddenException);
});

test('csrf allows safe methods, same-origin browser requests, and bearer requests', () => {
  assert.doesNotThrow(() => assertCsrfToken(requestWith({ method: 'GET', headers: {} }), 'session-token'));
  assert.doesNotThrow(() =>
    assertCsrfToken(requestWith({ method: 'POST', headers: { 'sec-fetch-site': 'same-origin' } }), 'session-token')
  );
  assert.doesNotThrow(() =>
    assertCsrfToken(requestWith({ method: 'DELETE', headers: { authorization: 'Bearer internal' } }), 'session-token')
  );
});

function requestWith(input: {
  readonly method: string;
  readonly headers: Record<string, string>;
}): FastifyRequest {
  return {
    method: input.method,
    headers: input.headers
  } as unknown as FastifyRequest;
}
