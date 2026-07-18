import assert from 'node:assert/strict';
import test from 'node:test';
import { getCurrentHttpRequestContext, getCurrentRequestIp, runInHttpRequestContext, runWithHttpRequestContext } from './request-context';
import type { FastifyReply, FastifyRequest } from 'fastify';

test('HTTP request context isolates concurrent client addresses', async () => {
  const gate = Promise.withResolvers<void>();
  const first = runWithHttpRequestContext('192.0.2.10', async () => {
    await gate.promise;
    return getCurrentRequestIp();
  });
  const second = runWithHttpRequestContext('2001:db8::10', async () => {
    gate.resolve();
    await Promise.resolve();
    return getCurrentRequestIp();
  });

  assert.deepEqual(await Promise.all([first, second]), ['192.0.2.10', '2001:db8::10']);
  assert.equal(getCurrentRequestIp(), null);
});

test('HTTP request context captures correlation id and user agent after the request-id hook', () => {
  const request = {
    id: 'fastify-id', requestId: 'request-id', headers: { 'user-agent': 'MineWiki-Test/1.0' },
  } as FastifyRequest;
  runInHttpRequestContext(request, {} as FastifyReply, () => {
    assert.deepEqual(getCurrentHttpRequestContext(), {
      requestIp: null, requestId: 'request-id', userAgent: 'MineWiki-Test/1.0',
    });
  });
});
