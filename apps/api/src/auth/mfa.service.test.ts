import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { BusinessEventService } from '../events/business-event.service';
import { PrismaService } from '../common/prisma.service';
import {
  SessionService,
  assertFreshStepUp,
} from '../session/session.service';
import { MfaService } from './mfa.service';
import { totpCodeAt } from './totp';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const sessions = new SessionService(prisma);
  const events = new BusinessEventService(prisma);
  const mfa = new MfaService(prisma, sessions, events);

  before(async () => prisma.$connect());
  after(async () => prisma.$disconnect());

  async function createAccount() {
    const id = randomUUID();
    await prisma.account.create({
      data: {
        id,
        provider: 'email',
        providerUserId: `mfa-test-${id}`,
        email: `mfa-test-${id}@example.com`,
        emailVerified: true,
      },
    });
    return id;
  }

  async function cleanupAccount(id: string) {
    await prisma.auditEvent.deleteMany({ where: { actorAccountId: id } });
    await prisma.account.delete({ where: { id } }).catch(() => undefined);
  }

  test('TOTP enrollment returns one-time recovery codes and revokes the pre-enrollment token', async () => {
    const accountId = await createAccount();
    try {
      const issued = await sessions.issueSession({ userId: accountId });
      const originalToken = tokenFromCookie(issued.cookie);
      const record = await sessions.getSessionByToken(originalToken);
      const payload = sessions.toPayload(record!);
      const now = new Date();
      const enrollment = await mfa.beginTotpEnrollment(payload, now);
      assert.match(enrollment.secret, /^[A-Z2-7]{32}$/u);
      assert.match(enrollment.otpauthUri, /^otpauth:\/\/totp\/MineWiki%3A/u);

      const confirmed = await mfa.confirmTotpEnrollment(
        payload,
        totpCodeAt(enrollment.secret, now.getTime()),
        now,
      );
      assert.equal(confirmed.recoveryCodes?.length, 10);
      assert.equal(new Set(confirmed.recoveryCodes).size, 10);
      assert.equal(await sessions.getSessionByToken(originalToken), undefined);
      assert.ok(await sessions.getSessionByToken(tokenFromCookie(confirmed.session.cookie)));
      assert.deepEqual(await mfa.getStatus(accountId), {
        totpEnabled: true,
        pendingEnrollment: false,
        pendingExpiresAt: null,
        recoveryCodesRemaining: 10,
        lockedUntil: null,
      });
    } finally {
      await cleanupAccount(accountId);
    }
  });

  test('step-up is purpose-bound, rotates the token, and rejects TOTP replay', async () => {
    const accountId = await createAccount();
    try {
      const issued = await sessions.issueSession({ userId: accountId });
      const initial = sessions.toPayload((await sessions.getSessionByToken(tokenFromCookie(issued.cookie)))!);
      const enrolledAt = new Date();
      const enrollment = await mfa.beginTotpEnrollment(initial, enrolledAt);
      const confirmed = await mfa.confirmTotpEnrollment(
        initial,
        totpCodeAt(enrollment.secret, enrolledAt.getTime()),
        enrolledAt,
      );
      const confirmedToken = tokenFromCookie(confirmed.session.cookie);
      const confirmedPayload = sessions.toPayload((await sessions.getSessionByToken(confirmedToken))!);
      const stepAt = new Date(enrolledAt.getTime() + 30_000);
      const stepCode = totpCodeAt(enrollment.secret, stepAt.getTime());
      const stepped = await mfa.stepUp(
        confirmedPayload,
        { method: 'totp', purpose: 'wiki_admin', code: stepCode },
        stepAt,
      );
      assert.equal(await sessions.getSessionByToken(confirmedToken), undefined);
      const steppedPayload = sessions.toPayload(
        (await sessions.getSessionByToken(tokenFromCookie(stepped.session.cookie)))!,
      );
      assert.equal(steppedPayload.authLevel, 'aal2');
      assert.doesNotThrow(() => assertFreshStepUp(steppedPayload, 'wiki_admin', stepAt.getTime()));
      assert.throws(() => assertFreshStepUp(steppedPayload, 'role_admin', stepAt.getTime()));
      await assert.rejects(
        mfa.stepUp(
          steppedPayload,
          { method: 'totp', purpose: 'wiki_admin', code: stepCode },
          stepAt,
        ),
        /다중 인증 코드를 확인/u,
      );
    } finally {
      await cleanupAccount(accountId);
    }
  });

  test('a recovery code is consumed once under concurrent verification', async () => {
    const accountId = await createAccount();
    try {
      const issued = await sessions.issueSession({ userId: accountId });
      const initial = sessions.toPayload((await sessions.getSessionByToken(tokenFromCookie(issued.cookie)))!);
      const now = new Date();
      const enrollment = await mfa.beginTotpEnrollment(initial, now);
      const confirmed = await mfa.confirmTotpEnrollment(
        initial,
        totpCodeAt(enrollment.secret, now.getTime()),
        now,
      );
      const payload = sessions.toPayload(
        (await sessions.getSessionByToken(tokenFromCookie(confirmed.session.cookie)))!,
      );
      const recoveryCode = confirmed.recoveryCodes![0]!;
      const attempts = await Promise.allSettled([
        mfa.stepUp(payload, { method: 'recovery_code', purpose: 'wiki_admin', code: recoveryCode }, now),
        mfa.stepUp(payload, { method: 'recovery_code', purpose: 'wiki_admin', code: recoveryCode }, now),
      ]);
      assert.equal(attempts.filter((result) => result.status === 'fulfilled').length, 1);
      assert.equal(attempts.filter((result) => result.status === 'rejected').length, 1);
      assert.equal((await mfa.getStatus(accountId)).recoveryCodesRemaining, 9);
    } finally {
      await cleanupAccount(accountId);
    }
  });

  test('five invalid MFA attempts trigger a temporary account lock', async () => {
    const accountId = await createAccount();
    try {
      const issued = await sessions.issueSession({ userId: accountId });
      const initial = sessions.toPayload((await sessions.getSessionByToken(tokenFromCookie(issued.cookie)))!);
      const now = new Date();
      const enrollment = await mfa.beginTotpEnrollment(initial, now);
      const confirmed = await mfa.confirmTotpEnrollment(
        initial,
        totpCodeAt(enrollment.secret, now.getTime()),
        now,
      );
      const payload = sessions.toPayload(
        (await sessions.getSessionByToken(tokenFromCookie(confirmed.session.cookie)))!,
      );
      for (let attempt = 1; attempt <= 4; attempt += 1) {
        await assert.rejects(
          mfa.stepUp(payload, { method: 'totp', purpose: 'wiki_admin', code: '000000' }, now),
        );
      }
      await assert.rejects(
        mfa.stepUp(payload, { method: 'totp', purpose: 'wiki_admin', code: '000000' }, now),
        (error: unknown) => Boolean(
          error && typeof error === 'object' && 'status' in error && error.status === 429,
        ),
      );
      assert.ok((await mfa.getStatus(accountId)).lockedUntil);
    } finally {
      await cleanupAccount(accountId);
    }
  });
}

function tokenFromCookie(cookie: string): string {
  const value = cookie.split(';', 1)[0]?.split('=', 2)[1];
  assert.ok(value);
  return decodeURIComponent(value);
}
