import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { withActiveCanonicalAccountGroup } from './account-lifecycle-fence';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  before(async () => prisma.$connect());
  after(async () => prisma.$disconnect());

  test('deletion that owns the account lock makes a later credential writer fail', async () => {
    const accountId = await createAccount();
    const locked = deferred<void>();
    const release = deferred<void>();
    try {
      const deletion = prisma.$transaction(async (tx) => {
        await tx.account.findUnique({ where: { id: accountId } });
        locked.resolve();
        await release.promise;
        await tx.account.update({ where: { id: accountId }, data: { lifecycleStatus: 'deletion_pending' } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await locked.promise;

      const writer = withActiveCanonicalAccountGroup(prisma, [accountId], async (tx) => {
        await tx.session.create({ data: sessionData(accountId) });
      });
      release.resolve();
      await deletion;

      await assert.rejects(writer, /종료가 진행 중인 계정/);
      assert.equal(await prisma.session.count({ where: { accountId } }), 0);
    } finally {
      await cleanup([accountId]);
    }
  });

  test('credential writer that owns the locks commits before deletion and is then revoked for the complete group', async () => {
    const firstId = await createAccount();
    const secondId = await createAccount();
    const writerReady = deferred<void>();
    const releaseWriter = deferred<void>();
    const deletionAttempted = deferred<void>();
    try {
      const writer = withActiveCanonicalAccountGroup(prisma, [firstId, secondId], async (tx) => {
        await tx.accountLink.createMany({ data: [
          { primaryAccountId: firstId, linkedAccountId: secondId },
          { primaryAccountId: secondId, linkedAccountId: firstId },
        ] });
        await tx.session.create({ data: sessionData(secondId) });
        writerReady.resolve();
        await releaseWriter.promise;
      });
      await writerReady.promise;

      const deletion = prisma.$transaction(async (tx) => {
        deletionAttempted.resolve();
        const seed = await tx.account.findUnique({ where: { id: firstId }, select: { id: true } });
        assert.ok(seed);
        const links = await tx.accountLink.findMany({
          where: { OR: [{ primaryAccountId: firstId }, { linkedAccountId: firstId }] },
          select: { primaryAccountId: true, linkedAccountId: true },
        });
        const accountIds = [...new Set([firstId, ...links.flatMap((link) => [link.primaryAccountId, link.linkedAccountId])])];
        await tx.account.updateMany({ where: { id: { in: accountIds } }, data: { lifecycleStatus: 'deletion_pending' } });
        await tx.session.deleteMany({ where: { accountId: { in: accountIds } } });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.Serializable });
      await deletionAttempted.promise;
      releaseWriter.resolve();
      await writer;
      await deletion;

      assert.equal(await prisma.account.count({ where: { id: { in: [firstId, secondId] }, lifecycleStatus: 'deletion_pending' } }), 2);
      assert.equal(await prisma.session.count({ where: { accountId: { in: [firstId, secondId] } } }), 0);
    } finally {
      await cleanup([firstId, secondId]);
    }
  });

  async function createAccount(): Promise<string> {
    const id = randomUUID();
    await prisma.account.create({ data: {
      id,
      canonicalAccountId: id,
      provider: 'email',
      providerUserId: `fence-${id}@example.invalid`,
      email: `fence-${id}@example.invalid`,
      emailVerified: true,
    } });
    return id;
  }

  async function cleanup(accountIds: string[]): Promise<void> {
    await prisma.accountLink.deleteMany({ where: { OR: [{ primaryAccountId: { in: accountIds } }, { linkedAccountId: { in: accountIds } }] } });
    await prisma.account.deleteMany({ where: { id: { in: accountIds } } });
  }

  function sessionData(accountId: string) {
    const now = new Date();
    return { id: randomUUID(), accountId, token: randomUUID(), issuedAt: now, expiresAt: new Date(now.getTime() + 60_000), tokenVersion: 1, lastActiveAt: now };
  }
}

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}
