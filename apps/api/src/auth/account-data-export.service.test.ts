import assert from 'node:assert/strict';
import test from 'node:test';
import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { hash } from '@node-rs/argon2';
import { randomUUID } from 'node:crypto';
import { AccountDataExportService } from './account-data-export.service';
import type { CanonicalAccountGroup } from './account-lifecycle-fence';
import type { SessionPayload } from '../session/session.service';
import { PrismaService } from '../common/prisma.service';
import { WikiAclService } from '../wiki/wiki-acl.service';
import { WikiPermissionService } from '../wiki/wiki-permission.service';

const group: CanonicalAccountGroup = {
  seedAccountId: 'linked', canonicalAccountId: 'canonical', accountIds: ['canonical', 'linked'],
};

function session(overrides: Partial<SessionPayload> = {}): SessionPayload {
  return {
    sessionId: 'session', userId: 'linked', tokenVersion: 1, isElevated: false,
    authenticatedAt: new Date().toISOString(), ...overrides,
  };
}

test('account export accepts a fresh purpose-bound MFA step-up without reading password hashes', async () => {
  let queried = false;
  const service = new AccountDataExportService({
    account: { async findMany() { queried = true; return []; } },
  } as never, {} as never);
  const now = Date.now();
  await (service as unknown as { reauthenticate(group: CanonicalAccountGroup, session: SessionPayload): Promise<void> }).reauthenticate(group, session({
    authenticatedAt: new Date(now - 2_000).toISOString(),
    authLevel: 'aal2',
    stepUpMethod: 'webauthn',
    stepUpPurpose: 'account_export',
    stepUpAt: new Date(now - 1_000).toISOString(),
    stepUpExpiresAt: new Date(now + 60_000).toISOString(),
  }));
  assert.equal(queried, false);
});

test('account export accepts the password of any account in the canonical group', async () => {
  const passwordHash = await hash('correct horse battery staple');
  const service = new AccountDataExportService({
    account: { async findMany() { return [{ passwordHash: null }, { passwordHash }]; } },
  } as never, {} as never);
  await (service as unknown as { reauthenticate(group: CanonicalAccountGroup, session: SessionPayload, password?: string): Promise<void> })
    .reauthenticate(group, session({ authenticatedAt: new Date(0).toISOString() }), 'correct horse battery staple');
  await assert.rejects(
    () => (service as unknown as { reauthenticate(group: CanonicalAccountGroup, session: SessionPayload, password?: string): Promise<void> })
      .reauthenticate(group, session({ authenticatedAt: new Date(0).toISOString() }), 'wrong'),
    (error: unknown) => error instanceof UnauthorizedException,
  );
});

test('OAuth-only export requires a login from the last fifteen minutes', async () => {
  const service = new AccountDataExportService({
    account: { async findMany() { return [{ passwordHash: null }]; } },
  } as never, {} as never);
  const authenticate = (candidate: SessionPayload) =>
    (service as unknown as { reauthenticate(group: CanonicalAccountGroup, session: SessionPayload): Promise<void> })
      .reauthenticate(group, candidate);
  await authenticate(session());
  await assert.rejects(
    () => authenticate(session({ authenticatedAt: new Date(Date.now() - 16 * 60 * 1000).toISOString() })),
    (error: unknown) => {
      if (!(error instanceof ForbiddenException)) return false;
      const response = error.getResponse() as { code?: string; purpose?: string };
      return response.code === 'ACCOUNT_EXPORT_REAUTH_REQUIRED' && response.purpose === 'account_export';
    },
  );
  await assert.rejects(
    () => authenticate(session({ authenticatedAt: new Date(Date.now() + 60_000).toISOString() })),
    (error: unknown) => error instanceof ForbiddenException,
  );
});

test('export profile scope follows only recursively completed aliases for the canonical account', async () => {
  const aliases = [
    { sourceProfileId: 8n, targetProfileId: 10n, mergeRequestId: 'completed-1' },
    { sourceProfileId: 7n, targetProfileId: 8n, mergeRequestId: 'completed-2' },
    { sourceProfileId: 9n, targetProfileId: 10n, mergeRequestId: 'pending' },
  ];
  const service = new AccountDataExportService({
    wikiProfile: { async findMany() { return [{ id: 10n }]; } },
    wikiProfileAlias: {
      async findMany(input: { where: { targetProfileId: { in: bigint[] } } }) {
        return aliases.filter((alias) => input.where.targetProfileId.in.includes(alias.targetProfileId));
      },
    },
    wikiProfileMergeRequest: {
      async findMany(input: { where: { id: { in: string[] }; canonicalAccountId: string } }) {
        if (input.where.canonicalAccountId !== 'canonical') return [];
        return input.where.id.in.filter((id) => id.startsWith('completed')).map((id) => ({ id }));
      },
    },
  } as never, {} as never);
  const scope = await (service as unknown as { resolveScope(group: CanonicalAccountGroup): Promise<{ profileIds: bigint[] }> })
    .resolveScope(group);
  assert.deepEqual(scope.profileIds, [7n, 8n, 10n]);
});

test('real database export streams a complete secret-free document for a disposable OAuth account', {
  skip: process.env.DATABASE_URL ? false : 'DATABASE_URL is not configured.',
}, async () => {
  const prisma = new PrismaService();
  const accountId = randomUUID();
  const suffix = accountId.replaceAll('-', '');
  await prisma.$connect();
  try {
    await prisma.account.create({
      data: { id: accountId, provider: 'discord', providerUserId: `export-test-${suffix}` },
    });
    await prisma.wikiProfile.create({
      data: {
        accountId, username: `export_${suffix}`, displayName: 'Export Test',
        createdAt: new Date(), updatedAt: new Date(),
      },
    });
    const permissions = new WikiPermissionService(prisma, new WikiAclService(prisma));
    const service = new AccountDataExportService(prisma, permissions);
    const stream = await service.create({ session: {
      sessionId: randomUUID(), userId: accountId, tokenVersion: 1,
      isElevated: false, authenticatedAt: new Date().toISOString(),
    } });
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.from(chunk));
    const document = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      completed: boolean;
      data: { accounts: Array<Record<string, unknown>>; oauthCredentials: Array<Record<string, unknown>> };
    };
    assert.equal(document.completed, true);
    assert.equal(document.data.accounts.length, 1);
    assert.equal(document.data.accounts[0]?.id, accountId);
    assert.equal(JSON.stringify(document).includes('accessToken'), false);
    assert.deepEqual(document.data.oauthCredentials, []);
  } finally {
    await prisma.auditEvent.deleteMany({ where: { actorAccountId: accountId } });
    await prisma.wikiProfile.deleteMany({ where: { accountId } });
    await prisma.account.deleteMany({ where: { id: accountId } });
    await prisma.$disconnect();
  }
});
