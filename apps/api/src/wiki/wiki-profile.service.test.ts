import assert from 'node:assert/strict';
import test from 'node:test';
import type { PrismaService } from '../common/prisma.service';
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
        if ('accountId' in where) return null;
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

function serviceWithProfile(status = 'active') {
  const profile = {
    id: 42n,
    accountId: 'account-owner',
    username: 'discord_owner_name',
    displayName: '문서 소유자',
    email: 'private@example.com',
    emailVerifiedAt: new Date(),
    emailVerificationSentAt: null,
    passwordHash: 'private-hash',
    status,
    createdAt: new Date('2026-01-02T03:04:05.000Z'),
    updatedAt: new Date('2026-01-02T03:04:05.000Z')
  };
  const prisma = {
    wikiProfile: { async findUnique() { return profile; } },
    wikiNamespace: { async findUnique() { return { id: 7 }; } },
    wikiPage: {
      async findUnique() {
        return { status: 'normal', ownerProfileId: profile.id };
      }
    }
  } as unknown as PrismaService;
  return new WikiProfileService(prisma);
}

test('public wiki profiles expose only document-safe identity and ownership state', async () => {
  const result = await serviceWithProfile().getPublicProfile('discord_owner_name', 'account-owner');
  assert.deepEqual(result, {
    id: '42',
    username: 'discord_owner_name',
    displayName: '문서 소유자',
    status: 'active',
    createdAt: '2026-01-02T03:04:05.000Z',
    documentPath: '/user/discord_owner_name',
    documentExists: true,
    contributionsPath: '/wiki/contributions/42',
    isOwner: true,
    canEditDocument: true
  });
  assert.equal('email' in result, false);
  assert.equal('accountId' in result, false);
});

test('blocked and non-canonical profiles cannot claim editable user documents', async () => {
  const blocked = await serviceWithProfile('blocked').getPublicProfile('discord_owner_name', 'account-owner');
  assert.equal(blocked.isOwner, true);
  assert.equal(blocked.canEditDocument, false);
  await assert.rejects(
    () => serviceWithProfile().getPublicProfile('ｄｉｓｃｏｒｄ＿ｏｗｎｅｒ＿ｎａｍｅ', 'account-owner'),
    /Wiki user not found/
  );
  await assert.rejects(
    () => serviceWithProfile('closed').getPublicProfile('discord_owner_name', null),
    /Wiki user not found/
  );
});
