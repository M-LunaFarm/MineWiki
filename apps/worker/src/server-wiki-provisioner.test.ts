import assert from 'node:assert/strict';
import { test } from 'node:test';
import { provisionClaimedServerWiki } from './server-wiki-provisioner';

test('claim wiki provisioner calls only the protected internal endpoint', async () => {
  let request: { url: string; authorization?: string; method?: string } | null = null;
  await provisionClaimedServerWiki({
    apiBaseUrl: 'http://api:3000/',
    internalToken: 'derived-token',
    serverId: '11111111-1111-4111-8111-111111111111',
    fetchImpl: async (input, init) => {
      request = {
        url: String(input),
        authorization: new Headers(init?.headers).get('authorization') ?? undefined,
        method: init?.method,
      };
      return new Response('{}', { status: 200 });
    },
  });

  assert.deepEqual(request, {
    url: 'http://api:3000/v1/internal/server-wikis/11111111-1111-4111-8111-111111111111/provision',
    authorization: 'Bearer derived-token',
    method: 'POST',
  });
});

test('claim wiki provisioner fails the BullMQ job when the API does not accept provisioning', async () => {
  await assert.rejects(
    provisionClaimedServerWiki({
      apiBaseUrl: 'http://api:3000',
      internalToken: 'derived-token',
      serverId: '11111111-1111-4111-8111-111111111111',
      fetchImpl: async () => new Response('{}', { status: 503 }),
    }),
    /status 503/u,
  );
});
