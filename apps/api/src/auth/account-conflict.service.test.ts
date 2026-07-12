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
  readonly linkedAccountId?: string | null;
  readonly accountEmail?: string | null;
  readonly emailVerified?: boolean;
  readonly legacyWikiProfileId?: bigint | null;
  readonly linkedWikiProfile?: boolean;
} = {}) {
  const accountId = options.accountId ?? randomUUID();
  const minecraftUuid = options.minecraftUuid === undefined ? randomUUID() : options.minecraftUuid;
  const discordUserId = options.discordUserId === undefined ? 'discord-1' : options.discordUserId;
  const tickets: unknown[] = [];
  const messages: unknown[] = [];
  const audits: unknown[] = [];

  const prisma = {
    minecraftIdentity: {
      async findFirst(input: { where?: { accountId?: { notIn?: string[] } } }) {
        if (input.where?.accountId?.notIn) {
          return options.duplicateMinecraftAccountId
            ? { accountId: options.duplicateMinecraftAccountId }
            : null;
        }
        return minecraftUuid ? { uuid: minecraftUuid } : null;
      },
    },
    account: {
      async findMany() {
        return [
          discordUserId
            ? {
                id: accountId,
                provider: 'discord',
                providerUserId: discordUserId,
                email: options.accountEmail ?? null,
                emailVerified: options.emailVerified ?? false,
              }
            : {
                id: accountId,
                provider: 'email',
                providerUserId: 'user@example.com',
                email: options.accountEmail ?? 'user@example.com',
                emailVerified: options.emailVerified ?? true,
              },
          ...(options.linkedAccountId
            ? [
                {
                  id: options.linkedAccountId,
                  provider: 'naver',
                  providerUserId: 'linked-naver',
                  email: null,
                  emailVerified: false,
                },
              ]
            : []),
        ];
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
    wikiProfile: {
      async findFirst(input: { where?: { accountId?: unknown } }) {
        if (input.where?.accountId) {
          return options.linkedWikiProfile ? { id: 999n } : null;
        }
        return options.legacyWikiProfileId ? { id: options.legacyWikiProfileId } : null;
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

test('does not report Minecraft identity stored inside the canonical account group', async () => {
  const harness = createHarness({ linkedAccountId: randomUUID() });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.deepEqual(response.conflicts, []);
});

test('offers manual recovery for an unlinked legacy wiki profile with verified email', async () => {
  const harness = createHarness({
    minecraftUuid: null,
    discordUserId: null,
    accountEmail: 'legacy@example.com',
    emailVerified: true,
    legacyWikiProfileId: 197n,
  });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.equal(response.conflicts.length, 1);
  assert.equal(response.conflicts[0]?.kind, 'legacy_wiki_profile');
  assert.equal(response.conflicts[0]?.legacyWikiProfileId, '197');
  assert.equal(response.conflicts[0]?.conflictingAccountId, null);
});

test('never offers legacy wiki recovery from an unverified email', async () => {
  const harness = createHarness({
    minecraftUuid: null,
    discordUserId: null,
    accountEmail: 'legacy@example.com',
    emailVerified: false,
    legacyWikiProfileId: 197n,
  });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.deepEqual(response.conflicts, []);
});

test('does not offer a second legacy profile when the canonical account already has one', async () => {
  const harness = createHarness({
    minecraftUuid: null,
    discordUserId: null,
    accountEmail: 'legacy@example.com',
    emailVerified: true,
    legacyWikiProfileId: 197n,
    linkedWikiProfile: true,
  });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.deepEqual(response.conflicts, []);
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
