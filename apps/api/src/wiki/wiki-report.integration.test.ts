import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { PrismaService } from '../common/prisma.service';
import { RoleService } from '../roles/role.service';
import type { SessionPayload } from '../session/session.service';
import { WikiAclService } from './wiki-acl.service';
import { WikiPermissionService } from './wiki-permission.service';
import { WikiProfileService } from './wiki-profile.service';
import { WikiReportModerationService } from './wiki-report-moderation.service';
import { WikiReportService } from './wiki-report.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('wiki report database integration', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const profiles = new WikiProfileService(prisma);
  const permissions = new WikiPermissionService(prisma, new WikiAclService(prisma));
  const reports = new WikiReportService(prisma, profiles, permissions);
  const moderation = new WikiReportModerationService(prisma, profiles, new RoleService(prisma));

  before(async () => prisma.$connect());
  after(async () => prisma.$disconnect());

  test('concurrent intake is exact and finalization permits a later active case', async () => {
    const suffix = randomUUID().replaceAll('-', '').slice(0, 16);
    const accountIds = [randomUUID(), randomUUID(), randomUUID()];
    const now = new Date();
    await prisma.account.createMany({
      data: accountIds.map((id, index) => ({
        id,
        canonicalAccountId: id,
        provider: 'email' as const,
        providerUserId: `wiki-report-${suffix}-${index}@example.com`,
        email: `wiki-report-${suffix}-${index}@example.com`,
        emailVerified: true,
      })),
    });
    const profileRows: Array<{ readonly id: bigint }> = [];
    for (const [index, accountId] of accountIds.entries()) {
      profileRows.push(await prisma.wikiProfile.create({
        data: {
          accountId,
          username: `report_${suffix}_${index}`,
          displayName: `신고 통합 테스트 ${index}`,
          status: 'active',
          createdAt: now,
          updatedAt: now,
        },
      }));
    }
    const namespace = await prisma.wikiNamespace.create({
      data: {
        code: `rpt_${suffix}`,
        displayName: '신고 통합 테스트',
        pathPrefix: `rpt-${suffix}`,
      },
    });
    const space = await prisma.wikiSpace.create({
      data: {
        code: `report-${suffix}`,
        name: '신고 통합 테스트',
        title: '신고 통합 테스트',
        rootNamespaceCode: namespace.code,
        rootPath: `report-${suffix}`,
        status: 'active',
        createdAt: now,
        updatedAt: now,
      },
    });
    const page = await prisma.wikiPage.create({
      data: {
        namespaceId: namespace.id,
        spaceId: space.id,
        localPath: `target-${suffix}`,
        slug: `target-${suffix}`,
        title: '신고 대상',
        displayTitle: '신고 대상',
        protectionLevel: 'open',
        status: 'normal',
        createdAt: now,
        updatedAt: now,
      },
    });
    const targetId = page.id.toString();
    const input = { targetType: 'page', targetId, reason: '동시성 통합 테스트 신고입니다.' };
    const createdCaseIds: string[] = [];

    try {
      const receipts = await Promise.all([
        reports.report(session(accountIds[0]!), input),
        reports.report(session(accountIds[0]!), input),
        reports.report(session(accountIds[1]!), input),
      ]);
      for (const receipt of receipts) {
        assert.equal(receipt.reportCount, 1);
        assert.equal('version' in receipt, false);
      }
      assert.equal(new Set(receipts.map((receipt) => receipt.caseId)).size, 1);
      assert.equal(receipts.filter((receipt) => receipt.deduplicated).length, 1);

      const activeCase = await prisma.wikiReportCase.findUniqueOrThrow({
        where: { activeKey: `page:${targetId}` },
      });
      createdCaseIds.push(activeCase.id);
      assert.equal(activeCase.reportCount, 2);
      assert.equal(activeCase.version, 2);
      assert.equal(await prisma.wikiReportSubmission.count({ where: { caseId: activeCase.id } }), 2);

      const finalized = await moderation.transition(
        activeCase.id,
        session(accountIds[2]!, ['wiki.report.moderate']),
        { expectedVersion: activeCase.version, status: 'resolved', resolution: '통합 테스트 처리 완료' },
      );
      assert.equal(finalized.status, 'resolved');
      assert.equal(finalized.reportCount, 2);
      assert.equal(
        (await prisma.wikiReportCase.findUniqueOrThrow({ where: { id: activeCase.id } })).activeKey,
        null,
      );
      assert.equal(await prisma.auditEvent.count({
        where: { action: 'wiki.report.resolved', subjectType: 'wiki_report_case', subjectId: activeCase.id },
      }), 1);

      const laterReceipt = await reports.report(session(accountIds[0]!), {
        ...input,
        reason: '종결 후 새로 발생한 문제입니다.',
      });
      createdCaseIds.push(laterReceipt.caseId);
      assert.notEqual(laterReceipt.caseId, activeCase.id);
      const laterCase = await prisma.wikiReportCase.findUniqueOrThrow({ where: { id: laterReceipt.caseId } });
      assert.equal(laterCase.activeKey, `page:${targetId}`);
      assert.equal(laterCase.reportCount, 1);
    } finally {
      if (createdCaseIds.length > 0) {
        await prisma.auditEvent.deleteMany({
          where: { subjectType: 'wiki_report_case', subjectId: { in: createdCaseIds } },
        });
      }
      await prisma.wikiReportCase.deleteMany({ where: { targetType: 'page', targetId: page.id } });
      await prisma.wikiPage.delete({ where: { id: page.id } }).catch(() => undefined);
      await prisma.wikiSpace.delete({ where: { id: space.id } }).catch(() => undefined);
      await prisma.wikiNamespace.delete({ where: { id: namespace.id } }).catch(() => undefined);
      await prisma.wikiProfile.deleteMany({ where: { id: { in: profileRows.map((profile) => profile.id) } } });
      await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
    }
  });
}

function session(accountId: string, permissions: string[] = []): SessionPayload {
  return {
    sessionId: randomUUID(),
    userId: accountId,
    tokenVersion: 1,
    isElevated: permissions.length > 0,
    authenticatedAt: new Date().toISOString(),
    permissions,
    groups: [],
  };
}
