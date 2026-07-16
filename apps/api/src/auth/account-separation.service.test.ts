import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ConflictException } from '@nestjs/common';
import { AccountSeparationService } from './account-separation.service';
import { PrismaService } from '../common/prisma.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const service = new AccountSeparationService(prisma);

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  test('allows identical email across different providers without merging', async () => {
    const email = `player-${randomUUID()}@example.com`;
    const discordId = `discord-${randomUUID()}`;

    const discordAccount = await service.registerAccount({
      provider: 'discord',
      providerUserId: discordId,
      email
    });

    const emailAccount = await service.registerAccount({
      provider: 'email',
      providerUserId: email,
      email
    });

    assert.notEqual(discordAccount.id, emailAccount.id);
    const accounts = await service.listAccountsByEmail(email);
    assert.equal(accounts.length, 2);
    const providers = new Set(accounts.map((account) => account.provider));
    assert.ok(providers.has('discord'));
    assert.ok(providers.has('email'));
  });

  test('prevents duplicate account registration for same provider identity', async () => {
    const providerUserId = `naver-${randomUUID()}`;
    await service.registerAccount({
      provider: 'naver',
      providerUserId,
      email: `shared-${randomUUID()}@example.com`
    });

    await assert.rejects(
      () =>
        service.registerAccount({
          provider: 'naver',
          providerUserId,
          email: `another-${randomUUID()}@example.com`
        }),
      (error: unknown) => error instanceof ConflictException
    );
  });

  test('rejects linking account groups that each own a Minecraft identity', async () => {
    const first = await service.registerAccount({
      provider: 'discord',
      providerUserId: `discord-${randomUUID()}`,
    });
    const second = await service.registerAccount({
      provider: 'naver',
      providerUserId: `naver-${randomUUID()}`,
    });
    const request = await service.createLinkRequest(first.id, second.id);

    try {
      await prisma.minecraftIdentity.createMany({
        data: [
          {
            accountId: first.id,
            uuid: randomUUID(),
            playerName: 'FirstPlayer',
            msOwned: true,
            lastVerifiedAt: new Date(),
          },
          {
            accountId: second.id,
            uuid: randomUUID(),
            playerName: 'SecondPlayer',
            msOwned: true,
            lastVerifiedAt: new Date(),
          },
        ],
      });

      await assert.rejects(
        () => service.confirmLink(request.id, request.verificationCode),
        (error: unknown) =>
          error instanceof ConflictException &&
          error.message.includes('서로 다른 Minecraft 계정'),
      );
      assert.equal(
        await prisma.accountLink.count({
          where: {
            OR: [
              { primaryAccountId: first.id, linkedAccountId: second.id },
              { primaryAccountId: second.id, linkedAccountId: first.id },
            ],
          },
        }),
        0,
      );
    } finally {
      await prisma.account.deleteMany({ where: { id: { in: [first.id, second.id] } } });
    }
  });

  test('linking accounts revokes every active Wiki API token before authority changes', async () => {
    const first = await service.registerAccount({
      provider: 'discord',
      providerUserId: `discord-${randomUUID()}`,
    });
    const second = await service.registerAccount({
      provider: 'naver',
      providerUserId: `naver-${randomUUID()}`,
    });
    const tokenIds = [randomUUID(), randomUUID()];
    await prisma.wikiApiToken.createMany({
      data: [
        {
          id: tokenIds[0],
          accountId: first.id,
          name: 'first token',
          tokenPrefix: randomUUID().replaceAll('-', '').slice(0, 12),
          secretHash: randomUUID().replaceAll('-', '').padEnd(64, '0').slice(0, 64),
          scopes: ['wiki:read'],
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          id: tokenIds[1],
          accountId: second.id,
          name: 'second token',
          tokenPrefix: randomUUID().replaceAll('-', '').slice(0, 12),
          secretHash: randomUUID().replaceAll('-', '').padEnd(64, '1').slice(0, 64),
          scopes: ['wiki:read'],
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    });

    try {
      await service.linkActiveAccounts(first.id, second.id);
      const tokens = await prisma.wikiApiToken.findMany({
        where: { id: { in: tokenIds } },
        select: { status: true, revokedAt: true },
      });
      assert.equal(tokens.length, 2);
      assert.ok(tokens.every((token) => token.status === 'revoked' && token.revokedAt));
    } finally {
      await prisma.account.deleteMany({ where: { id: { in: [first.id, second.id] } } });
    }
  });

  test('linking an account group preserves an existing Wiki block across every active profile', async () => {
    const first = await service.registerAccount({ provider: 'discord', providerUserId: `discord-${randomUUID()}` });
    const second = await service.registerAccount({ provider: 'naver', providerUserId: `naver-${randomUUID()}` });
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const profiles = await Promise.all([
      prisma.wikiProfile.create({
        data: {
          accountId: first.id, username: `blocked-${suffix}`, displayName: '차단 프로필',
          status: 'blocked', createdAt: new Date(), updatedAt: new Date()
        }
      }),
      prisma.wikiProfile.create({
        data: {
          accountId: second.id, username: `active-${suffix}`, displayName: '활성 프로필',
          status: 'active', createdAt: new Date(), updatedAt: new Date()
        }
      })
    ]);

    try {
      await service.linkActiveAccounts(first.id, second.id);
      const stored = await prisma.wikiProfile.findMany({
        where: { id: { in: profiles.map((profile) => profile.id) } },
        select: { status: true }
      });
      assert.equal(stored.length, 2);
      assert.ok(stored.every((profile) => profile.status === 'blocked'));
    } finally {
      await prisma.wikiProfile.deleteMany({ where: { id: { in: profiles.map((profile) => profile.id) } } });
      await prisma.account.deleteMany({ where: { id: { in: [first.id, second.id] } } });
    }
  });
}
