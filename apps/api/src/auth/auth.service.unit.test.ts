import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
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

test('auth fallback logs never include verification or password reset tokens', async () => {
  const accountId = randomUUID();
  const email = `security-${accountId}@example.com`;
  const verificationToken = 'verification-token-must-not-be-logged';
  const resetToken = 'reset-token-must-not-be-logged';
  const account = {
    id: accountId,
    provider: 'email' as const,
    providerUserId: email,
    email,
    displayName: 'Security Test',
    avatarUrl: null,
    emailVerified: false,
    passwordHash: 'existing-password-hash',
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    lastLoginAt: null,
  };
  const accounts = {
    findByProvider: async () => undefined,
    registerAccount: async () => account,
    listAccountsByEmail: async () => [account],
  };
  const prisma = {
    emailVerification: {
      deleteMany: async () => ({ count: 0 }),
      create: async () => ({
        accountId,
        email,
        token: verificationToken,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
    },
    passwordReset: {
      deleteMany: async () => ({ count: 0 }),
      create: async () => ({
        accountId,
        email,
        token: resetToken,
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      }),
    },
  };
  const emailService = { isEnabled: () => false };
  const service = new AuthService(
    accounts as never,
    {} as never,
    prisma as never,
    emailService as never,
    new ConfigService({} as NodeJS.ProcessEnv),
    {} as never,
  );
  const messages: unknown[] = [];
  const originalDebug = Logger.prototype.debug;
  Logger.prototype.debug = function (...args: unknown[]) {
    messages.push(args);
  };

  try {
    await service.registerEmail({
      email,
      password: 'SupersafePW1!',
      displayName: 'Security Test',
    });
    await service.requestPasswordReset(email);
  } finally {
    Logger.prototype.debug = originalDebug;
  }

  const serializedMessages = JSON.stringify(messages);
  assert.equal(serializedMessages.includes(verificationToken), false);
  assert.equal(serializedMessages.includes(resetToken), false);
  assert.equal(messages.length, 2);
});
