import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { AccountConflictService } from './account-conflict.service';

function createHarness(options: {
  readonly accountId?: string;
  readonly minecraftUuid?: string | null;
  readonly minecraftUuids?: readonly string[];
  readonly duplicateMinecraftAccountId?: string | null;
  readonly duplicateMinecraftUuid?: string | null;
  readonly discordUserId?: string | null;
  readonly discordByMinecraftUuid?: Readonly<Record<string, string>>;
  readonly minecraftByDiscordUserId?: Readonly<Record<string, string>>;
  readonly duplicateDiscordAccountId?: string | null;
  readonly duplicateEmailAccountId?: string | null;
  readonly linkedAccountId?: string | null;
  readonly accountEmail?: string | null;
  readonly emailVerified?: boolean;
  readonly legacyWikiProfileId?: bigint | null;
  readonly linkedWikiProfile?: boolean;
} = {}) {
  const accountId = options.accountId ?? randomUUID();
  const minecraftUuids = options.minecraftUuids
    ? [...options.minecraftUuids]
    : options.minecraftUuid === null
      ? []
      : [options.minecraftUuid ?? randomUUID()];
  const discordUserId = options.discordUserId === undefined ? 'discord-1' : options.discordUserId;
  const tickets: unknown[] = [];
  const messages: unknown[] = [];
  const audits: unknown[] = [];
  const mergeRequests: unknown[] = [];
  const mergedAccountIds: string[] = [];
  const linkedLegacyWikiProfileIds: bigint[] = [];

  const prisma = {
    minecraftIdentity: {
      async findMany() {
        return minecraftUuids.map((uuid, index) => ({ id: BigInt(index + 1), uuid }));
      },
      async findFirst(input: { where?: { uuid?: string; accountId?: { notIn?: string[] } } }) {
        if (input.where?.accountId?.notIn) {
          return options.duplicateMinecraftAccountId &&
            (!options.duplicateMinecraftUuid || options.duplicateMinecraftUuid === input.where.uuid)
            ? { accountId: options.duplicateMinecraftAccountId }
            : null;
        }
        return null;
      },
    },
    account: {
      async findUnique(input: { where: { id: string } }) {
        return { id: input.where.id, canonicalAccountId: input.where.id };
      },
      async findMany(input?: { select?: { canonicalAccountId?: boolean }; where?: { OR?: Array<{ id?: { in?: string[] }; canonicalAccountId?: { in?: string[] } }> } }) {
        if (input?.select?.canonicalAccountId) {
          const ids = input.where?.OR?.flatMap((part) => part.id?.in ?? part.canonicalAccountId?.in ?? []) ?? [];
          return [...new Set(ids)].map((id) => ({ id, canonicalAccountId: id }));
        }
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
      async findFirst(input: { where?: { provider?: string; email?: unknown; id?: { notIn?: string[] } } }) {
        if (input.where?.email) {
          return options.duplicateEmailAccountId ? { id: options.duplicateEmailAccountId } : null;
        }
        if (
          options.duplicateDiscordAccountId &&
          input.where?.id?.notIn?.includes(options.duplicateDiscordAccountId)
        ) {
          return null;
        }
        return options.duplicateDiscordAccountId ? { id: options.duplicateDiscordAccountId } : null;
      },
    },
    accountLink: {
      async findMany() { return []; },
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
      async updateMany(input: { where: { id: bigint } }) {
        linkedLegacyWikiProfileIds.push(input.where.id);
        return { count: 1 };
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
    accountMergeRequest: {
      async findFirst() { return null; },
      async create(args: { data: Record<string, unknown> }) {
        mergeRequests.push(args);
        return { id: randomUUID(), ...args.data };
      },
    },
    auditEvent: {
      async create(args: unknown) {
        audits.push(args);
        return {};
      },
    },
    async $transaction(operation: ((tx: unknown) => Promise<unknown>) | Array<Promise<unknown>>) {
      return typeof operation === 'function' ? operation(prisma) : Promise.all(operation);
    },
  };
  const events = { audit: async () => undefined };
  const discordMinecraftLinks = {
    async findByDiscordUserId(discordId: string) {
      const minecraftUuid = options.minecraftByDiscordUserId?.[discordId];
      return minecraftUuid ? { discordUserId: discordId, minecraftUuid } : null;
    },
    async findByMinecraftUuid(minecraftUuid: string) {
      const linkedDiscordUserId = options.discordByMinecraftUuid?.[minecraftUuid];
      return linkedDiscordUserId
        ? { discordUserId: linkedDiscordUserId, minecraftUuid }
        : null;
    },
  };
  return {
    accountId,
    tickets,
    messages,
    audits,
    mergeRequests,
    mergedAccountIds,
    linkedLegacyWikiProfileIds,
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

test('detects a conflict attached only to a secondary Minecraft identity', async () => {
  const primaryUuid = randomUUID();
  const secondaryUuid = randomUUID();
  const duplicateAccountId = randomUUID();
  const harness = createHarness({
    minecraftUuids: [primaryUuid, secondaryUuid],
    duplicateMinecraftUuid: secondaryUuid,
    duplicateMinecraftAccountId: duplicateAccountId,
  });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.equal(response.conflicts.length, 1);
  assert.equal(response.conflicts[0]?.kind, 'minecraft_identity_duplicate');
  assert.equal(response.conflicts[0]?.minecraftUuid, secondaryUuid);
  assert.equal(response.conflicts[0]?.conflictingAccountId, duplicateAccountId);
});

test('checks Discord verification history against every Minecraft identity', async () => {
  const primaryUuid = randomUUID();
  const secondaryUuid = randomUUID();
  const harness = createHarness({
    minecraftUuids: [primaryUuid, secondaryUuid],
    discordByMinecraftUuid: { [secondaryUuid]: 'different-discord-user' },
  });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.equal(response.conflicts.length, 1);
  assert.equal(response.conflicts[0]?.kind, 'discord_minecraft_mismatch');
  assert.equal(response.conflicts[0]?.minecraftUuid, secondaryUuid);
  assert.equal(response.conflicts[0]?.discordUserId, 'different-discord-user');
});

test('does not mismatch a Discord verification linked to any identity in the group', async () => {
  const primaryUuid = randomUUID();
  const secondaryUuid = randomUUID();
  const harness = createHarness({
    minecraftUuids: [primaryUuid, secondaryUuid],
    minecraftByDiscordUserId: { 'discord-1': secondaryUuid },
  });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.deepEqual(response.conflicts, []);
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

test('reports a separate active account with the same verified email without auto-merging', async () => {
  const duplicateAccountId = randomUUID();
  const harness = createHarness({
    minecraftUuid: null,
    discordUserId: null,
    accountEmail: 'same-person@example.com',
    emailVerified: true,
    duplicateEmailAccountId: duplicateAccountId,
  });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.equal(response.conflicts.length, 1);
  assert.equal(response.conflicts[0]?.kind, 'verified_email_duplicate');
  assert.equal(response.conflicts[0]?.conflictingAccountId, duplicateAccountId);
});

test('does not report Minecraft identity stored inside the canonical account group', async () => {
  const harness = createHarness({ linkedAccountId: randomUUID() });

  const response = await harness.service.listLinkConflicts(harness.accountId);

  assert.deepEqual(response.conflicts, []);
});

test('does not report a Discord account already inside the canonical account group', async () => {
  const linkedAccountId = randomUUID();
  const harness = createHarness({
    minecraftUuid: null,
    linkedAccountId,
    duplicateDiscordAccountId: linkedAccountId,
  });

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

  assert.equal(harness.mergeRequests.length, 1);
  const audit = harness.audits[0] as { data: { action: string; subjectType: string } };
  assert.equal(audit.data.action, 'account.merge_request.created');
  assert.equal(audit.data.subjectType, 'account_merge_request');
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

test('reports a conflicting Discord account without mutating account ownership', async () => {
  const duplicateAccountId = randomUUID();
  const harness = createHarness({ minecraftUuid: null, duplicateDiscordAccountId: duplicateAccountId });
  const response = await harness.service.listLinkConflicts(harness.accountId);
  assert.equal(response.conflicts.length, 1);
  assert.deepEqual(harness.mergedAccountIds, []);
  assert.equal(harness.tickets.length, 0);
  assert.equal(harness.audits.length, 0);
});

test('reports a matching verified email without merging accounts', async () => {
  const duplicateAccountId = randomUUID();
  const harness = createHarness({
    minecraftUuid: null,
    discordUserId: null,
    accountEmail: 'same-person@example.com',
    emailVerified: true,
    duplicateEmailAccountId: duplicateAccountId,
  });
  const response = await harness.service.listLinkConflicts(harness.accountId);
  assert.equal(response.conflicts.length, 1);
  assert.deepEqual(harness.mergedAccountIds, []);
  assert.equal(harness.audits.length, 0);
});

test('reports an unowned legacy wiki profile without claiming it', async () => {
  const harness = createHarness({ minecraftUuid: null, discordUserId: null, accountEmail: 'legacy@example.com', emailVerified: true, legacyWikiProfileId: 197n });
  const response = await harness.service.listLinkConflicts(harness.accountId);
  assert.equal(response.conflicts.length, 1);
  assert.deepEqual(harness.linkedLegacyWikiProfileIds, []);
  assert.equal(harness.tickets.length, 0);
});
