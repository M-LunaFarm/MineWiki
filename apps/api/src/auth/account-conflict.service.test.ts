import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountConflictService } from './account-conflict.service';

function createHarness(options: {
  readonly accountId?: string;
  readonly minecraftUuid?: string | null;
  readonly duplicateMinecraftAccountId?: string | null;
  readonly discordUserId?: string | null;
  readonly duplicateDiscordAccountId?: string | null;
} = {}) {
  const accountId = options.accountId ?? randomUUID();
  const minecraftUuid = options.minecraftUuid === undefined ? randomUUID() : options.minecraftUuid;
  const discordUserId = options.discordUserId === undefined ? 'discord-1' : options.discordUserId;
  const tickets: unknown[] = [];
  const messages: unknown[] = [];
  const audits: unknown[] = [];

  const prisma = {
    minecraftIdentity: {
      async findUnique() {
        return minecraftUuid ? { uuid: minecraftUuid } : null;
      },
      async findFirst() {
        return options.duplicateMinecraftAccountId
          ? { accountId: options.duplicateMinecraftAccountId }
          : null;
      },
    },
    account: {
      async findUnique() {
        return discordUserId
          ? { provider: 'discord', providerUserId: discordUserId }
          : { provider: 'email', providerUserId: 'user@example.com' };
      },
      async findFirst() {
        return options.duplicateDiscordAccountId ? { id: options.duplicateDiscordAccountId } : null;
      },
    },
    oAuthCredential: {
      async findMany() {
        return [];
      },
      async findFirst() {
        return null;
      },
    },
    supportTicket: {
      create: async (args: unknown) => {
        tickets.push(args);
        return {};
      },
    },
    supportMessage: {
      create: async (args: unknown) => {
        messages.push(args);
        return {};
      },
    },
    async $transaction(operations: Array<Promise<unknown>>) {
      return Promise.all(operations);
    },
  };
  const events = {
    audit: async (...args: unknown[]) => {
      audits.push(args);
    },
  };
  const discordMinecraftLinks = {
    async findByDiscordUserId() {
      return null;
    },
    async findByMinecraftUuid() {
      return null;
    },
  };

  return {
    accountId,
    tickets,
    messages,
    audits,
    service: new AccountConflictService(
      prisma as never,
      events as never,
      discordMinecraftLinks as never,
    ),
  };
}

test('detects duplicate Minecraft identity conflict', async () => {
  const duplicateAccountId = randomUUID();
  const harness = createHarness({ duplicateMinecraftAccountId: duplicateAccountId });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.equal(response.conflicts.length, 1);
  assert.equal(response.conflicts[0]?.kind, 'minecraft_identity_duplicate');
  assert.equal(response.conflicts[0]?.conflictingAccountId, duplicateAccountId);
});

test('detects duplicate Discord identity conflict', async () => {
  const duplicateAccountId = randomUUID();
  const harness = createHarness({
    minecraftUuid: null,
    duplicateDiscordAccountId: duplicateAccountId,
  });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.equal(response.conflicts.length, 1);
  assert.equal(response.conflicts[0]?.kind, 'discord_identity_duplicate');
  assert.equal(response.conflicts[0]?.conflictingAccountId, duplicateAccountId);
});

test('creates merge request support ticket without auto-merging', async () => {
  const harness = createHarness({ duplicateMinecraftAccountId: randomUUID() });

  const response = await harness.service.createMergeRequest(harness.accountId, {
    message: '두 계정 모두 제가 사용합니다.',
  });

  assert.equal(response.status, 'created');
  assert.equal(response.conflicts.length, 1);
  assert.equal(harness.tickets.length, 1);
  assert.equal(harness.messages.length, 1);
  assert.equal(harness.audits.length, 1);

  const ticket = harness.tickets[0] as { data: { category: string; priority: string } };
  assert.equal(ticket.data.category, 'account');
  assert.equal(ticket.data.priority, 'high');

  const audit = harness.audits[0] as [string, { subjectId: string }];
  assert.equal(audit[0], 'account.merge_request.created');
  assert.equal(audit[1].subjectId, response.ticketId);
});

test('creates manual merge request from safe conflict rejection message', async () => {
  const harness = createHarness({
    minecraftUuid: null,
    discordUserId: null,
  });

  const response = await harness.service.createMergeRequest(harness.accountId, {
    source: 'minecraft_verify',
    conflictMessage: 'Minecraft identity is already linked to another MineWiki account.',
  });

  assert.equal(response.status, 'created');
  assert.equal(response.conflicts.length, 1);
  assert.equal(response.conflicts[0]?.kind, 'minecraft_identity_duplicate');
  assert.equal(harness.tickets.length, 1);
});
