import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { decryptAppSecret } from '../common/secret-codec';
import { PrismaService } from '../common/prisma.service';
import { PluginServerRepository } from '../verify/guild.repositories';
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

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('plugin credential database integration', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  test('issued credentials work through canonical plugin repository and rotation', async () => {
    const unique = randomUUID().replace(/-/g, '').slice(0, 12);
    const server = await prisma.server.create({
      data: {
        name: `Plugin Test ${unique}`,
        joinHost: `plugin-${unique}.example.com`,
        joinPort: 25565,
        edition: 'java',
        supportedVersions: ['1.21'],
        tags: ['integration'],
        shortDescription: 'Plugin credential integration test',
        longDescription: 'Plugin credential integration test server',
      },
    });
    const service = new PluginCredentialService(prisma);
    const repository = new PluginServerRepository(prisma);

    try {
      const issued = await service.create(
        server.id,
        { guildId: `9${unique.replace(/\D/g, '').padEnd(17, '1').slice(0, 17)}` },
        'integration-actor',
      );
      const resolved = await repository.find(issued.pluginServerId);
      assert.equal(resolved?.source, 'canonical');
      assert.equal(resolved?.serverSecret, issued.secret);

      const rotated = await service.rotate(server.id, issued.id, 'integration-actor');
      assert.notEqual(rotated.secret, issued.secret);
      const resolvedAfterRotation = await repository.find(issued.pluginServerId);
      assert.equal(resolvedAfterRotation?.serverSecret, rotated.secret);

      await service.setEnabled(server.id, issued.id, false, 'integration-actor');
      const disabled = await repository.find(issued.pluginServerId);
      assert.equal(disabled?.enabled, false);
    } finally {
      await prisma.pluginServer.deleteMany({ where: { serverId: server.id } });
      await prisma.server.delete({ where: { id: server.id } });
    }
  });
}
