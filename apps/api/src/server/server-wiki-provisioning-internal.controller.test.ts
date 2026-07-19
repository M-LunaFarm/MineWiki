import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deriveServerWikiProvisioningServiceToken } from '@minewiki/auth';
import { ServerWikiProvisioningInternalController } from './server-wiki-provisioning-internal.controller';

test('internal claim provisioning requires a derived service token', async () => {
  let provisioned = '';
  const key = 'server-wiki-provisioning-test-key';
  const controller = new ServerWikiProvisioningInternalController(
    {
      ensureClaimedServerWiki: async (serverId: string) => {
        provisioned = serverId;
        return { wikiSlug: 'claimed-wiki' };
      },
    } as never,
    { get: () => key } as never,
  );

  await assert.rejects(
    Promise.resolve().then(() => controller.provision(
      '11111111-1111-4111-8111-111111111111',
      'Bearer invalid',
    )),
    /token is invalid/u,
  );
  assert.equal(provisioned, '');

  const result = await controller.provision(
    '11111111-1111-4111-8111-111111111111',
    `Bearer ${deriveServerWikiProvisioningServiceToken(key)}`,
  );
  assert.equal(provisioned, '11111111-1111-4111-8111-111111111111');
  assert.deepEqual(result, { wikiSlug: 'claimed-wiki' });
});
