import { test } from 'node:test';
import assert from 'node:assert/strict';
import 'reflect-metadata';
import { PATH_METADATA } from '@nestjs/common/constants';
import { PluginSyncController } from './plugin-sync.controller';

test('plugin sync controller keeps canonical and legacy compatibility routes', async () => {
  const calls: unknown[] = [];
  const response = { server_id: 'server-1', guild_id: 'guild-1', entries: [] };
  const controller = new PluginSyncController({
    sync: async (body: unknown) => {
      calls.push(body);
      return response;
    }
  } as never);

  assert.deepEqual(Reflect.getMetadata(PATH_METADATA, PluginSyncController.prototype.sync), [
    'v1/plugin/sync',
    'api/v1/plugin/sync-9b4f7d2c6a5e4f3aa1d8b9a7c6e5d4f3',
    'api/v1/plugin/sync'
  ]);

  const body = {
    timestamp: '1',
    nonce: 'nonce',
    signature: 'a'.repeat(64),
    payload: { server_id: 'server-1' }
  };
  assert.equal(await controller.sync(body), response);
  assert.deepEqual(calls, [body]);
});

test('plugin sync controller rejects oversized unauthenticated payloads before service work', async () => {
  let calls = 0;
  const controller = new PluginSyncController({
    sync: async () => {
      calls += 1;
      return {};
    }
  } as never);

  assert.throws(
    () => controller.sync({
      timestamp: '1',
      nonce: 'nonce',
      signature: 'a'.repeat(64),
      payload: { server_id: 'server-1', padding: 'x'.repeat(17 * 1024) }
    }),
    /payload_too_large/
  );
  assert.equal(calls, 0);
});
