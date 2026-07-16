import assert from 'node:assert/strict';
import { test } from 'node:test';
import { AuthService } from './auth.service';
import { AccountSeparationService } from './account-separation.service';

const ACCOUNT_ID = '11111111-1111-4111-8111-111111111111';
const createdAt = new Date('2026-07-17T00:00:00.000Z');

test('display name updates stay synchronized with the active canonical wiki profile', async () => {
  const writes: Array<{ readonly target: string; readonly data: unknown }> = [];
  const account = {
    id: ACCOUNT_ID,
    canonicalAccountId: ACCOUNT_ID,
    provider: 'email',
    providerUserId: 'person@example.com',
    email: 'person@example.com',
    displayName: 'Before',
    avatarUrl: null,
    createdAt,
    lastLoginAt: null,
    emailVerified: true,
    passwordHash: 'hash',
    lifecycleStatus: 'active',
  };
  const tx = {
    account: {
      async findMany() { return [account]; },
      async count() { return 1; },
      async update({ data }: { data: { displayName: string } }) {
        writes.push({ target: 'account', data });
        return { ...account, displayName: data.displayName };
      },
    },
    accountLink: { async findMany() { return []; } },
    wikiProfile: {
      async updateMany(input: unknown) {
        writes.push({ target: 'wikiProfile', data: input });
        return { count: 1 };
      },
    },
    async $queryRaw() { return [{ id: ACCOUNT_ID }]; },
  };
  const prisma = {
    account: { async findUnique() { return account; } },
    accountLink: { async findMany() { return []; } },
    async $transaction(callback: (store: typeof tx) => Promise<unknown>) { return callback(tx); },
  };
  const accounts = new AccountSeparationService(prisma as never);
  const service = new AuthService(
    accounts,
    {} as never,
    prisma as never,
    {} as never,
    { getOptional() { return undefined; } } as never,
    {} as never,
  );

  const result = await service.updateDisplayName(ACCOUNT_ID, '  New public name  ');

  assert.equal(result.displayName, 'New public name');
  assert.deepEqual(writes[0], { target: 'account', data: { displayName: 'New public name' } });
  assert.equal(writes[1]?.target, 'wikiProfile');
  assert.deepEqual((writes[1]?.data as { where: unknown }).where, {
    accountId: ACCOUNT_ID,
    status: 'active',
  });
  assert.equal(
    (writes[1]?.data as { data: { displayName: string } }).data.displayName,
    'New public name',
  );
});
