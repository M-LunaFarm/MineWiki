import { test } from 'node:test';
import assert from 'node:assert/strict';
import { decryptAppSecret } from '../common/secret-codec';
import { PluginCredentialService } from './plugin-credential.service';

const baseRow = {
  id: 'credential-1',
  serverId: 'server-1',
  guildId: '1234567890',
  pluginServerId: 'plugin-server-1',
  serverName: 'Test Server',
  host: 'play.example.com',
  port: 25565,
  endpointUrl: null,
  enabled: true,
  lastSeenAt: null,
  createdAt: new Date('2026-01-01T00:00:00.000Z'),
  updatedAt: new Date('2026-01-01T00:00:00.000Z'),
};

test('plugin credential creation encrypts the stored secret and reveals it once', async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = 'plugin-credential-test-key';
  let storedSecret = '';
  const audits: string[] = [];
  const prisma = {
    server: {
      async findUnique() {
        return { id: 'server-1', name: 'Test Server', joinHost: 'play.example.com', joinPort: 25565 };
      },
    },
    pluginServer: {
      async create(input: { data: { serverSecret: string; pluginServerId: string } }) {
        storedSecret = input.data.serverSecret;
        return { ...baseRow, pluginServerId: input.data.pluginServerId, serverSecret: storedSecret };
      },
    },
  };
  const service = new PluginCredentialService(
    prisma as never,
    { async audit(action: string) { audits.push(action); } } as never,
  );

  try {
    const issued = await service.create(
      'server-1',
      { guildId: '1234567890' },
      'owner-account',
    );
    assert.ok(issued.secret.length >= 40);
    assert.notEqual(storedSecret, issued.secret);
    assert.match(storedSecret, /^enc:v1:/);
    assert.equal(decryptAppSecret(storedSecret), issued.secret);
    assert.equal(audits[0], 'plugin.credential.created');
  } finally {
    restoreEnvironment('APP_ENCRYPTION_KEY', previousKey);
  }
});

test('plugin credential list never includes stored secrets', async () => {
  const service = new PluginCredentialService({
    pluginServer: {
      async findMany() {
        return [{ ...baseRow, serverSecret: 'must-not-leak' }];
      },
    },
  } as never);

  const rows = await service.list('server-1');

  assert.equal(rows.length, 1);
  assert.equal('secret' in (rows[0] ?? {}), false);
  assert.equal('serverSecret' in (rows[0] ?? {}), false);
});

test('plugin credential rotation replaces the stored secret', async () => {
  const previousKey = process.env.APP_ENCRYPTION_KEY;
  process.env.APP_ENCRYPTION_KEY = 'plugin-credential-rotation-key';
  let replacement = '';
  const prisma = {
    pluginServer: {
      async findFirst() {
        return { ...baseRow, serverSecret: 'old-secret' };
      },
      async update(input: { data: { serverSecret: string } }) {
        replacement = input.data.serverSecret;
        return { ...baseRow, serverSecret: replacement, updatedAt: new Date() };
      },
    },
  };
  const service = new PluginCredentialService(prisma as never);

  try {
    const issued = await service.rotate('server-1', 'credential-1', 'owner-account');
    assert.notEqual(replacement, 'old-secret');
    assert.equal(decryptAppSecret(replacement), issued.secret);
  } finally {
    restoreEnvironment('APP_ENCRYPTION_KEY', previousKey);
  }
});

function restoreEnvironment(key: string, value: string | undefined): void {
  if (value === undefined) {
    delete process.env[key];
  } else {
    process.env[key] = value;
  }
}
