import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { UnauthorizedException } from '@nestjs/common';
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
