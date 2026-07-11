import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServerPinger } from './server-pinger';

test('server ping jobs hydrate the current target from the database', async () => {
  const serverId = '11111111-1111-4111-8111-111111111111';
  let loadedServerId: string | undefined;
  const tx = {
    serverPingSample: {
      create: async () => ({}),
      count: async () => 0,
      deleteMany: async () => ({ count: 0 }),
    },
    server: { update: async () => ({}) },
    serverStats: { upsert: async () => ({}) },
  };
  const prisma = {
    server: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        loadedServerId = where.id;
        return { joinHost: '127.0.0.1', joinPort: 25565, edition: 'java' };
      },
    },
    $transaction: async (callback: (transaction: typeof tx) => Promise<unknown>) => callback(tx),
  };
  const pinger = createServerPinger(prisma as never);

  const result = await pinger.ping({ serverId });

  assert.equal(loadedServerId, serverId);
  assert.equal(result.online, false);
  assert.equal(JSON.stringify({ serverId }).includes('127.0.0.1'), false);
});
