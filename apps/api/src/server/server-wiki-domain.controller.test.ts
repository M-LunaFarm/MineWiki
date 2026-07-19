import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NotFoundException } from '@nestjs/common';
import { STEP_UP_PURPOSE_METADATA } from '../session/step-up.guard';
import { ServerWikiDomainController } from './server-wiki-domain.controller';

const SERVER_ID = '11111111-1111-4111-8111-111111111111';

test('domain mutations require server-admin step-up and exact owner authority', async () => {
  for (const method of ['configure', 'verify', 'disable'] as const) {
    assert.equal(
      Reflect.getMetadata(STEP_UP_PURPOSE_METADATA, ServerWikiDomainController.prototype[method]),
      'server_admin',
    );
  }
  let called = false;
  const controller = new ServerWikiDomainController(
    { async get() { called = true; return null; } } as never,
    { async isOwner() { return false; } } as never,
  );
  await assert.rejects(
    controller.get(SERVER_ID, { userId: 'unrelated', permissions: [] } as never),
    NotFoundException,
  );
  assert.equal(called, false);
});

test('domain controller forwards validated optimistic versions without exposing authority fields', async () => {
  let received: unknown = null;
  const controller = new ServerWikiDomainController(
    { async configure(...args: unknown[]) { received = args; return { version: 1 }; } } as never,
    { async isOwner() { return true; } } as never,
  );
  const result = await controller.configure(
    SERVER_ID,
    { hostname: ' Docs.Example.com ', expectedVersion: 0 },
    { userId: 'owner', permissions: [] } as never,
  );
  assert.deepEqual(received, [SERVER_ID, 'Docs.Example.com', 0, 'owner']);
  assert.deepEqual(result, { domain: { version: 1 } });
});
