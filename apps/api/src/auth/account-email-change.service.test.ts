import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { Algorithm, hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../common/prisma.service';
import { AccountEmailChangeService } from './account-email-change.service';
import type { SessionPayload } from '../session/session.service';
import { runWithFullHttpRequestContext } from '../common/http/request-context';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const deliveries: Array<{ email: string; token: string }> = [];
  const notices: Array<{ email: string; newEmailMasked: string }> = [];
  const mail = {
    isEnabled: () => true,
    async sendContactEmailChangeVerificationEmail(input: { email: string; token: string }) { deliveries.push(input); },
    async sendContactEmailChangedNotice(input: { email: string; newEmailMasked: string }) { notices.push(input); },
    logDeliveryFailure() {},
  };
  const service = new AccountEmailChangeService(prisma, mail as never);

  before(async () => prisma.$connect());
  after(async () => prisma.$disconnect());

  test('verified contact email confirmation updates identity and revokes group credentials atomically', async () => {
    const accountId = randomUUID();
    const sessionId = randomUUID();
    const suffix = randomUUID().replaceAll('-', '').slice(0, 12);
    const oldEmail = `contact-old-${suffix}@example.com`;
    const newEmail = `contact-new-${suffix}@example.com`;
    const passwordHash = await hash('CurrentPW1!', {
      memoryCost: 19456, timeCost: 2, parallelism: 1, outputLen: 32, algorithm: Algorithm.Argon2id,
    });
    deliveries.length = 0;
    notices.length = 0;
    try {
      await prisma.account.create({ data: {
        id: accountId,
        canonicalAccountId: accountId,
        provider: 'email',
        providerUserId: oldEmail,
        email: oldEmail,
        emailVerified: true,
        passwordHash,
      } });
      const profile = await prisma.wikiProfile.create({ data: {
        accountId,
        username: `contact_${suffix}`,
        displayName: 'Contact test',
        email: oldEmail,
        emailVerifiedAt: new Date(),
        status: 'active',
        createdAt: new Date(),
        updatedAt: new Date(),
      } });
      await prisma.session.create({ data: {
        id: sessionId,
        accountId,
        token: `contact-session-${suffix}`,
        issuedAt: new Date(),
        expiresAt: new Date(Date.now() + 3_600_000),
        tokenVersion: 1,
        lastActiveAt: new Date(),
      } });
      await prisma.passwordReset.create({ data: {
        token: `contact-reset-${suffix}`, accountId, email: oldEmail, expiresAt: new Date(Date.now() + 3_600_000),
      } });
      await prisma.emailVerification.create({ data: {
        token: `contact-verify-${suffix}`, accountId, email: oldEmail, expiresAt: new Date(Date.now() + 3_600_000),
      } });
      const session = {
        sessionId, userId: accountId, tokenVersion: 1, isElevated: false,
        authenticatedAt: new Date().toISOString(),
      } satisfies SessionPayload;

      const context = {
        requestIp: '198.51.100.32', requestId: `email-${suffix}`, userAgent: 'MineWiki-Email-Test/1.0',
      };
      const requested = await runWithFullHttpRequestContext(context, () =>
        service.request(session, { email: newEmail, password: 'CurrentPW1!' }));
      assert.equal(requested.accepted, true);
      assert.equal(deliveries.length, 1);
      assert.equal(JSON.stringify(requested).includes(deliveries[0]!.token), false);
      const initialChange = await prisma.accountEmailChange.findFirstOrThrow({ where: { canonicalAccountId: accountId } });
      assert.equal(initialChange.tokenHash.length, 64);
      assert.notEqual(initialChange.tokenHash, deliveries[0]!.token);
      assert.equal(initialChange.expiresAt.toISOString(), requested.expiresAt);
      assert.equal(initialChange.resendAvailableAt.toISOString(), requested.nextResendAt);
      await prisma.accountEmailChange.update({
        where: { id: initialChange.id },
        data: { resendAvailableAt: new Date(Date.now() - 1) },
      });
      const resent = await runWithFullHttpRequestContext(context, () => service.resend(session));
      assert.equal(resent.expiresAt, requested.expiresAt);
      assert.equal(deliveries.length, 2);
      await assert.rejects(service.confirm(deliveries[0]!.token));
      const confirmed = await runWithFullHttpRequestContext(context, () => service.confirm(deliveries[1]!.token));
      assert.deepEqual(confirmed, { success: true, reauthenticationRequired: true });

      const [account, storedProfile, sessions, resets, verifications, change, audit] = await Promise.all([
        prisma.account.findUniqueOrThrow({ where: { id: accountId } }),
        prisma.wikiProfile.findUniqueOrThrow({ where: { id: profile.id } }),
        prisma.session.count({ where: { accountId } }),
        prisma.passwordReset.count({ where: { accountId } }),
        prisma.emailVerification.count({ where: { accountId } }),
        prisma.accountEmailChange.findFirstOrThrow({ where: { canonicalAccountId: accountId } }),
        prisma.auditEvent.findFirstOrThrow({ where: { action: 'account.contact_email.changed', subjectId: accountId } }),
      ]);
      assert.equal(account.email, newEmail);
      assert.equal(account.providerUserId, newEmail);
      assert.equal(storedProfile.email, newEmail);
      assert.ok(storedProfile.emailVerifiedAt);
      assert.equal(sessions, 0);
      assert.equal(resets, 0);
      assert.equal(verifications, 0);
      assert.equal(change.status, 'confirmed');
      assert.equal(notices[0]?.email, oldEmail);
      assert.equal(JSON.stringify(audit.metadata).includes(newEmail), false);
      assert.equal(audit.requestId, `email-${suffix}`);
      assert.equal(audit.ipAddress, '198.51.100.32');
      assert.equal(audit.userAgent, 'MineWiki-Email-Test/1.0');
      await assert.rejects(service.confirm(deliveries[0]!.token));
    } finally {
      await prisma.auditEvent.deleteMany({ where: { subjectId: accountId } });
      await prisma.accountEmailChange.deleteMany({ where: { canonicalAccountId: accountId } });
      await prisma.wikiProfile.deleteMany({ where: { accountId } });
      await prisma.passwordReset.deleteMany({ where: { accountId } });
      await prisma.emailVerification.deleteMany({ where: { accountId } });
      await prisma.session.deleteMany({ where: { accountId } });
      await prisma.account.deleteMany({ where: { id: accountId } });
    }
  });
}
