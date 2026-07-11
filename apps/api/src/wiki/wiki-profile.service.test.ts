import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WikiProfileService } from './wiki-profile.service';

const account = {
  id: '11111111-1111-4111-8111-111111111111',
  provider: 'discord',
  displayName: 'New owner',
  email: 'shared@example.com'
};

test('a matching legacy email never transfers an unlinked wiki profile', async () => {
  const legacyProfile = {
    id: 7n,
    accountId: null,
    email: account.email,
    username: 'legacy_owner',
    displayName: 'Legacy owner'
  };
  let createdData: Record<string, unknown> | undefined;
  let updateCalled = false;
  const prisma = {
    account: {
      async findUnique() {
        return account;
      }
    },
    wikiProfile: {
      async findUnique({ where }: { where: Record<string, unknown> }) {
        if ('accountId' in where) {
          return null;
        }
        return legacyProfile;
      },
      async update() {
        updateCalled = true;
        return legacyProfile;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        createdData = data;
        return { id: 8n, ...data };
      }
    }
  };

  const profile = await new WikiProfileService(prisma as never).ensureWikiProfile(account.id);

  assert.equal(updateCalled, false);
  assert.equal(profile.id, 8n);
  assert.equal(createdData?.accountId, account.id);
  assert.equal(createdData?.email, null);
});

test('a fresh wiki profile retains the account email when it is unused', async () => {
  let createdData: Record<string, unknown> | undefined;
  const prisma = {
    account: {
      async findUnique() {
        return account;
      }
    },
    wikiProfile: {
      async findUnique() {
        return null;
      },
      async create({ data }: { data: Record<string, unknown> }) {
        createdData = data;
        return { id: 8n, ...data };
      }
    }
  };

  await new WikiProfileService(prisma as never).ensureWikiProfile(account.id);

  assert.equal(createdData?.email, account.email);
});
