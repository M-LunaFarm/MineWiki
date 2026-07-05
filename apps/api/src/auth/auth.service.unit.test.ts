import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConfigService } from '@minewiki/config';
import { AuthService } from './auth.service';

test('avatar upload uses canonical file service metadata path', async () => {
  const account = {
    id: randomUUID(),
    provider: 'email' as const,
    providerUserId: 'player@example.com',
    email: 'player@example.com',
    displayName: 'Player',
    avatarUrl: null as string | null,
    emailVerified: true,
    passwordHash: 'hash',
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    lastLoginAt: null,
  };
  const calls: unknown[] = [];
  const accounts = {
    getAccount: async () => account,
    listLinkedAccounts: async () => [],
    getLinkedAccountIds: async () => [],
  };
  const prisma = {
    account: {
      update: async ({ data }: { data: { avatarUrl: string | null } }) => {
        account.avatarUrl = data.avatarUrl;
        return account;
      },
    },
  };
  const files = {
    createImage: async (...args: unknown[]) => {
      calls.push(args);
      return { publicPath: '/uploads/profile.png' };
    },
  };
  const service = new AuthService(
    accounts as never,
    {} as never,
    prisma as never,
    {} as never,
    new ConfigService({} as NodeJS.ProcessEnv),
    files as never,
  );

  const view = await service.updateAvatar(account.id, {
    data: 'data:image/png;base64,AAAA',
    filename: 'profile.png',
  });

  assert.equal(view.avatarUrl, '/uploads/profile.png');
  assert.deepEqual(calls, [
    [
      account.id,
      {
        data: 'data:image/png;base64,AAAA',
        filename: 'profile.png',
        usageContext: 'profile_avatar',
      },
    ],
  ]);
});
