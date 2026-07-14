import { after, afterEach, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { ForbiddenException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { ReviewService } from './review.service';
import { PrismaService } from '../common/prisma.service';
import { ServerService } from '../server/server.service';
import { UploadService } from '../upload/upload.service';
import { FileService } from '../file/file.service';
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
  const files = new FileService(prisma, uploads);
  const serverService = new ServerService(files, prisma, new WikiProfileService(prisma));
  const events = { track: async () => {}, audit: async () => {} } as BusinessEventService;
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
  const createdAccountIds = new Set<string>();
  const createdServerIds = new Set<string>();

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  afterEach(async () => {
    const serverIds = [...createdServerIds];
    const accountIds = [...createdAccountIds];
    if (serverIds.length > 0) {
      await prisma.reviewSubmissionGate.deleteMany({
        where: { serverId: { in: serverIds } }
      });
      await prisma.server.deleteMany({ where: { id: { in: serverIds } } });
    }
    if (accountIds.length > 0) {
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
    createdServerIds.clear();
    createdAccountIds.clear();
  });

  const createAccount = async (displayName = 'Tester') => {
    const email = 'tester-' + randomUUID() + '@example.com';
    const account = await accounts.registerAccount({
      provider: 'email',
      providerUserId: email,
      email,
      displayName,
      emailVerified: true
    });
    createdAccountIds.add(account.id);
    return account;
  };

  const createServer = async (ownerAccountId?: string) => {
    const unique = randomUUID().replace(/-/g, '').slice(0, 12);
    const name = 'Test Server ' + unique.slice(0, 8);
    const server = await serverService.register({
      name,
      joinHost: `review-${unique}.example.com`,
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
    createdServerIds.add(server.id);
    return server;
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

  const createEligibleReview = async () => {
    const author = await createAccount('Review author');
    const server = await createServer();
    const uuid = await ensureIdentity(author.id);
    await recordVote(server.id, author.id, uuid);
    const review = await reviewService.create(
      server.id,
      { rating: 5, body: '도움표시 동시성 테스트 리뷰', tags: ['community'] },
      createSession(author.id)
    );
    return { review, server };
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
    const countedServer = await prisma.server.findUniqueOrThrow({ where: { id: server.id } });
    assert.equal(countedServer.reviewsCount, 1);
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
    const staffOnlyServer = await prisma.server.findUniqueOrThrow({ where: { id: server.id } });
    assert.equal(staffOnlyServer.reviewsCount, 0);

    const publicReviews = await reviewService.list(server.id);
    assert.equal(publicReviews.some((item) => item.id === review.id), false);

    const reported = await reviewService.report(server.id, review.id, account.id, '운영 정책 위반');
    assert.equal(reported.reports, 1);
    const duplicate = await reviewService.report(server.id, review.id, account.id, '중복 신고');
    assert.equal(duplicate.reports, 1);
  });

  test('removing a review decrements only the public review counter', async () => {
    const account = await createAccount();
    const server = await createServer();
    const session = createSession(account.id);
    const uuid = await ensureIdentity(account.id);
    await recordVote(server.id, account.id, uuid);
    const review = await reviewService.create(
      server.id,
      { rating: 5, body: '삭제할 공개 리뷰', tags: ['community'] },
      session
    );

    await reviewService.remove(server.id, review.id, session);

    const countedServer = await prisma.server.findUniqueOrThrow({ where: { id: server.id } });
    assert.equal(countedServer.reviewsCount, 0);
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

  test('serializes concurrent helpful marks from the same voter', async () => {
    const { review, server } = await createEligibleReview();
    const voter = await createAccount('Helpful voter');
    await prisma.reviewHelpfulVote.create({
      data: {
        reviewId: review.id,
        accountId: voter.id,
        isHelpful: false,
        lastMarkedAt: new Date(Date.now() - 10 * 60 * 1000)
      }
    });

    const attempts = await Promise.allSettled([
      reviewService.markHelpful(server.id, review.id, voter.id, true),
      reviewService.markHelpful(server.id, review.id, voter.id, true)
    ]);
    assert.equal(attempts.filter((attempt) => attempt.status === 'fulfilled').length, 1);
    const rejected = attempts.find((attempt) => attempt.status === 'rejected');
    assert.ok(rejected?.status === 'rejected' && rejected.reason instanceof ForbiddenException);

    const [storedReview, activeVotes] = await Promise.all([
      prisma.serverReview.findUniqueOrThrow({ where: { id: review.id } }),
      prisma.reviewHelpfulVote.count({ where: { reviewId: review.id, isHelpful: true } })
    ]);
    assert.equal(activeVotes, 1);
    assert.equal(storedReview.helpfulCount, activeVotes);
  });

  test('keeps helpfulCount exact during concurrent true and false transitions', async () => {
    const { review, server } = await createEligibleReview();
    const [upVoter, downVoter] = await Promise.all([
      createAccount('Helpful up voter'),
      createAccount('Helpful down voter')
    ]);
    const beforeCooldown = new Date(Date.now() - 10 * 60 * 1000);
    await prisma.reviewHelpfulVote.createMany({
      data: [
        {
          reviewId: review.id,
          accountId: upVoter.id,
          isHelpful: false,
          lastMarkedAt: beforeCooldown
        },
        {
          reviewId: review.id,
          accountId: downVoter.id,
          isHelpful: true,
          lastMarkedAt: beforeCooldown
        }
      ]
    });
    await prisma.serverReview.update({
      where: { id: review.id },
      data: { helpfulCount: 1 }
    });

    await Promise.all([
      reviewService.markHelpful(server.id, review.id, upVoter.id, true),
      reviewService.markHelpful(server.id, review.id, downVoter.id, false)
    ]);

    const [storedReview, activeVotes] = await Promise.all([
      prisma.serverReview.findUniqueOrThrow({ where: { id: review.id } }),
      prisma.reviewHelpfulVote.count({ where: { reviewId: review.id, isHelpful: true } })
    ]);
    assert.equal(activeVotes, 1);
    assert.equal(storedReview.helpfulCount, activeVotes);
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
