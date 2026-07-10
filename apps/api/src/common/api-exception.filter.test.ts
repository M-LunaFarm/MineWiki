import { test } from 'node:test';
import assert from 'node:assert/strict';
import { BadRequestException, ForbiddenException } from '@nestjs/common';
import { ApiExceptionFilter } from './api-exception.filter';

test('api exception filter normalizes regular api errors', () => {
  const { host, reply } = createHost('/v1/wiki/pages');
  new ApiExceptionFilter().catch(new BadRequestException('Invalid page'), host);

  assert.equal(reply.statusCode, 400);
  assert.equal(reply.body.statusCode, 400);
  assert.equal(reply.body.code, 'bad_request');
  assert.equal(reply.body.message, 'Invalid page');
  assert.equal(reply.body.requestId, 'request-1');
});

test('api exception filter preserves plugin sync legacy error body', () => {
  const { host, reply } = createHost('/v1/plugin/sync');
  new ApiExceptionFilter().catch(new ForbiddenException({ error: 'bad_signature' }), host);

  assert.equal(reply.statusCode, 403);
  assert.deepEqual(reply.body, { error: 'bad_signature' });
});

function createHost(path: string) {
  const reply = {
    statusCode: 0,
    body: {} as Record<string, unknown>,
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    send(body: Record<string, unknown>) {
      this.body = body;
      return this;
    },
  };
  const host = {
    switchToHttp() {
      return {
        getRequest() {
          return { url: path, requestId: 'request-1', id: 'fastify-1' };
        },
        getResponse() {
          return reply;
        },
      };
    },
  };
  return { host: host as never, reply };
}
