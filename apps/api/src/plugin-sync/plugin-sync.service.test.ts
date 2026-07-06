import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  buildSignatureBody,
  hmacSha256Hex,
  PluginSyncService,
  type PluginSyncRequest,
  type PluginSyncSecurityStore
} from './plugin-sync.service';

class SharedPluginSyncSecurityStore implements PluginSyncSecurityStore {
  readonly nonces = new Set<string>();
  readonly cooldowns = new Map<string, Date>();

  async claimNonce(serverId: string, nonce: string): Promise<boolean> {
    const key = `${serverId}:${nonce}`;
    if (this.nonces.has(key)) {
      return false;
    }
    this.nonces.add(key);
    return true;
  }

  async touchCooldown(serverId: string, cooldownSeconds: number, now: Date): Promise<number | null> {
    const lastSeenAt = this.cooldowns.get(serverId);
    if (lastSeenAt) {
      const elapsedSeconds = Math.floor((now.getTime() - lastSeenAt.getTime()) / 1000);
      if (elapsedSeconds < cooldownSeconds) {
        return cooldownSeconds - elapsedSeconds;
      }
    }
    this.cooldowns.set(serverId, now);
    return null;
  }
}

function createService(options: {
  enabled?: boolean;
  canonical?: boolean;
  serverId?: string;
  securityStore?: PluginSyncSecurityStore;
} = {}) {
  const serverId = options.serverId ?? `server-${Math.random().toString(36).slice(2)}`;
  const secret = 'secret';
  const updated: unknown[] = [];
  const canonicalUpdated: unknown[] = [];
  const auditEvents: unknown[] = [];
  const prisma = {
    pluginServer: {
      findUnique: async () =>
        options.canonical
          ? {
              pluginServerId: serverId,
              guildId: 'guild-1',
              serverSecret: secret,
              enabled: options.enabled ?? true
            }
          : null,
      update: async (args: unknown) => {
        canonicalUpdated.push(args);
      }
    },
    lunaGuildServer: {
      findUnique: async () =>
        options.canonical
          ? null
          : {
              serverId,
              guildId: 'guild-1',
              serverSecret: secret,
              enabled: options.enabled ?? true
            },
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
    },
    serverPluginSyncEvent: {
      create: async (args: unknown) => {
        auditEvents.push(args);
        return { id: `audit-${auditEvents.length}` };
      }
    }
  };
  return {
    service: new PluginSyncService(prisma as never, options.securityStore ?? new SharedPluginSyncSecurityStore()),
    serverId,
    secret,
    updated,
    canonicalUpdated,
    auditEvents
  };
}

function signedRequest(
  serverId: string,
  secret: string,
  options: { nonce?: string; timestamp?: string } = {}
): PluginSyncRequest {
  const timestamp = options.timestamp ?? String(Math.floor(Date.now() / 1000));
  const nonce = options.nonce ?? 'nonce-1';
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
  const { service, serverId, secret, auditEvents } = createService();
  await assert.rejects(
    () => service.sync({ ...signedRequest(serverId, secret), signature: 'bad' }),
    hasErrorCode('bad_signature')
  );
  assert.equal(auditEvents.length, 1);
  assert.equal(auditAction(auditEvents[0]), 'bad_signature');
});

test('plugin sync rejects stale timestamps', async () => {
  const { service, serverId, secret, auditEvents } = createService();
  const staleTimestamp = String(Math.floor(Date.now() / 1000) - 301);

  await assert.rejects(
    () => service.sync(signedRequest(serverId, secret, { timestamp: staleTimestamp })),
    hasErrorCode('stale')
  );
  assert.equal(auditEvents.length, 1);
  assert.equal(auditAction(auditEvents[0]), 'stale');
});

test('plugin sync rejects repeated nonces', async () => {
  const securityStore = new SharedPluginSyncSecurityStore();
  const { service, serverId, secret, auditEvents } = createService({ securityStore });
  await service.sync(signedRequest(serverId, secret, { nonce: 'repeat' }));

  await assert.rejects(
    () => service.sync(signedRequest(serverId, secret, { nonce: 'repeat' })),
    hasErrorCode('replay')
  );
  assert.equal(auditAction(auditEvents.at(-1)), 'replay');
});

test('plugin sync cooldown works across service instances', async () => {
  const securityStore = new SharedPluginSyncSecurityStore();
  const serverId = 'shared-server';
  const first = createService({ serverId, securityStore });
  const second = createService({ serverId, securityStore });
  await first.service.sync(signedRequest(serverId, first.secret, { nonce: 'first' }));

  await assert.rejects(
    () => second.service.sync(signedRequest(serverId, second.secret, { nonce: 'second' })),
    hasErrorCode('rate_limited')
  );
  assert.equal(auditAction(second.auditEvents.at(-1)), 'rate_limited');
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

test('plugin sync uses canonical plugin server before legacy fallback', async () => {
  const { service, serverId, secret, updated, canonicalUpdated } = createService({
    canonical: true
  });
  const response = await service.sync(signedRequest(serverId, secret));
  assert.equal(response.server_id, serverId);
  assert.equal(response.guild_id, 'guild-1');
  assert.equal(canonicalUpdated.length, 1);
  assert.equal(updated.length, 0);
});

function auditAction(event: unknown): string | undefined {
  return (event as { data?: { action?: string } } | undefined)?.data?.action;
}

function hasErrorCode(code: string) {
  return (error: unknown) => {
    const response =
      error && typeof error === 'object' && 'getResponse' in error
        ? (error as { getResponse(): unknown }).getResponse()
        : error;
    return JSON.stringify(response).includes(code);
  };
}
