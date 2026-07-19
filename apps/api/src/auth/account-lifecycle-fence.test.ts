import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { hash } from '@node-rs/argon2';
import { PrismaService } from '../common/prisma.service';
import {
  withActiveCanonicalAccountGroup,
  withCanonicalAccountGroups,
  readCanonicalAccountGroup,
} from './account-lifecycle-fence';
import { AccountSeparationService } from './account-separation.service';
import { AuthService } from './auth.service';
import { OAuthFlowService } from './oauth-flow.service';
import { SessionService } from '../session/session.service';
import { MinecraftService } from '../minecraft/minecraft.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

test('canonical group locking keeps distinct seeds separate while expanding linked aliases', async () => {
  const accounts = [
    { id: 'actor', canonicalAccountId: null },
    { id: 'target', canonicalAccountId: null },
    { id: 'alias', canonicalAccountId: 'target' },
  ];
  const links = [{ primaryAccountId: 'target', linkedAccountId: 'alias' }];
  const tx = {
    account: {
      async findUnique(input: { where: { id: string } }) {
        return accounts.find((account) => account.id === input.where.id) ?? null;
      },
      async findMany(input: { where: { OR: Array<Record<string, { in: string[] }>> } }) {
        const ids = input.where.OR.flatMap((clause) => clause.id?.in ?? []);
        const canonicalIds = input.where.OR.flatMap((clause) => clause.canonicalAccountId?.in ?? []);
        return accounts.filter((account) =>
          ids.includes(account.id) ||
          Boolean(account.canonicalAccountId && canonicalIds.includes(account.canonicalAccountId)),
        );
      },
    },
    accountLink: {
      async findMany(input: { where: { OR: Array<Record<string, { in: string[] }>> } }) {
        const ids = input.where.OR.flatMap((clause) =>
          clause.primaryAccountId?.in ?? clause.linkedAccountId?.in ?? [],
        );
        return links.filter((link) => ids.includes(link.primaryAccountId) || ids.includes(link.linkedAccountId));
      },
    },
    async $queryRaw(query: { values: unknown[] }) {
      return accounts.filter(({ id }) => query.values.includes(id)).map(({ id }) => ({ id }));
    },
  };
  const prisma = {
    async $transaction(callback: (store: typeof tx) => unknown) { return callback(tx); },
  };

  const groups = await withCanonicalAccountGroups(
    prisma as never,
    ['actor', 'alias'],
    async (_store, resolved) => resolved,
  );

  assert.deepEqual(groups, [
    { seedAccountId: 'actor', canonicalAccountId: 'actor', accountIds: ['actor'] },
    { seedAccountId: 'alias', canonicalAccountId: 'target', accountIds: ['alias', 'target'] },
  ]);
});

test('read-only canonical resolution closes over canonical aliases and both link directions', async () => {
  const accounts = [
    { id: 'canonical', canonicalAccountId: 'canonical' },
    { id: 'alias', canonicalAccountId: 'canonical' },
    { id: 'linked', canonicalAccountId: null },
  ];
  const store = {
    account: {
      async findUnique(input: { where: { id: string } }) {
        return accounts.find((account) => account.id === input.where.id) ?? null;
      },
      async findMany() { return accounts; },
    },
    accountLink: {
      async findMany() { return [{ primaryAccountId: 'linked', linkedAccountId: 'alias' }]; },
    },
  };
  assert.deepEqual(await readCanonicalAccountGroup(store as never, 'alias'), {
    seedAccountId: 'alias', canonicalAccountId: 'canonical', accountIds: ['alias', 'canonical', 'linked'],
  });
});

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

  test('inactive canonical member blocks alias login, linking, and OAuth credential state writes', async () => {
    const canonicalId = await createAccount();
    const aliasId = await createAccount({
      email: `alias-${randomUUID()}@example.invalid`,
      passwordHash: await hash('AliasPassword1!'),
    });
    const thirdId = await createAccount();
    const redirectUri = 'https://minewiki.kr/auth/callback/discord';
    const microsoftRedirectUri = 'https://minewiki.kr/minecraft/callback';
    const config = {
      getOptional: (key: string) => {
        if (key === 'ACCOUNT_LINKING_ENABLED') return 'true';
        if (key === 'DISCORD_CLIENT_ID') return 'test-discord-client';
        if (key === 'DISCORD_REDIRECT_URI') return redirectUri;
        if (key === 'MICROSOFT_CLIENT_ID') return 'test-microsoft-client';
        if (key === 'MICROSOFT_REDIRECT_URI') return microsoftRedirectUri;
        return undefined;
      },
    };
    try {
      await prisma.accountLink.createMany({
        data: [
          { primaryAccountId: canonicalId, linkedAccountId: aliasId },
          { primaryAccountId: aliasId, linkedAccountId: canonicalId },
        ],
      });
      await prisma.account.updateMany({
        where: { id: { in: [canonicalId, aliasId] } },
        data: { canonicalAccountId: canonicalId },
      });
      await prisma.account.update({
        where: { id: canonicalId },
        data: { lifecycleStatus: 'deletion_pending' },
      });

      const accounts = new AccountSeparationService(prisma);
      const sessions = new SessionService(prisma);
      const auth = new AuthService(
        accounts,
        sessions,
        prisma,
        {} as never,
        config as never,
        {} as never,
      );
      const oauth = new OAuthFlowService(config as never, prisma);
      const minecraft = new MinecraftService({} as never, config as never, prisma);
      const alias = await prisma.account.findUniqueOrThrow({ where: { id: aliasId } });

      await assert.rejects(
        auth.loginEmail({ email: alias.email!, password: 'AliasPassword1!' }),
        /활성 상태가 아닙니다|종료가 진행 중인 계정/,
      );
      await assert.rejects(
        accounts.linkActiveAccounts(aliasId, thirdId),
        /종료가 진행 중인 계정/,
      );
      await assert.rejects(
        oauth.start(
          'discord',
          redirectUri,
          '/me',
          'link',
          aliasId,
          false,
          false,
          'a'.repeat(64),
        ),
        /종료가 진행 중인 계정/,
      );
      await assert.rejects(
        oauth.storeCredential(aliasId, 'discord', `discord-${aliasId}`, {
          accessToken: 'access-token',
          refreshToken: 'refresh-token',
        }),
        /종료가 진행 중인 계정/,
      );
      await assert.rejects(
        minecraft.startAuthorization({ userId: aliasId }),
        /종료가 진행 중인 계정/,
      );

      assert.equal(await prisma.session.count({ where: { accountId: aliasId } }), 0);
      assert.equal(await prisma.accountLink.count({
        where: { OR: [{ primaryAccountId: thirdId }, { linkedAccountId: thirdId }] },
      }), 0);
      assert.equal(await prisma.oAuthState.count({ where: { linkAccountId: aliasId } }), 0);
      assert.equal(await prisma.oAuthCredential.count({ where: { accountId: aliasId } }), 0);
      assert.equal(await prisma.minecraftAuthorization.count({ where: { accountId: aliasId } }), 0);
    } finally {
      await cleanup([canonicalId, aliasId, thirdId]);
    }
  });

  test('OAuth credential writes rehome one provider identity onto the canonical account', async () => {
    const canonicalId = await createAccount();
    const aliasId = await createAccount();
    const providerUserId = `discord-${randomUUID()}`;
    const config = { getOptional() { return undefined; } };
    try {
      await prisma.accountLink.createMany({ data: [
        { primaryAccountId: canonicalId, linkedAccountId: aliasId },
        { primaryAccountId: aliasId, linkedAccountId: canonicalId },
      ] });
      await prisma.account.updateMany({
        where: { id: { in: [canonicalId, aliasId] } },
        data: { canonicalAccountId: canonicalId },
      });
      const oauth = new OAuthFlowService(config as never, prisma);
      await oauth.storeCredential(aliasId, 'discord', providerUserId, {
        accessToken: 'first-token',
        refreshToken: 'first-refresh',
      });
      await oauth.storeCredential(canonicalId, 'discord', providerUserId, {
        accessToken: 'second-token',
        refreshToken: 'second-refresh',
      });

      const credentials = await prisma.oAuthCredential.findMany({
        where: { provider: 'discord', providerUserId },
        select: { accountId: true },
      });
      assert.deepEqual(credentials, [{ accountId: canonicalId }]);
    } finally {
      await cleanup([canonicalId, aliasId]);
    }
  });

  async function createAccount(options: { email?: string; passwordHash?: string } = {}): Promise<string> {
    const id = randomUUID();
    const email = options.email ?? `fence-${id}@example.invalid`;
    await prisma.account.create({ data: {
      id,
      canonicalAccountId: id,
      provider: 'email',
      providerUserId: email,
      email,
      emailVerified: true,
      passwordHash: options.passwordHash,
    } });
    return id;
  }

  async function cleanup(accountIds: string[]): Promise<void> {
    await prisma.oAuthState.deleteMany({ where: { linkAccountId: { in: accountIds } } });
    await prisma.oAuthCredential.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.minecraftAuthorization.deleteMany({ where: { accountId: { in: accountIds } } });
    await prisma.session.deleteMany({ where: { accountId: { in: accountIds } } });
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
