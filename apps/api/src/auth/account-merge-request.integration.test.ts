import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { SessionService } from '../session/session.service';
import { WikiProfileMergeService } from '../wiki/wiki-profile-merge.service';
import { readCanonicalAccountGroup } from './account-lifecycle-fence';
import { AccountConflictService } from './account-conflict.service';
import { AccountMergeRequestService } from './account-merge-request.service';
import { AccountSeparationService } from './account-separation.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const createdAccountIds: string[] = [];
  const createdTicketIds: string[] = [];
  const createdRequestIds: string[] = [];

  before(async () => prisma.$connect());
  after(async () => {
    await prisma.auditEvent.deleteMany({
      where: {
        OR: [
          { actorAccountId: { in: createdAccountIds } },
          { subjectType: 'account_merge_request', subjectId: { in: createdRequestIds } },
        ],
      },
    });
    await prisma.supportTicket.deleteMany({ where: { id: { in: createdTicketIds } } });
    await prisma.session.deleteMany({ where: { accountId: { in: createdAccountIds } } });
    await prisma.account.deleteMany({ where: { id: { in: createdAccountIds } } });
    await prisma.$disconnect();
  });

  test('reviewed merge makes both login accounts issue sessions for one canonical account', async () => {
    const suffix = randomUUID();
    const sharedEmail = `account-merge-${suffix}@example.com`;
    const sourceId = randomUUID();
    const targetId = randomUUID();
    const adminId = randomUUID();
    createdAccountIds.push(sourceId, targetId, adminId);
    await prisma.account.createMany({
      data: [
        { id: sourceId, canonicalAccountId: sourceId, provider: 'discord', providerUserId: `discord-${suffix}`, email: sharedEmail, emailVerified: true },
        { id: targetId, canonicalAccountId: targetId, provider: 'naver', providerUserId: `naver-${suffix}`, email: sharedEmail, emailVerified: true },
        { id: adminId, canonicalAccountId: adminId, provider: 'email', providerUserId: `admin-${suffix}`, email: `admin-${suffix}@example.com`, emailVerified: true },
      ],
    });

    const sessions = new SessionService(prisma);
    await sessions.issueSession({ userId: sourceId });
    await sessions.issueSession({ userId: targetId });
    assert.equal(await prisma.session.count({ where: { accountId: { in: [sourceId, targetId] } } }), 2);

    const conflictService = new AccountConflictService(prisma, undefined, undefined);
    const created = await conflictService.createMergeRequest(sourceId, {
      message: '두 로그인 수단의 실제 소유권 확인을 요청합니다.',
    });
    createdTicketIds.push(created.ticketId);
    const request = await prisma.accountMergeRequest.findUniqueOrThrow({ where: { ticketId: created.ticketId } });
    createdRequestIds.push(request.id);
    assert.deepEqual(request.candidateTargetAccountIds, [targetId]);

    const mergeService = new AccountMergeRequestService(
      prisma,
      conflictService,
      new AccountSeparationService(prisma),
      new WikiProfileMergeService(prisma, {} as never),
    );
    const result = await mergeService.approve(request.id, adminId, {
      targetCanonicalAccountId: targetId,
      reason: '지원 증거로 양쪽 로그인 수단의 소유권을 확인했습니다.',
      evidenceConfirmed: true,
      version: request.version,
    });

    assert.equal(result.status, 'completed');
    assert.equal(result.targetCanonicalAccountId, targetId);
    assert.equal(await prisma.session.count({ where: { accountId: { in: [sourceId, targetId] } } }), 0);
    assert.equal((await readCanonicalAccountGroup(prisma, sourceId)).canonicalAccountId, targetId);
    assert.equal((await readCanonicalAccountGroup(prisma, targetId)).canonicalAccountId, targetId);

    const sourceLoginSession = await sessions.issueSession({ userId: sourceId });
    const targetLoginSession = await sessions.issueSession({ userId: targetId });
    const stored = await prisma.session.findMany({
      where: { id: { in: [sourceLoginSession.sessionId, targetLoginSession.sessionId] } },
      select: { accountId: true },
    });
    assert.equal(stored.length, 2);
    assert.ok(stored.every((session) => session.accountId === targetId));
    assert.equal((await prisma.supportTicket.findUnique({ where: { id: created.ticketId } }))?.status, 'resolved');
  });
}
