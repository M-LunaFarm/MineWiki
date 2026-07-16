import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { ConflictException, UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type { SessionPayload } from '../session/session.service';
import { WikiApiTokenService } from './wiki-api-token.service';

const policyConsent = {
  required: false,
  terms: { accepted: true, currentVersion: '2026-07-01', acceptedVersion: '2026-07-01' },
  privacy: { accepted: true, currentVersion: '2026-07-01', acceptedVersion: '2026-07-01' },
};

function recentSession(userId = '00000000-0000-4000-8000-000000000001'): SessionPayload {
  return {
    sessionId: 'session-id',
    userId,
    tokenVersion: 4,
    isElevated: false,
    authenticatedAt: new Date().toISOString(),
    authLevel: 'aal1',
    permissions: ['wiki.admin'],
    groups: ['admin'],
    policyConsent,
    requestIp: '192.0.2.10',
  };
}

test('creation returns the raw token once while persisting only its hash', async () => {
  let persisted: Record<string, unknown> | null = null;
  const prisma = {
    account: {
      async findUnique() { return { id: recentSession().userId, canonicalAccountId: recentSession().userId, lifecycleStatus: 'active' }; },
      async findMany() { return [{ id: recentSession().userId, lifecycleStatus: 'active' }]; },
    },
    wikiApiToken: {
      async create(input: { data: Record<string, unknown> }) {
        persisted = input.data;
        return {
          ...input.data,
          id: '00000000-0000-4000-8000-000000000010',
          status: 'active',
          lastUsedAt: null,
          createdAt: new Date('2026-07-16T00:00:00.000Z'),
          space: null,
        };
      },
    },
  };
  const service = new WikiApiTokenService(
    prisma as never,
    {} as never,
    { async audit() {} } as never,
  );

  const created = await service.create(recentSession(), {
    name: '배포 자동화',
    scopes: ['wiki:read', 'wiki:edit', 'wiki:edit'],
    expiresInDays: 30,
  });

  assert.match(created.token, /^mwk_[a-f0-9]{12}_[A-Za-z0-9_-]{43}$/u);
  assert.equal(persisted?.secretHash, createHash('sha256').update(created.token).digest('hex'));
  assert.notEqual(persisted?.secretHash, created.token);
  assert.equal('token' in (persisted ?? {}), false);
  assert.deepEqual(persisted?.scopes, ['wiki:read', 'wiki:edit']);
});

test('authentication never inherits browser elevation, roles, or recent-auth state', async () => {
  const rawToken = `mwk_${'a'.repeat(12)}_${'b'.repeat(43)}`;
  const accountId = '00000000-0000-4000-8000-000000000001';
  const token = {
    id: '00000000-0000-4000-8000-000000000010',
    accountId,
    tokenPrefix: 'a'.repeat(12),
    secretHash: createHash('sha256').update(rawToken).digest('hex'),
    scopes: ['wiki:read', 'wiki:edit'],
    spaceId: 9n,
    space: { status: 'active' },
    status: 'active',
    expiresAt: new Date(Date.now() + 60_000),
    lastUsedAt: null,
    createdAt: new Date(),
    account: { id: accountId, canonicalAccountId: accountId, lifecycleStatus: 'active' },
  };
  const prisma = {
    wikiApiToken: {
      async findUnique() { return token; },
      async updateMany() { return { count: 1 }; },
    },
    account: {
      async findUnique() { return { id: accountId, canonicalAccountId: accountId, lifecycleStatus: 'active' }; },
      async findMany() { return [{ id: accountId, lifecycleStatus: 'active' }]; },
    },
  };
  const service = new WikiApiTokenService(
    prisma as never,
    { async getPolicyConsentStatus() { return policyConsent; } } as never,
    {} as never,
  );

  const authenticated = await service.authenticate(rawToken, '192.0.2.11');

  assert.equal(authenticated.accountId, accountId);
  assert.equal(authenticated.spaceId, '9');
  assert.equal(authenticated.session.isElevated, false);
  assert.equal(authenticated.session.authenticatedAt, '1970-01-01T00:00:00.000Z');
  assert.deepEqual(authenticated.session.permissions, []);
  assert.deepEqual(authenticated.session.groups, []);
});

test('linked alias tokens stay visible and revocable from the canonical account', async () => {
  const aliasId = '00000000-0000-4000-8000-000000000001';
  const canonicalId = '00000000-0000-4000-8000-000000000002';
  let listWhere: unknown;
  let revokeWhere: unknown;
  const prisma = {
    account: {
      async findUnique() { return { id: canonicalId, canonicalAccountId: canonicalId, lifecycleStatus: 'active' }; },
      async findMany() {
        return [
          { id: aliasId, lifecycleStatus: 'active' },
          { id: canonicalId, lifecycleStatus: 'active' },
        ];
      },
    },
    wikiApiToken: {
      async findMany(input: { where: unknown }) { listWhere = input.where; return []; },
      async updateMany(input: { where: unknown }) { revokeWhere = input.where; return { count: 1 }; },
    },
  };
  const service = new WikiApiTokenService(
    prisma as never,
    {} as never,
    { async audit() {} } as never,
  );

  assert.deepEqual(await service.list(canonicalId), []);
  assert.deepEqual(await service.revoke(recentSession(canonicalId), '00000000-0000-4000-8000-000000000010'), { revoked: true });
  assert.deepEqual(listWhere, { accountId: { in: [aliasId, canonicalId] } });
  assert.deepEqual(revokeWhere, {
    id: '00000000-0000-4000-8000-000000000010',
    accountId: { in: [aliasId, canonicalId] },
    status: 'active',
  });
});

test('a token bound to an inactive space fails closed', async () => {
  const rawToken = `mwk_${'c'.repeat(12)}_${'d'.repeat(43)}`;
  const accountId = '00000000-0000-4000-8000-000000000001';
  const prisma = {
    wikiApiToken: {
      async findUnique() {
        return {
          id: '00000000-0000-4000-8000-000000000010',
          accountId,
          tokenPrefix: 'c'.repeat(12),
          secretHash: createHash('sha256').update(rawToken).digest('hex'),
          scopes: ['wiki:read'],
          spaceId: 9n,
          space: { status: 'deleted' },
          status: 'active',
          expiresAt: new Date(Date.now() + 60_000),
          lastUsedAt: null,
          createdAt: new Date(),
          account: { id: accountId, canonicalAccountId: accountId, lifecycleStatus: 'active' },
        };
      },
    },
  };
  const service = new WikiApiTokenService(prisma as never, {} as never, {} as never);

  await assert.rejects(
    service.authenticate(rawToken),
    (error: unknown) => error instanceof UnauthorizedException,
  );
});

test('idempotency deduplicates the same mutation even when a client changes its key', async () => {
  let actionCalls = 0;
  const response = { pageId: '7', revisionId: '11' };
  const prisma = {
    wikiApiIdempotencyRecord: {
      async deleteMany() { return { count: 0 }; },
      async create() {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        });
      },
      async findUnique() { return null; },
      async findFirst() {
        return {
          id: 'record-id',
          requestHash: createHash('sha256')
            .update('PATCH\n/v1/wiki/api/pages/7\n{"baseRevisionId":"10","contentRaw":"내용"}')
            .digest('hex'),
          method: 'PATCH',
          route: '/v1/wiki/api/pages/7',
          status: 'completed',
          responseBody: response,
          expiresAt: new Date(Date.now() + 60_000),
        };
      },
    },
  };
  const service = new WikiApiTokenService(prisma as never, {} as never, {} as never);

  const replay = await service.idempotent({
    tokenId: 'token-id',
    key: 'different-key',
    method: 'PATCH',
    route: '/v1/wiki/api/pages/7',
    body: { contentRaw: '내용', baseRevisionId: '10' },
    responseStatus: 200,
    action: async () => {
      actionCalls += 1;
      return response;
    },
  });

  assert.deepEqual(replay, response);
  assert.equal(actionCalls, 0);
});

test('expired processing idempotency records become indeterminate instead of rerunning', async () => {
  let markedIndeterminate = false;
  let actionCalls = 0;
  const prisma = {
    wikiApiIdempotencyRecord: {
      async deleteMany() { return { count: 0 }; },
      async create() {
        throw new Prisma.PrismaClientKnownRequestError('duplicate', {
          code: 'P2002',
          clientVersion: 'test',
        });
      },
      async findUnique() {
        return {
          id: 'record-id',
          requestHash: createHash('sha256')
            .update('POST\n/v1/wiki/api/pages\n{"contentRaw":"내용","namespace":"main","title":"문서"}')
            .digest('hex'),
          method: 'POST',
          route: '/v1/wiki/api/pages',
          status: 'processing',
          responseBody: null,
          expiresAt: new Date(Date.now() - 1000),
        };
      },
      async findFirst() { return null; },
      async updateMany() { markedIndeterminate = true; return { count: 1 }; },
    },
  };
  const service = new WikiApiTokenService(prisma as never, {} as never, {} as never);

  await assert.rejects(
    service.idempotent({
      tokenId: 'token-id',
      key: 'expired-key',
      method: 'POST',
      route: '/v1/wiki/api/pages',
      body: { title: '문서', namespace: 'main', contentRaw: '내용' },
      responseStatus: 201,
      action: async () => {
        actionCalls += 1;
        return { pageId: '7' };
      },
    }),
    (error: unknown) => {
      if (!(error instanceof ConflictException)) return false;
      const responseBody = error.getResponse() as { code?: string };
      return responseBody.code === 'IDEMPOTENCY_RESULT_UNKNOWN';
    },
  );
  assert.equal(markedIndeterminate, true);
  assert.equal(actionCalls, 0);
});
