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
}
