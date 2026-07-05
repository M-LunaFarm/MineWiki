import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { ReviewService } from './review.service';
import { PrismaService } from '../common/prisma.service';
import { ServerService } from '../server/server.service';
import { UploadService } from '../upload/upload.service';
import { VoteStore } from '../vote/vote.store';
import { AccountSeparationService } from '../auth/account-separation.service';
import { MinecraftService } from '../minecraft/minecraft.service';
import { BusinessEventService } from '../events/business-event.service';
import type { SessionPayload } from '../session/session.service';
import { WikiProfileService } from '../wiki/wiki-profile.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const config = new ConfigService({} as NodeJS.ProcessEnv);
  const uploads = new UploadService(config);
  const serverService = new ServerService(uploads, prisma, new WikiProfileService(prisma));
  const events = { track: async () => {} } as BusinessEventService;
  const voteStore = new VoteStore(prisma);
  const accounts = new AccountSeparationService(prisma);
  const minecraft = new MinecraftService(events, config, prisma);
  const reviewService = new ReviewService(
    serverService,
    events,
    voteStore,
    minecraft,
    accounts,
    prisma
  );

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  const createAccount = async (displayName = 'Tester') => {
    const email = 'tester-' + randomUUID() + '@example.com';
    return accounts.registerAccount({
      provider: 'email',
      providerUserId: email,
      email,
      displayName,
      emailVerified: true
    });
  };

  const createServer = async (ownerAccountId?: string) => {
    const name = 'Test Server ' + randomUUID().slice(0, 8);
    return serverService.register({
      name,
      joinHost: 'play.example.com',
      joinPort: 25565,
      edition: 'java',
      supportedVersions: ['1.20.1'],
      tags: ['community'],
      shortDescription: 'Test server',
      longDescription: 'Long description',
      websiteUrl: null,
      discordUrl: null,
      ownerAccountId
    });
  };

  const createSession = (accountId: string): SessionPayload => ({
    sessionId: randomUUID(),
    userId: accountId,
    isElevated: false
  });

  const ensureIdentity = async (accountId: string, uuid = randomUUID()) => {
    await prisma.minecraftIdentity.upsert({
      where: { accountId },
      update: { uuid, msOwned: true, lastVerifiedAt: new Date() },
      create: { accountId, uuid, msOwned: true, lastVerifiedAt: new Date() }
    });
    return uuid;
  };

  const recordVote = async (serverId: string, accountId: string, uuid: string, votedAt = new Date()) => {
    await voteStore.record({
      serverId,
      username: 'Tester',
      accountId,
      minecraftUuid: uuid,
      ipAddress: '127.0.0.1',
      votedAt
    });
  };

  test('throws when account information is missing', async () => {
    const server = await createServer();
    const session = createSession(randomUUID());

    await assert.rejects(
      () => reviewService.create(server.id, { rating: 5, body: '???', tags: ['community'] }, session),
      (error: unknown) => error instanceof ForbiddenException
    );
  });

  test('throws when minecraft identity is missing', async () => {
    const account = await createAccount();
    const server = await createServer();
    const session = createSession(account.id);

    await assert.rejects(
      () => reviewService.create(server.id, { rating: 4, body: '???', tags: ['community'] }, session),
      (error: unknown) => error instanceof ForbiddenException
    );
  });

  test('throws when no recent vote exists', async () => {
    const account = await createAccount();
    const server = await createServer();
    const session = createSession(account.id);
    await ensureIdentity(account.id);

    await assert.rejects(
      () => reviewService.create(server.id, { rating: 4, body: '???', tags: ['community'] }, session),
      (error: unknown) => error instanceof ForbiddenException
    );
  });

  test('creates review when gating conditions satisfied', async () => {
    const account = await createAccount();
    const server = await createServer();
    const session = createSession(account.id);
    const uuid = await ensureIdentity(account.id);
    await recordVote(server.id, account.id, uuid);

    const review = await reviewService.create(
      server.id,
      { rating: 5, body: '?? ??!', tags: ['community'] },
      session
    );
    assert.equal(review.rating, 5);
    assert.equal(review.trustLabels.includes('ms_owned'), true);
    assert.equal(review.trustLabels.includes('vote_ack'), true);
    assert.equal(review.isAnonymous, false);
    assert.equal(review.visibility, 'public');
    assert.equal(review.reports, 0);
    assert.equal(review.adminReply, null);
  });

  test('supports anonymous staff-only feedback and reporting', async () => {
    const account = await createAccount();
    const server = await createServer();
    const session = createSession(account.id);
    const uuid = await ensureIdentity(account.id);
    await recordVote(server.id, account.id, uuid);

    const review = await reviewService.create(
      server.id,
      { rating: 4, body: '???? ???', tags: ['staff'], anonymous: true, visibility: 'staff' },
      session
    );
    assert.equal(review.visibility, 'staff');
    assert.equal(review.isAnonymous, true);

    const publicReviews = await reviewService.list(server.id);
    assert.equal(publicReviews.some((item) => item.id === review.id), false);

    const reported = await reviewService.report(server.id, review.id, account.id);
    assert.equal(reported.reports, 1);
    const duplicate = await reviewService.report(server.id, review.id, account.id);
    assert.equal(duplicate.reports, 1);
  });

  test('allows admin reply to be set and cleared', async () => {
    const account = await createAccount();
    const server = await createServer();
    const session = createSession(account.id);
    const uuid = await ensureIdentity(account.id);
    await recordVote(server.id, account.id, uuid);

    const review = await reviewService.create(
      server.id,
      { rating: 5, body: '???', tags: ['community'] },
      session
    );
    const replied = await reviewService.setAdminReply(server.id, review.id, '???', '??????.');
    assert.equal(replied.adminReply?.authorDisplayName, '???');
    assert.equal(replied.adminReply?.body, '??????.');
    const cleared = await reviewService.setAdminReply(server.id, review.id, '???', '   ');
    assert.equal(cleared.adminReply, null);
  });

  test('gate status reflects login and vote state', async () => {
    const account = await createAccount();
    const server = await createServer();
    const session = createSession(account.id);
    const uuid = await ensureIdentity(account.id);

    const anonymous = await reviewService.getGateStatus(server.id);
    assert.equal(anonymous.isLoggedIn, false);
    assert.equal(anonymous.hasRecentVote, false);

    const beforeVote = await reviewService.getGateStatus(server.id, session);
    assert.equal(beforeVote.isLoggedIn, true);
    assert.equal(beforeVote.isMinecraftOwned, true);
    assert.equal(beforeVote.hasRecentVote, false);

    await recordVote(server.id, account.id, uuid, new Date(Date.now() - 1000 * 5));

    const afterVote = await reviewService.getGateStatus(server.id, session);
    assert.equal(afterVote.hasRecentVote, true);
    assert.ok(afterVote.lastVoteAt);
  });
}
