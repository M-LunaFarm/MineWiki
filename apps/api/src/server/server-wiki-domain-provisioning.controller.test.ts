import assert from 'node:assert/strict';
import { test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
import {
  deriveServerWikiDomainProvisionerToken,
  ServerWikiDomainProvisioningController,
} from './server-wiki-domain-provisioning.controller';

test('domain provisioning controller requires a derived constant-time bearer token', async () => {
  const key = 'test-app-encryption-key-with-enough-entropy';
  let activated: unknown = null;
  const controller = new ServerWikiDomainProvisioningController(
    { async activateProvisioned(...args: unknown[]) { activated = args; return { status: 'active' }; } } as never,
    { get() { return key; } } as never,
  );
  await assert.rejects(controller.activate('Bearer wrong', 'docs.example.com', 2), UnauthorizedException);
  const result = await controller.activate(
    `Bearer ${deriveServerWikiDomainProvisionerToken(key)}`,
    'docs.example.com',
    2,
  );
  assert.deepEqual(activated, ['docs.example.com', 2]);
  assert.deepEqual(result, { domain: { status: 'active' } });
});
