import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { Logger } from '@nestjs/common';
import { Algorithm, hash } from '@node-rs/argon2';
import { ConfigService } from '@minewiki/config';
import { AuthService } from './auth.service';

test('login performs password work even when the email is unknown', async () => {
  const service = new AuthService(
    { listAccountsByEmail: async () => [] } as never,
    {} as never,
    {} as never,
    {} as never,
    new ConfigService({} as NodeJS.ProcessEnv),
    {} as never,
  );
  const startedAt = performance.now();

  await assert.rejects(
    () => service.loginEmail({ email: 'missing@example.com', password: 'UnknownPW1!' }),
    /이메일 또는 비밀번호가 올바르지 않습니다/,
  );

  assert.ok(performance.now() - startedAt >= 5);
});

test('password change atomically clears pending reset tokens', async () => {
  const accountId = randomUUID();
  const account = {
    id: accountId,
    provider: 'email' as const,
    providerUserId: 'player@example.com',
    email: 'player@example.com',
    displayName: 'Player',
    avatarUrl: null,
    emailVerified: true,
    passwordHash: await hash('CurrentPW1!', {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
      algorithm: Algorithm.Argon2id,
    }),
    createdAt: new Date('2024-01-01T00:00:00.000Z').toISOString(),
    lastLoginAt: null,
  };
  const operations: string[] = [];
  const prisma = {
    account: {
      findMany: async () => [{ id: accountId, canonicalAccountId: null }],
      count: async () => 1,
      update: (input: unknown) => {
        operations.push('password');
        return { kind: 'password', input };
      },
    },
    accountLink: {
      findMany: async () => [],
    },
    passwordReset: {
      deleteMany: (input: unknown) => {
        operations.push('reset-tokens');
        return { kind: 'reset-tokens', input };
      },
    },
    $queryRaw: async () => [{ id: accountId }],
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
      return callback(prisma);
    },
  };
  const service = new AuthService(
    { getAccount: async () => account } as never,
    {} as never,
    prisma as never,
    {} as never,
    new ConfigService({} as NodeJS.ProcessEnv),
    {} as never,
  );

  await service.changePassword(accountId, 'CurrentPW1!', 'ChangedPW1!');

  assert.deepEqual(operations, ['password', 'reset-tokens']);
});

test('password change rejects reusing the current password', async () => {
  const accountId = randomUUID();
  const currentPassword = 'CurrentPW1!';
  const account = {
    id: accountId,
    passwordHash: await hash(currentPassword, {
      memoryCost: 19456,
      timeCost: 2,
      parallelism: 1,
      outputLen: 32,
      algorithm: Algorithm.Argon2id,
    }),
  };
  let transactionCalled = false;
  const service = new AuthService(
    { getAccount: async () => account } as never,
    {} as never,
    {
      $transaction: async () => {
        transactionCalled = true;
      },
    } as never,
    {} as never,
    new ConfigService({} as NodeJS.ProcessEnv),
    {} as never,
  );

  await assert.rejects(
    () => service.changePassword(accountId, currentPassword, currentPassword),
    /새 비밀번호는 현재 비밀번호와 달라야 합니다/,
  );
  assert.equal(transactionCalled, false);
});

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
    account: {
      findMany: async () => [{ id: accountId, canonicalAccountId: null }],
      count: async () => 1,
    },
    accountLink: {
      findMany: async () => [],
    },
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
    $queryRaw: async () => [{ id: accountId }],
    $transaction: async (callback: (transaction: unknown) => Promise<unknown>) => {
      return callback(prisma);
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
      agreeTerms: true,
      agreePrivacy: true,
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
