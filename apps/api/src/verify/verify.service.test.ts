import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { ConfigService } from '@minewiki/config';
import { PrismaService } from '../common/prisma.service';
import type { BusinessEventService } from '../events/business-event.service';
import { VerifyService } from './verify.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const config = {
    getOptional(key: string) {
      if (key === 'VERIFY_PUBLIC_BASE_URL') {
        return 'https://minewiki.test';
      }
      return undefined;
    }
  } as unknown as ConfigService;
  const events = { track: async () => {} } as BusinessEventService;
  const service = new VerifyService(prisma, config, events);

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  test('discord verification completion persists canonical and guild records', async () => {
    const unique = randomUUID().replace(/-/g, '').slice(0, 12);
    const guildId = `guild-${unique}`;
    const channelId = `channel-${unique}`;
    const discordUserId = `discord-${unique}`;
    const minecraftUuid = randomUUID();
    let accountId: string | null = null;
    let sessionId: string | null = null;

    try {
      const account = await prisma.account.create({
        data: {
          provider: 'email',
          providerUserId: `verify-${unique}`,
          email: `verify-${unique}@example.com`,
          displayName: `Verifier_${unique}`,
          emailVerified: true
        }
      });
      accountId = account.id;
      await prisma.minecraftIdentity.create({
        data: {
          accountId: account.id,
          uuid: minecraftUuid,
          playerName: 'Tester',
          msOwned: true,
          lastVerifiedAt: new Date()
        }
      });

      const session = await service.createDiscordSession({
        guildId,
        channelId,
        requesterDiscordId: discordUserId
      });
      sessionId = session.sessionId;
      const completionToken = new URL(session.verificationUrl).searchParams.get('verifyToken');
      assert.ok(completionToken);

      const completed = await service.completeDiscordSession(session.sessionId, account.id, {
        completionToken,
        minecraftUuid,
        playerName: 'Tester'
      });

      assert.equal(completed.sessionId, session.sessionId);
      assert.equal(completed.status, 'sync_pending');
      assert.ok(completed.verificationUrl.includes(session.sessionId));

      const identity = await prisma.minecraftIdentity.findFirst({
        where: { accountId: account.id }
      });
      assert.equal(identity?.uuid, minecraftUuid);
      assert.equal(identity?.playerName, 'Tester');

      const guild = await prisma.lunaGuild.findUnique({ where: { guildId } });
      assert.equal(guild?.guildId, guildId);
      const channel = await prisma.lunaGuildChannelSetting.findUnique({
        where: { guildId_channelId: { guildId, channelId } }
      });
      assert.equal(channel?.channelId, channelId);
      const link = await prisma.lunaDiscordAccountLink.findUnique({
        where: { discordUserId }
      });
      assert.equal(link?.minecraftUuid, minecraftUuid);
      const guildVerification = await prisma.lunaGuildVerification.findUnique({
        where: { guildId_discordUserId: { guildId, discordUserId } }
      });
      assert.equal(guildVerification?.status, 'verified');
    } finally {
      await prisma.lunaEvent.deleteMany({ where: { guildId } });
      await prisma.lunaPrivacyConsent.deleteMany({ where: { discordUserId } });
      await prisma.lunaGuildVerification.deleteMany({ where: { guildId } });
      await prisma.lunaDiscordAccountLink.deleteMany({ where: { discordUserId } });
      await prisma.lunaGuildChannelSetting.deleteMany({ where: { guildId } });
      await prisma.lunaGuild.deleteMany({ where: { guildId } });
      if (sessionId) {
        await prisma.discordVerificationSession.delete({ where: { id: sessionId } }).catch(() => {});
      }
      if (accountId) {
        await prisma.minecraftIdentity.deleteMany({ where: { accountId } });
        await prisma.account.delete({ where: { id: accountId } }).catch(() => {});
      }
    }
  });
}
