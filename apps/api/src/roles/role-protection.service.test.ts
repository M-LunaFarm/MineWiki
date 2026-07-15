import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { BusinessEventService } from '../events/business-event.service';
import { PrismaService } from '../common/prisma.service';
import { MfaService } from '../auth/mfa.service';
import { SessionService } from '../session/session.service';
import { totpCodeAt } from '../auth/totp';
import { RoleService } from './role.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const sessions = new SessionService(prisma);
  const events = new BusinessEventService(prisma);
  const mfa = new MfaService(prisma, sessions, events);
  const roles = new RoleService(prisma);

  before(async () => {
    await prisma.$connect();
    for (const [code, displayName] of [
      ['owner', '소유자'],
      ['admin', '관리자'],
      ['wiki_admin', '위키 관리자'],
    ] as const) {
      await prisma.globalRole.upsert({
        where: { code },
        update: {},
        create: { code, displayName },
      });
    }
  });
  after(async () => prisma.$disconnect());

  test('protected roles are stored on the canonical account and linked self-grants are rejected', async () => {
    const actorId = await createAccount('actor');
    const actorAliasId = await createAccount('actor-alias', actorId);
    const targetId = await createAccount('target');
    const targetAliasId = await createAccount('target-alias', targetId);
    try {
      await enableCredential(actorId);
      await enableCredential(targetId);

      const access = await roles.assignRole(targetAliasId, 'wiki_admin', {
        actorAccountId: actorId,
      });
      assert.ok(access.roles.includes('wiki_admin'));
      const role = await prisma.globalRole.findUniqueOrThrow({ where: { code: 'wiki_admin' } });
      assert.ok(await prisma.accountRole.findUnique({
        where: { accountId_roleId: { accountId: targetId, roleId: role.id } },
      }));
      assert.equal(await prisma.accountRole.findUnique({
        where: { accountId_roleId: { accountId: targetAliasId, roleId: role.id } },
      }), null);

      await assert.rejects(
        roles.assignRole(actorAliasId, 'wiki_admin', { actorAccountId: actorId }),
        /자기 계정 그룹/u,
      );
    } finally {
      await cleanupAccounts([actorAliasId, targetAliasId, actorId, targetId]);
    }
  });

  test('protected role assignment and MFA disable cannot violate the shared invariant', async () => {
    const actorId = await createAccount('race-actor');
    const targetId = await createAccount('race-target');
    try {
      const issued = await sessions.issueSession({ userId: targetId });
      const initial = sessions.toPayload(
        (await sessions.getSessionByToken(tokenFromCookie(issued.cookie)))!,
      );
      const enrolledAt = new Date();
      const enrollment = await mfa.beginTotpEnrollment(initial, enrolledAt);
      const confirmed = await mfa.confirmTotpEnrollment(
        initial,
        totpCodeAt(enrollment.secret, enrolledAt.getTime()),
        enrolledAt,
      );
      const confirmedPayload = sessions.toPayload(
        (await sessions.getSessionByToken(tokenFromCookie(confirmed.session.cookie)))!,
      );
      const stepAt = new Date(enrolledAt.getTime() + 30_000);
      const stepped = await mfa.stepUp(
        confirmedPayload,
        {
          method: 'totp',
          purpose: 'mfa_manage',
          code: totpCodeAt(enrollment.secret, stepAt.getTime()),
        },
        stepAt,
      );
      const steppedPayload = sessions.toPayload(
        (await sessions.getSessionByToken(tokenFromCookie(stepped.session.cookie)))!,
      );

      const outcomes = await Promise.allSettled([
        roles.assignRole(targetId, 'admin', { actorAccountId: actorId }),
        mfa.disableTotp(steppedPayload),
      ]);
      assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
      assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);

      const adminRole = await prisma.globalRole.findUniqueOrThrow({ where: { code: 'admin' } });
      const [credential, assignment] = await Promise.all([
        prisma.mfaTotpCredential.findUnique({ where: { accountId: targetId } }),
        prisma.accountRole.findUnique({
          where: { accountId_roleId: { accountId: targetId, roleId: adminRole.id } },
        }),
      ]);
      assert.equal(Boolean(credential?.enabledAt), Boolean(assignment));
    } finally {
      await cleanupAccounts([actorId, targetId]);
    }
  });

  test('linked aliases cannot inflate the final canonical owner count', async () => {
    const ownerId = await createAccount('last-owner');
    const ownerAliasId = await createAccount('last-owner-alias', ownerId);
    try {
      const ownerRole = await prisma.globalRole.findUniqueOrThrow({ where: { code: 'owner' } });
      await prisma.accountRole.create({
        data: { accountId: ownerAliasId, roleId: ownerRole.id },
      });
      await assert.rejects(
        roles.removeRole(ownerAliasId, 'owner'),
        /last owner/i,
      );
      assert.ok(await prisma.accountRole.findUnique({
        where: { accountId_roleId: { accountId: ownerAliasId, roleId: ownerRole.id } },
      }));
    } finally {
      await cleanupAccounts([ownerAliasId, ownerId]);
    }
  });

  async function createAccount(label: string, canonicalAccountId?: string): Promise<string> {
    const id = randomUUID();
    await prisma.account.create({
      data: {
        id,
        canonicalAccountId: canonicalAccountId ?? id,
        provider: 'email',
        providerUserId: `role-protection-${label}-${id}`,
        email: `role-protection-${label}-${id}@example.com`,
        emailVerified: true,
      },
    });
    return id;
  }

  async function enableCredential(accountId: string): Promise<void> {
    await prisma.mfaTotpCredential.create({
      data: {
        accountId,
        secretCiphertext: 'role-protection-test-secret',
        enabledAt: new Date(),
      },
    });
  }

  async function cleanupAccounts(accountIds: readonly string[]): Promise<void> {
    await prisma.auditEvent.deleteMany({ where: { actorAccountId: { in: [...accountIds] } } });
    for (const accountId of accountIds) {
      await prisma.account.delete({ where: { id: accountId } }).catch(() => undefined);
    }
  }
}

function tokenFromCookie(cookie: string): string {
  const value = cookie.split(';', 1)[0]?.split('=', 2)[1];
  assert.ok(value);
  return decodeURIComponent(value);
}
