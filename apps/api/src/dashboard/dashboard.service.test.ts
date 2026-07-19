import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DashboardService } from './dashboard.service';

function createService(server: Record<string, unknown>) {
  return new DashboardService({
    server: { findMany: async () => [server] },
    serverReview: { findMany: async () => [] },
    serverClaimMethod: { findMany: async () => [] },
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
});
