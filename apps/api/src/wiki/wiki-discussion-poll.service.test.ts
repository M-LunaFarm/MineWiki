import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { BadRequestException, ConflictException } from '@nestjs/common';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import type { WikiPermissionService } from './wiki-permission.service';
import type { WikiProfileService } from './wiki-profile.service';
import { WikiDiscussionService } from './wiki-discussion.service';

const session = { userId: 'account-1' } as SessionPayload;
const now = new Date('2026-07-15T00:00:00.000Z');
const page = {
  id: 10n, namespaceId: 1, spaceId: 2n, localPath: 'polls', slug: 'polls', title: 'Polls', displayTitle: 'Polls',
  currentRevisionId: 1n, pageType: 'article', protectionLevel: 'open', status: 'normal', createdBy: 20n,
  createdAt: now, updatedAt: now
};
const thread = { id: 30n, pageId: page.id, title: '설문 토론', status: 'open', createdBy: 20n, pinnedCommentId: null, createdAt: now, updatedAt: now };
const comment = { id: 40n, threadId: thread.id, content: '의견', status: 'normal', createdBy: 20n, createdAt: now, updatedAt: null };
const poll = { id: 50n, commentId: comment.id, question: '어느 쪽인가요', status: 'open', resultsVisibility: 'after_vote', createdBy: 20n, closesAt: null, closedAt: null, createdAt: now, updatedAt: now };

function profiles(): WikiProfileService {
  return { async ensureWikiProfile() { return { id: 20n }; } } as unknown as WikiProfileService;
}

function permissions(): WikiPermissionService {
  return {
    actorFromSession() { return { accountId: session.userId, profileId: 20n }; },
    async assertCanReadPage() {},
    async assertCanCreateThread() {},
    async assertCanWriteThreadComment() {},
    async canManagePage() { return false; }
  } as unknown as WikiPermissionService;
}

test('poll creation rejects normalized duplicate choices before poll persistence', async () => {
  let pollCreated = false;
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async create() { return thread; } },
    wikiDiscussionComment: { async create() { return comment; } },
    wikiDiscussionPoll: { async create() { pollCreated = true; return poll; } },
    wikiDiscussionPollOption: { async createMany() { return { count: 2 }; } },
    wikiDiscussionSubscription: { async create() { return {}; } },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const service = new WikiDiscussionService(store as unknown as PrismaService, profiles(), permissions());

  await assert.rejects(service.createThread(session, page.id.toString(), {
    title: '설문',
    content: '첫 의견',
    poll: { question: '선택', options: [' Java ', 'ｊａｖａ'] }
  }), BadRequestException);
  assert.equal(pollCreated, false);
});

test('thetree vote macro creates one structured poll in the comment transaction', async () => {
  let pollData: Record<string, unknown> | null = null;
  let optionData: readonly Record<string, unknown>[] = [];
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async create() { return thread; } },
    wikiDiscussionComment: { async create() { return comment; } },
    wikiDiscussionPoll: {
      async create({ data }: { data: Record<string, unknown> }) { pollData = data; return poll; },
    },
    wikiDiscussionPollOption: {
      async createMany({ data }: { data: readonly Record<string, unknown>[] }) { optionData = data; return { count: data.length }; },
    },
    wikiDiscussionSubscription: { async create() { return {}; } },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); },
  };
  const discussion = new WikiDiscussionService(store as unknown as PrismaService, profiles(), permissions());
  discussion.getThread = async () => ({ id: thread.id.toString(), comments: [] }) as never;

  await discussion.createThread(session, page.id.toString(), {
    title: '버전 투표',
    content: '다음 버전은? [vote(선호 버전,1.20,1.21)]',
  });

  assert.equal(pollData?.question, '선호 버전');
  assert.equal(pollData?.resultsVisibility, 'always');
  assert.deepEqual(optionData.map((option) => option.label), ['1.20', '1.21']);
});

test('vote macro rejects ambiguous, malformed, and duplicate poll declarations', async () => {
  let commentWrites = 0;
  const store = {
    wikiPage: { async findUnique() { return page; } },
    wikiDiscussionThread: { async create() { return thread; } },
    wikiDiscussionComment: { async create() { commentWrites += 1; return comment; } },
    wikiDiscussionPoll: { async create() { return poll; } },
    wikiDiscussionPollOption: { async createMany() { return { count: 2 }; } },
    wikiDiscussionSubscription: { async create() { return {}; } },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); },
  };
  const discussion = new WikiDiscussionService(store as unknown as PrismaService, profiles(), permissions());

  await assert.rejects(() => discussion.createThread(session, page.id.toString(), {
    title: '중복', content: '[vote(Q,A,B)] [vote(Q2,C,D)]',
  }), /only one vote macro/i);
  await assert.rejects(() => discussion.createThread(session, page.id.toString(), {
    title: '명시 중복', content: '[vote(Q,A,B)]', poll: { question: '별도', options: ['A', 'B'] },
  }), /either a vote macro/i);
  await assert.rejects(() => discussion.createThread(session, page.id.toString(), {
    title: '선택지 부족', content: '[vote(Q,A)]',
  }), /between 2 and 10 choices/i);
  assert.equal(commentWrites, 1);
});

test('after-vote poll results hide every aggregate from readers and reveal only after voting', async () => {
  function store(viewerHasVoted: boolean) {
    return {
      wikiPage: { async findUnique() { return page; } },
      wikiDiscussionThread: { async findUnique() { return thread; } },
      wikiDiscussionComment: { async findMany() { return [comment]; }, async count() { return 1; } },
      wikiDiscussionSubscription: { async findUnique() { return null; } },
      wikiDiscussionPoll: { async findMany() { return [poll]; } },
      wikiDiscussionPollOption: { async findMany() { return [
        { id: 51n, pollId: poll.id, position: 0, label: '찬성' },
        { id: 52n, pollId: poll.id, position: 1, label: '반대' }
      ]; } },
      wikiDiscussionPollVote: {
        async groupBy() { return [
          { pollId: poll.id, optionId: 51n, _count: { _all: 3 } },
          { pollId: poll.id, optionId: 52n, _count: { _all: 1 } }
        ]; },
        async findMany() { return viewerHasVoted ? [{ pollId: poll.id, optionId: 51n }] : []; }
      },
      wikiProfile: { async findMany() { return [{ id: 20n, displayName: '테스터' }]; } }
    };
  }

  const anonymous = await new WikiDiscussionService(store(false) as unknown as PrismaService, profiles(), permissions()).getThread('30');
  assert.equal(anonymous.comments[0]?.poll?.resultsVisible, false);
  assert.equal(anonymous.comments[0]?.poll?.totalVoteCount, null);
  assert.deepEqual(anonymous.comments[0]?.poll?.options.map((option) => option.voteCount), [null, null]);

  const voter = await new WikiDiscussionService(store(true) as unknown as PrismaService, profiles(), permissions()).getThread('30', session);
  assert.equal(voter.comments[0]?.poll?.resultsVisible, true);
  assert.equal(voter.comments[0]?.poll?.totalVoteCount, 4);
  assert.equal(voter.comments[0]?.poll?.selectedOptionId, '51');
});

test('vote rechecks the locked thread and cannot commit after the discussion closes', async () => {
  let threadReads = 0;
  let lockCount = 0;
  let upserted = false;
  const store = {
    wikiDiscussionPoll: { async findUnique() { return poll; } },
    wikiDiscussionComment: { async findUnique() { return comment; } },
    wikiDiscussionThread: { async findUnique() { threadReads += 1; return threadReads === 1 ? thread : { ...thread, status: 'closed' }; } },
    wikiDiscussionPollOption: { async findFirst() { return { id: 51n, pollId: poll.id }; } },
    wikiDiscussionPollVote: { async upsert() { upserted = true; return {}; } },
    wikiPage: { async findUnique() { return page; } },
    async $queryRaw() { lockCount += 1; return []; },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const service = new WikiDiscussionService(store as unknown as PrismaService, profiles(), permissions());

  await assert.rejects(service.votePoll(session, '30', '50', '51'), ConflictException);
  assert.equal(lockCount, 3);
  assert.equal(upserted, false);
});

test('vote rechecks the locked thread and cannot commit while the discussion is paused', async () => {
  let threadReads = 0;
  let upserted = false;
  const store = {
    wikiDiscussionPoll: { async findUnique() { return poll; } },
    wikiDiscussionComment: { async findUnique() { return comment; } },
    wikiDiscussionThread: { async findUnique() { threadReads += 1; return threadReads === 1 ? thread : { ...thread, status: 'paused' }; } },
    wikiDiscussionPollOption: { async findFirst() { return { id: 51n, pollId: poll.id }; } },
    wikiDiscussionPollVote: { async upsert() { upserted = true; return {}; } },
    wikiPage: { async findUnique() { return page; } },
    async $queryRaw() { return []; },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const service = new WikiDiscussionService(store as unknown as PrismaService, profiles(), permissions());

  await assert.rejects(
    service.votePoll(session, '30', '50', '51'),
    (error: unknown) => error instanceof ConflictException && error.message === 'Wiki discussion thread is paused.'
  );
  assert.equal(upserted, false);
});

test('comment creation rechecks the locked thread and cannot cross a concurrent close', async () => {
  let threadReads = 0;
  let commentCreated = false;
  const store = {
    wikiDiscussionThread: { async findUnique() { threadReads += 1; return threadReads === 1 ? thread : { ...thread, status: 'closed' }; } },
    wikiDiscussionComment: { async create() { commentCreated = true; return comment; } },
    wikiDiscussionSubscription: { async upsert() { return {}; } },
    wikiPage: { async findUnique() { return page; } },
    async $queryRaw() { return []; },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const service = new WikiDiscussionService(store as unknown as PrismaService, profiles(), permissions());

  await assert.rejects(service.addComment(session, '30', { content: '경합 댓글' }), BadRequestException);
  assert.equal(commentCreated, false);
});

test('vote rejects an option from another poll after acquiring lifecycle locks', async () => {
  let upserted = false;
  const store = {
    wikiDiscussionPoll: { async findUnique() { return poll; } },
    wikiDiscussionComment: { async findUnique() { return comment; } },
    wikiDiscussionThread: { async findUnique() { return thread; } },
    wikiDiscussionPollOption: { async findFirst() { return null; } },
    wikiDiscussionPollVote: { async upsert() { upserted = true; return {}; } },
    wikiPage: { async findUnique() { return page; } },
    async $queryRaw() { return []; },
    async $transaction(callback: (tx: unknown) => Promise<unknown>) { return callback(store); }
  };
  const service = new WikiDiscussionService(store as unknown as PrismaService, profiles(), permissions());

  await assert.rejects(service.votePoll(session, '30', '50', '999'), BadRequestException);
  assert.equal(upserted, false);
});

test('real database keeps one ballot during concurrent changes and rejects votes after close', {
  skip: process.env.DATABASE_URL?.trim() ? false : 'DATABASE_URL is not configured.'
}, async (context) => {
  const db = new PrismaService();
  await db.$connect();
  const targetPage = await db.wikiPage.findFirst({ where: { status: { not: 'deleted' } }, orderBy: { id: 'asc' } });
  if (!targetPage) {
    context.skip('A seeded wiki page is required for the integration check.');
    await db.$disconnect();
    return;
  }
  const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
  const createdAt = new Date();
  const creator = await db.wikiProfile.create({
    data: { username: `poll-creator-${suffix}`, displayName: '설문 작성자', status: 'active', createdAt, updatedAt: createdAt }
  });
  const voter = await db.wikiProfile.create({
    data: { username: `poll-voter-${suffix}`, displayName: '설문 참여자', status: 'active', createdAt, updatedAt: createdAt }
  });
  const creatorProfiles = { async ensureWikiProfile() { return creator; } } as unknown as WikiProfileService;
  const voterProfiles = { async ensureWikiProfile() { return voter; } } as unknown as WikiProfileService;
  const allowed = permissions();
  const creatorService = new WikiDiscussionService(db, creatorProfiles, allowed);
  const voterService = new WikiDiscussionService(db, voterProfiles, allowed);
  let createdThreadId: bigint | null = null;
  let pollId: bigint | null = null;
  try {
    const detail = await creatorService.createThread(
      { userId: `creator-${suffix}` } as SessionPayload,
      targetPage.id.toString(),
      {
        title: `동시성 설문 ${suffix}`,
        content: '설문 선택 변경을 검증합니다.',
        poll: { question: '선택하세요', options: ['첫 번째', '두 번째'], resultsVisibility: 'after_vote' }
      }
    );
    createdThreadId = BigInt(detail.id);
    const createdPoll = detail.comments[0]?.poll;
    assert.ok(createdPoll);
    pollId = BigInt(createdPoll.id);
    const [firstOption, secondOption] = createdPoll.options;
    assert.ok(firstOption && secondOption);
    const voterSession = { userId: `voter-${suffix}` } as SessionPayload;

    await Promise.all([
      voterService.votePoll(voterSession, detail.id, createdPoll.id, firstOption.id),
      voterService.votePoll(voterSession, detail.id, createdPoll.id, secondOption.id)
    ]);
    const ballots = await db.wikiDiscussionPollVote.findMany({ where: { pollId: BigInt(createdPoll.id), profileId: voter.id } });
    assert.equal(ballots.length, 1);
    assert.ok([firstOption.id, secondOption.id].includes(ballots[0]?.optionId.toString() ?? ''));

    await creatorService.closePoll({ userId: `creator-${suffix}` } as SessionPayload, detail.id, createdPoll.id);
    await assert.rejects(
      voterService.votePoll(voterSession, detail.id, createdPoll.id, firstOption.id),
      ConflictException
    );
  } finally {
    if (pollId) {
      await db.wikiDiscussionPollVote.deleteMany({ where: { pollId } });
      await db.wikiDiscussionPollOption.deleteMany({ where: { pollId } });
      await db.wikiDiscussionPoll.deleteMany({ where: { id: pollId } });
    }
    if (createdThreadId) {
      await db.wikiDiscussionSubscription.deleteMany({ where: { threadId: createdThreadId } });
      await db.wikiDiscussionComment.deleteMany({ where: { threadId: createdThreadId } });
      await db.wikiDiscussionThread.deleteMany({ where: { id: createdThreadId } });
    }
    await db.wikiProfile.deleteMany({ where: { id: { in: [creator.id, voter.id] } } });
    await db.$disconnect();
  }
});
