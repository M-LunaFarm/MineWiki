import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardService } from './dashboard.service';

function createService(
  server: Record<string, unknown>,
  options: {
    readonly serverWiki?: { voteServerId: string; publicationStatus: string } | null;
    readonly readiness?: Record<string, unknown>;
  } = {},
) {
  return new DashboardService({
    server: { findMany: async () => [server] },
    serverWiki: { findMany: async () => options.serverWiki ? [options.serverWiki] : [] },
    serverReview: { findMany: async () => [] },
    serverClaimMethod: { findMany: async () => [] },
  } as never, {
    getServerWikiReadiness: async () => options.readiness ?? ({
      serverId: server.id,
      status: 'unlinked',
      wikiUrl: null,
      completedChecks: 0,
      totalChecks: 6,
      checks: {},
      requiredDocuments: {},
      nextAction: { code: 'create_wiki', label: '서버 위키 만들기', href: '#server-wiki-management' },
    }),
  } as never);
}

const baseServer = {
  id: '11111111-1111-4111-8111-111111111111',
  shortCode: 'server1',
  name: 'Server One',
  votes24h: 0,
  votesMonthly: 0,
  reviewsCount: 0,
  verificationGrade: 'Unverified',
  voteRequiresOwnership: false,
  updatedAt: new Date('2026-07-19T00:00:00.000Z'),
  stats: null,
  ownershipChallengeStartedAt: null,
  ownershipChallengeExpiresAt: null,
  ownershipChallengeSuspendedAt: null,
};

test('dashboard reports takeover claimant as pending while ownership remains suspended', async () => {
  const suspendedAt = new Date('2026-07-19T00:00:00.000Z');
  const service = createService({
    ...baseServer,
    ownerAccountId: 'account-old',
    registrantAccountId: 'account-new',
    ownershipChallengeSuspendedAt: suspendedAt,
  });

  const overview = await service.getOverview('account-new');

  assert.equal(overview.servers[0]?.isPendingClaim, true);
  assert.equal(overview.servers[0]?.ownershipStatus, 'takeover_pending');
});

test('dashboard exposes the ownership recovery grace deadline to the recorded owner', async () => {
  const expiresAt = new Date('2026-07-26T00:00:00.000Z');
  const service = createService({
    ...baseServer,
    ownerAccountId: 'account-owner',
    registrantAccountId: null,
    ownershipChallengeStartedAt: new Date('2026-07-19T00:00:00.000Z'),
    ownershipChallengeExpiresAt: expiresAt,
  });

  const overview = await service.getOverview('account-owner');

  assert.equal(overview.servers[0]?.isPendingClaim, false);
  assert.equal(overview.servers[0]?.ownershipStatus, 'verification_grace');
  assert.equal(overview.servers[0]?.ownershipChallengeExpiresAt, expiresAt.toISOString());
});

test('dashboard exposes the pending registration reservation deadline', async () => {
  const expiresAt = new Date('2026-07-20T00:00:00.000Z');
  const service = createService({
    ...baseServer,
    ownerAccountId: null,
    registrantAccountId: 'account-registrant',
    registrationLeaseExpiresAt: expiresAt,
  });

  const overview = await service.getOverview('account-registrant');

  assert.equal(overview.servers[0]?.ownershipStatus, 'pending_claim');
  assert.equal(overview.servers[0]?.registrationLeaseExpiresAt, expiresAt.toISOString());
  assert.equal(overview.servers[0]?.serverWiki, null);
});

test('dashboard guides a verified owner from wiki setup to the server management section', async () => {
  const service = createService({
    ...baseServer,
    ownerAccountId: 'account-owner',
    registrantAccountId: null,
  });

  const overview = await service.getOverview('account-owner');

  assert.equal(overview.servers[0]?.serverWiki?.status, 'unlinked');
  assert.deepEqual(overview.servers[0]?.serverWiki?.nextAction, {
    label: '서버 위키 만들기',
    href: '/servers/server1#server-wiki-management',
  });
});

test('dashboard guides a ready draft wiki to publication settings', async () => {
  const service = createService({
    ...baseServer,
    ownerAccountId: 'account-owner',
    registrantAccountId: null,
  }, {
    serverWiki: { voteServerId: baseServer.id, publicationStatus: 'draft' },
    readiness: {
      serverId: baseServer.id,
      status: 'ready',
      wikiUrl: '/serverWiki/server-one',
      completedChecks: 6,
      totalChecks: 6,
      checks: {},
      requiredDocuments: {},
      nextAction: null,
    },
  });

  const overview = await service.getOverview('account-owner');

  assert.equal(overview.servers[0]?.serverWiki?.publicationStatus, 'draft');
  assert.deepEqual(overview.servers[0]?.serverWiki?.nextAction, {
    label: '위키 공개 설정 열기',
    href: '/servers/server1/wiki-layouts#server-wiki-publication-title',
  });
});
