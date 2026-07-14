import assert from 'node:assert/strict';
import test from 'node:test';
import { processAccountDeletionDiscordRevocations } from './account-deletion-discord-revocations';

test('account deletion Discord revocation claims once, removes the role, and scrubs outbox identifiers', async () => {
  const now = new Date('2026-07-15T00:00:00.000Z');
  const updates: Array<Record<string, unknown>> = [];
  let requestedUrl = '';
  const prisma = {
    accountDeletionDiscordRevocation: {
      async updateMany(input: Record<string, unknown>) {
        updates.push(input);
        return { count: updates.length === 2 ? 1 : 0 };
      },
      async findMany() {
        return [{ id: 'outbox-1', guildId: 'guild-1', discordUserId: 'user-1', roleId: 'role-1', verificationSessionId: 'session-1', attempts: 0, createdAt: now }];
      },
      async update(input: Record<string, unknown>) { updates.push(input); return input; },
    },
    discordVerificationSession: {
      async updateMany(input: Record<string, unknown>) { updates.push(input); return { count: 1 }; },
    },
  };
  const result = await processAccountDeletionDiscordRevocations(prisma as never, 'bot-token', {
    now,
    fetchImpl: async (url, init) => {
      requestedUrl = String(url);
      assert.equal(init?.method, 'DELETE');
      assert.equal(new Headers(init?.headers).get('authorization'), 'Bot bot-token');
      return new Response(null, { status: 204 });
    },
  });
  assert.deepEqual(result, { processed: 1, retried: 0, failed: 0 });
  assert.equal(requestedUrl, 'https://discord.com/api/v10/guilds/guild-1/members/user-1/roles/role-1');
  assert.ok(updates.some((entry) => JSON.stringify(entry).includes('"discordUserId":null')));
  assert.ok(updates.some((entry) => JSON.stringify(entry).includes('account_deleted_role_revoked')));
});

test('account deletion Discord revocation treats Discord 404 as already removed', async () => {
  const now = new Date('2026-07-15T00:00:00.000Z');
  const prisma = {
    accountDeletionDiscordRevocation: {
      async updateMany(input: { where: { status?: string } }) { return { count: input.where.status === 'pending' ? 1 : 0 }; },
      async findMany() { return [{ id: 'outbox-1', guildId: 'guild-1', discordUserId: 'gone', roleId: 'role-1', verificationSessionId: null, attempts: 0, createdAt: now }]; },
      async update(input: Record<string, unknown>) { return input; },
    },
    discordVerificationSession: { async updateMany() { return { count: 0 }; } },
  };
  const result = await processAccountDeletionDiscordRevocations(prisma as never, 'bot-token', { now, fetchImpl: async () => new Response(null, { status: 404 }) });
  assert.equal(result.processed, 1);
});
