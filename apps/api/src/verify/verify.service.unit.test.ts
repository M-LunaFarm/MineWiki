import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@minewiki/config';
import type { BusinessEventService } from '../events/business-event.service';
import { VerifyService } from './verify.service';

function createHarness(options: {
  readonly existingDiscordLink?: { discordUserId: string; minecraftUuid: string };
  readonly existingMinecraftLink?: { discordUserId: string; minecraftUuid: string };
  readonly conflictingMinecraftAccountId?: string;
} = {}) {
  let session: any = null;
  const prisma = {
    discordVerificationSession: {
      async create(args: { data: Record<string, unknown> }) {
        session = {
          id: randomUUID(),
          status: 'pending',
          verificationUrl: null,
          accountId: null,
          minecraftUuid: null,
          minecraftName: null,
          completedAt: null,
          lastSyncStatus: null,
          eventLog: [],
          createdAt: new Date(),
          ...args.data
        };
        return session;
      },
      async update(args: { data: Record<string, unknown> }) {
        session = { ...session, ...args.data };
        return session;
      },
      async updateMany(args: { where: { status?: string }; data: Record<string, unknown> }) {
        if (!session || (args.where.status && session.status !== args.where.status)) {
          return { count: 0 };
        }
        session = { ...session, ...args.data };
        return { count: 1 };
      },
      async findUnique() {
        return session;
      }
    },
    lunaGuild: {
      async upsert() {
        return {};
      },
      async findUnique() {
        return null;
      }
    },
    lunaGuildChannelSetting: {
      async upsert() {
        return {};
      },
      async findUnique() {
        return null;
      }
    },
    minecraftIdentity: {
      async findFirst() {
        return options.conflictingMinecraftAccountId
          ? { accountId: options.conflictingMinecraftAccountId }
          : null;
      },
      async upsert() {
        return {};
      }
    },
    lunaDiscordAccountLink: {
      async findUnique(args: { where: { discordUserId?: string; minecraftUuid?: string } }) {
        if (args.where.discordUserId) {
          return options.existingDiscordLink ?? null;
        }
        if (args.where.minecraftUuid) {
          return options.existingMinecraftLink ?? null;
        }
        return null;
      },
      async upsert() {
        return {};
      }
    },
    lunaGuildVerification: {
      async upsert() {
        return {};
      }
    },
    lunaPrivacyConsent: {
      async upsert() {
        return {};
      }
    },
    lunaEvent: {
      async create() {
        return {};
      }
    },
    async $transaction(operations: Array<Promise<unknown>>) {
      return Promise.all(operations);
    }
  };
  const config = {
    getOptional(key: string) {
      return key === 'VERIFY_PUBLIC_BASE_URL' ? 'https://minewiki.test' : undefined;
    }
  } as ConfigService;
  const events = { track: async () => {} } as BusinessEventService;
  return {
    get session() {
      return session;
    },
    setSession(next: any) {
      session = next;
    },
    service: new VerifyService(prisma as never, config, events)
  };
}

async function createPendingSession(harness: ReturnType<typeof createHarness>) {
  const response = await harness.service.createDiscordSession({
    guildId: 'guild-1',
    channelId: 'channel-1',
    requesterDiscordId: 'discord-1'
  });
  const completionToken = new URL(response.verificationUrl).searchParams.get('verifyToken');
  assert.ok(completionToken);
  return { response, completionToken };
}

test('discord verify completes with a valid completion token', async () => {
  const harness = createHarness();
  const { response, completionToken } = await createPendingSession(harness);

  const completed = await harness.service.completeDiscordSession(response.sessionId, randomUUID(), {
    completionToken,
    minecraftUuid: randomUUID(),
    playerName: 'Tester'
  });

  assert.equal(completed.status, 'sync_pending');
});

test('discord verify rejects missing completion token', async () => {
  const harness = createHarness();
  const { response } = await createPendingSession(harness);

  await assert.rejects(
    () =>
      harness.service.completeDiscordSession(response.sessionId, randomUUID(), {
        minecraftUuid: randomUUID(),
        playerName: 'Tester'
      } as never),
    /token is invalid/
  );
});

test('discord verify rejects wrong completion token', async () => {
  const harness = createHarness();
  const { response } = await createPendingSession(harness);

  await assert.rejects(
    () =>
      harness.service.completeDiscordSession(response.sessionId, randomUUID(), {
        completionToken: 'x'.repeat(43),
        minecraftUuid: randomUUID(),
        playerName: 'Tester'
      }),
    /token is invalid/
  );
});

test('discord verify cannot be completed twice', async () => {
  const harness = createHarness();
  const { response, completionToken } = await createPendingSession(harness);
  const accountId = randomUUID();
  const minecraftUuid = randomUUID();
  await harness.service.completeDiscordSession(response.sessionId, accountId, {
    completionToken,
    minecraftUuid,
    playerName: 'Tester'
  });

  await assert.rejects(
    () =>
      harness.service.completeDiscordSession(response.sessionId, accountId, {
        completionToken,
        minecraftUuid,
        playerName: 'Tester'
      }),
    /already completed/
  );
});

test('discord verify rejects expired sessions', async () => {
  const harness = createHarness();
  const { response, completionToken } = await createPendingSession(harness);
  harness.setSession({ ...harness.session, expiresAt: new Date(Date.now() - 1000) });

  await assert.rejects(
    () =>
      harness.service.completeDiscordSession(response.sessionId, randomUUID(), {
        completionToken,
        minecraftUuid: randomUUID(),
        playerName: 'Tester'
      }),
    /expired/
  );
});

test('discord verify rejects conflicting Discord account mapping', async () => {
  const harness = createHarness({
    existingDiscordLink: {
      discordUserId: 'discord-1',
      minecraftUuid: randomUUID()
    }
  });
  const { response, completionToken } = await createPendingSession(harness);

  await assert.rejects(
    () =>
      harness.service.completeDiscordSession(response.sessionId, randomUUID(), {
        completionToken,
        minecraftUuid: randomUUID(),
        playerName: 'Tester'
      }),
    /Discord account is already linked/
  );
});
