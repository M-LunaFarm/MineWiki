import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignatureBody,
  hmacSha256Hex,
  PluginSyncService,
  type PluginSyncRequest
} from './plugin-sync.service';

function createService(options: { enabled?: boolean; serverId?: string } = {}) {
  const serverId = options.serverId ?? `server-${Math.random().toString(36).slice(2)}`;
  const secret = 'secret';
  const updated: unknown[] = [];
  const prisma = {
    lunaGuildServer: {
      findUnique: async () => ({
        serverId,
        guildId: 'guild-1',
        serverSecret: secret,
        enabled: options.enabled ?? true
      }),
      update: async (args: unknown) => {
        updated.push(args);
      }
    },
    lunaGuildVerification: {
      findMany: async () => [
        {
          minecraftUuid: '00000000-0000-4000-8000-000000000001',
          discordUserId: 'discord-1',
          verifiedAt: new Date('2026-01-01T00:00:00.000Z')
        }
      ]
    },
    lunaDiscordAccountLink: {
      findMany: async () => [
        {
          minecraftUuid: '00000000-0000-4000-8000-000000000001',
          minecraftName: 'PlayerOne'
        }
      ]
    }
  };
  return { service: new PluginSyncService(prisma as never), serverId, secret, updated };
}

function signedRequest(serverId: string, secret: string): PluginSyncRequest {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = 'nonce-1';
  const payload = { server_id: serverId };
  const signature = hmacSha256Hex(secret, buildSignatureBody(timestamp, nonce, payload));
  return { timestamp, nonce, payload, signature };
}

test('plugin sync rejects missing envelope fields', async () => {
  const { service } = createService();
  await assert.rejects(
    () => service.sync({ timestamp: '', nonce: '', signature: '', payload: {} }),
    hasErrorCode('missing_fields')
  );
});

test('plugin sync rejects disabled servers', async () => {
  const { service, serverId, secret } = createService({ enabled: false });
  await assert.rejects(
    () => service.sync(signedRequest(serverId, secret)),
    hasErrorCode('server_disabled')
  );
});

test('plugin sync rejects bad hmac signatures', async () => {
  const { service, serverId, secret } = createService();
  await assert.rejects(
    () => service.sync({ ...signedRequest(serverId, secret), signature: 'bad' }),
    hasErrorCode('bad_signature')
  );
});

test('plugin sync returns legacy verified entries shape', async () => {
  const { service, serverId, secret, updated } = createService();
  const response = await service.sync(signedRequest(serverId, secret));
  assert.equal(response.server_id, serverId);
  assert.equal(response.guild_id, 'guild-1');
  assert.equal(response.entries.length, 1);
  assert.equal(response.entries[0]?.mc_ign, 'PlayerOne');
  assert.equal(updated.length, 1);
});

function hasErrorCode(code: string) {
  return (error: unknown) => {
    const response =
      error && typeof error === 'object' && 'getResponse' in error
        ? (error as { getResponse(): unknown }).getResponse()
        : error;
    return JSON.stringify(response).includes(code);
  };
}
