import assert from 'node:assert/strict';
import test from 'node:test';
import { GUARDS_METADATA, HEADERS_METADATA } from '@nestjs/common/constants';
import type { FastifyRequest } from 'fastify';
import { OptionalSessionGuard } from '../session/optional-session.guard';
import { WikiPageAclController } from './wiki-page-acl.controller';
import type { WikiPageAclService } from './wiki-page-acl.service';

test('page ACL read forwards the verified client address and stays private', async () => {
  let received: unknown;
  const controller = new WikiPageAclController({
    async getPageAcl(...args: unknown[]) {
      received = args;
      return { rules: [] };
    }
  } as unknown as WikiPageAclService);
  const request = {
    clientIp: '192.0.2.40',
    sessionPayload: { userId: 'account-1', requestIp: '198.51.100.8' }
  } as unknown as FastifyRequest;

  await controller.getPageAcl('7', request);

  assert.deepEqual(received, ['7', request.sessionPayload, '192.0.2.40']);
  const headers = new Map((Reflect.getMetadata(HEADERS_METADATA, controller.getPageAcl) ?? [])
    .map((header: { name: string; value: string }) => [header.name, header.value]));
  assert.equal(headers.get('Cache-Control'), 'private, no-store');
  assert.equal(headers.get('Vary'), 'Cookie, Authorization');
  const guards = Reflect.getMetadata(GUARDS_METADATA, controller.getPageAcl) ?? [];
  assert.ok(guards.includes(OptionalSessionGuard));
});
