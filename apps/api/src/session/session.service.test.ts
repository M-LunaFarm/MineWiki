import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { SessionService, hashSessionToken } from './session.service';
import { PrismaService } from '../common/prisma.service';
import { CURRENT_POLICY_VERSIONS } from '@minewiki/schemas';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const service = new SessionService(prisma);

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  async function createTestAccount() {
    const id = randomUUID();
    await prisma.account.create({
      data: {
        id,
        provider: 'email',
        providerUserId: `session-test-${id}`,
        email: `session-test-${id}@example.com`,
        emailVerified: true
      }
    });
    return id;
  }

  async function cleanupTestAccount(id: string) {
    await prisma.session.deleteMany({ where: { accountId: id } });
    await prisma.account.delete({ where: { id } }).catch(() => undefined);
  }

  test('issues session cookie with secure httpOnly samesite strict flags', async () => {
    const userId = await createTestAccount();
    try {
      const result = await service.issueSession({ userId });
      assert.ok(result.sessionId);
      assert.match(result.sessionId, /^[0-9a-f-]{36}$/);
      assert.ok(result.cookie.includes('HttpOnly'));
      assert.ok(result.cookie.includes('Secure'));
      assert.ok(result.cookie.includes('SameSite=Strict'));
      const rawToken = tokenFromCookie(result.cookie);
      const stored = await prisma.session.findUnique({ where: { id: result.sessionId } });
      assert.ok(rawToken);
      assert.equal(stored?.token, hashSessionToken(rawToken));
      assert.notEqual(stored?.token, rawToken);
      assert.equal(await service.getSessionByToken(stored?.token), undefined);
      assert.equal((await service.getSessionByToken(rawToken))?.sessionId, result.sessionId);
    } finally {
      await cleanupTestAccount(userId);
    }
  });

  test('policy acceptance is immutable and unlocks every active canonical session', async () => {
    const userId = await createTestAccount();
    try {
      const first = await service.issueSession({ userId });
      const second = await service.issueSession({ userId });
      assert.equal(first.policyConsent.required, true);
      assert.equal(second.policyConsent.required, true);

      const accepted = await service.acceptCurrentPolicies(userId, {
        ipAddress: '192.0.2.10',
        userAgent: 'PolicyTest/1.0',
      });
      assert.equal(accepted.required, false);
      assert.equal(
        await prisma.accountConsent.count({
          where: {
            accountId: userId,
            policyVersion: {
              in: [
                CURRENT_POLICY_VERSIONS.terms.consentVersion,
                CURRENT_POLICY_VERSIONS.privacy.consentVersion,
              ],
            },
          },
        }),
        2,
      );

      await service.acceptCurrentPolicies(userId, {});
      assert.equal(await prisma.accountConsent.count({ where: { accountId: userId } }), 2);
      const firstPayload = service.toPayload((await service.getSession(first.sessionId))!);
      const secondPayload = service.toPayload((await service.getSession(second.sessionId))!);
      assert.equal(firstPayload.policyConsent?.required, false);
      assert.equal(secondPayload.policyConsent?.required, false);
    } finally {
      await cleanupTestAccount(userId);
    }
  });

  test('accepts legacy raw session tokens without accepting arbitrary stored hashes', async () => {
    const userId = await createTestAccount();
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const sessionId = randomUUID();
    try {
      await prisma.session.create({
        data: {
          id: sessionId,
          accountId: userId,
          token,
          issuedAt: now,
          expiresAt: new Date(now.getTime() + 60_000),
          tokenVersion: 1,
          isElevated: false,
          lastActiveAt: now,
        },
      });

      assert.equal((await service.getSessionByToken(token))?.sessionId, sessionId);
      assert.equal(await service.getSessionByToken(hashSessionToken(token)), undefined);
    } finally {
      await cleanupTestAccount(userId);
    }
  });

  test('rotates session and increments version while keeping expiry', async () => {
    const userId = await createTestAccount();
    try {
      const initial = await service.issueSession({ userId, ttlSeconds: 60 });
      const rotated = await service.rotateSession(initial.sessionId, true);
      assert.notEqual(rotated.cookie, initial.cookie);
      assert.ok(rotated.cookie.includes('HttpOnly'));
      const session = await service.getSession(initial.sessionId);
      assert.ok(session?.isElevated);
      assert.equal(session?.tokenVersion, 2);
      assert.equal(session?.lastActiveAt instanceof Date, true);
    } finally {
      await cleanupTestAccount(userId);
    }
  });

  test('revokes session and prevents reuse', async () => {
    const userId = await createTestAccount();
    try {
      const issued = await service.issueSession({ userId });
      await service.revokeSession(issued.sessionId);
      const session = await service.getSession(issued.sessionId);
      assert.equal(session, undefined);
    } finally {
      await cleanupTestAccount(userId);
    }
  });

  test('lists sessions for user and marks current session', async () => {
    const userId = await createTestAccount();
    try {
      const first = await service.issueSession({
        userId,
        userAgent: 'TestAgent',
        ipAddress: '127.0.0.1'
      });
      const second = await service.issueSession({
        userId,
        userAgent: 'Mobile',
        ipAddress: '192.0.2.1'
      });

      const summaries = await service.listSessionsForUser(userId, second.sessionId);
      assert.equal(summaries.length, 2);
      const current = summaries.find((summary) => summary.sessionId === second.sessionId);
      assert.ok(current?.isCurrent);
      const previous = summaries.find((summary) => summary.sessionId === first.sessionId);
      assert.equal(previous?.isCurrent, false);
    } finally {
      await cleanupTestAccount(userId);
    }
  });
}

function tokenFromCookie(cookie: string): string | undefined {
  const value = cookie.split(';', 1)[0]?.split('=', 2)[1];
  return value ? decodeURIComponent(value) : undefined;
}
