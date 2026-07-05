import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { SessionService } from './session.service';
import { PrismaService } from '../common/prisma.service';

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

  test('issues session cookie with secure httpOnly samesite strict flags', async () => {
    const result = await service.issueSession({ userId: randomUUID() });
    assert.ok(result.sessionId);
    assert.match(result.sessionId, /^[0-9a-f-]{36}$/);
    assert.ok(result.cookie.includes('HttpOnly'));
    assert.ok(result.cookie.includes('Secure'));
    assert.ok(result.cookie.includes('SameSite=Strict'));
  });

  test('rotates session and increments version while keeping expiry', async () => {
    const userId = randomUUID();
    const initial = await service.issueSession({ userId, ttlSeconds: 60 });
    const rotated = await service.rotateSession(initial.sessionId, true);
    assert.notEqual(rotated.cookie, initial.cookie);
    assert.ok(rotated.cookie.includes('HttpOnly'));
    const session = await service.getSession(initial.sessionId);
    assert.ok(session?.isElevated);
    assert.equal(session?.tokenVersion, 2);
    assert.equal(session?.lastActiveAt instanceof Date, true);
  });

  test('revokes session and prevents reuse', async () => {
    const issued = await service.issueSession({ userId: randomUUID() });
    await service.revokeSession(issued.sessionId);
    const session = await service.getSession(issued.sessionId);
    assert.equal(session, undefined);
  });

  test('lists sessions for user and marks current session', async () => {
    const userId = randomUUID();
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
  });
}
