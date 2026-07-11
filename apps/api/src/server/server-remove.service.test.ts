import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ServerService } from './server.service';

test('server removal disables plugin credentials in the delete transaction', async () => {
  const operations: string[] = [];
  const audits: Array<{ action: string; input: any }> = [];
  const prisma = {
    server: {
      async findUnique() {
        return { id: 'server-1' };
      },
      delete() {
        operations.push('delete-server');
        return Promise.resolve({ id: 'server-1' });
      },
    },
    pluginServer: {
      updateMany(input: unknown) {
        operations.push('disable-credentials');
        assert.deepEqual(input, {
          where: { serverId: 'server-1', enabled: true },
          data: { enabled: false },
        });
        return Promise.resolve({ count: 2 });
      },
    },
    async $transaction(promises: Promise<unknown>[]) {
      operations.push('transaction');
      return Promise.all(promises);
    },
  };
  const service = new ServerService(
    {} as never,
    prisma as never,
    {} as never,
    undefined,
    {
      async audit(action: string, input: unknown) {
        audits.push({ action, input });
      },
    } as never,
  );

  await service.remove('server-1', 'owner-account');

  assert.deepEqual(operations, ['disable-credentials', 'delete-server', 'transaction']);
  assert.equal(audits[0]?.action, 'server.deleted');
  assert.deepEqual(audits[0]?.input.metadata, { disabledPluginCredentials: 2 });
  assert.equal(audits[0]?.input.actorAccountId, 'owner-account');
});
