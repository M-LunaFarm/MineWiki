import assert from 'node:assert/strict';
import test from 'node:test';
import type { FastifyRequest } from 'fastify';
import { extractClientIp } from './client-ip';

test('client identity uses Fastify trusted-proxy resolution and ignores raw forwarding headers', () => {
  const request = {
    ip: '198.51.100.7',
    headers: {
      'x-forwarded-for': '203.0.113.99',
      'x-real-ip': '203.0.113.100',
    },
  } as unknown as FastifyRequest;
  assert.equal(extractClientIp(request), '198.51.100.7');
});
