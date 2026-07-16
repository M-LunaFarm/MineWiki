import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { BusinessEventService } from '../events/business-event.service';
import type { SessionService, SessionPayload } from '../session/session.service';
import { MfaService } from './mfa.service';
import { MemoryPrisma, type TestCredential } from './webauthn-test-fixture';

const ACCOUNT = '99999999-9999-4999-8999-999999999999';
const SESSION = '88888888-8888-4888-8888-888888888888';
const NOW = new Date('2026-07-17T07:00:00.000Z');

test('MFA status distinguishes aggregate availability, TOTP, and passkey summaries', async () => {
  const fixture = createMfaFixture(true);
  const status = await fixture.mfa.getStatus(ACCOUNT);
  assert.equal(status.mfaEnabled, true);
  assert.equal(status.totpEnabled, true);
  assert.equal(status.passkeyCount, 1);
  assert.deepEqual(status.passkeys.map(({ id, name }) => ({ id, name })), [{
    id: '77777777-7777-4777-8777-777777777777',
    name: 'Backup phone',
  }]);
});

test('protected accounts may remove TOTP when a passkey remains but never their last MFA method', async () => {
  const withPasskey = createMfaFixture(true);
  await withPasskey.mfa.disableTotp(freshSession());
  const status = await withPasskey.mfa.getStatus(ACCOUNT);
  assert.equal(status.mfaEnabled, true);
  assert.equal(status.totpEnabled, false);
  assert.equal(status.passkeyCount, 1);

  const withoutPasskey = createMfaFixture(false);
  await assert.rejects(
    withoutPasskey.mfa.disableTotp(freshSession()),
    /다중 인증을 해제할 수 없습니다/u,
  );
  assert.ok(withoutPasskey.db.state.totpCredentials[0]?.enabledAt);
});

function createMfaFixture(withPasskey: boolean) {
  const passkey: TestCredential = {
    id: '77777777-7777-4777-8777-777777777777',
    accountId: ACCOUNT,
    credentialId: 'passkey-status',
    name: 'Backup phone',
    publicKey: Uint8Array.from([1, 2, 3]),
    counter: 0n,
    counterVersion: 0,
    transports: ['hybrid'],
    deviceType: 'multiDevice',
    backedUp: true,
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
  };
  const db = new MemoryPrisma({
    accounts: [{ id: ACCOUNT, canonicalAccountId: ACCOUNT, lifecycleStatus: 'active', displayName: 'Admin' }],
    sessions: [{ id: SESSION, accountId: ACCOUNT, tokenVersion: 1, expiresAt: new Date(NOW.getTime() + 3_600_000) }],
    credentials: withPasskey ? [passkey] : [],
    totpCredentials: [{ id: 'totp-status', accountId: ACCOUNT, enabledAt: NOW }],
    recoveryCodes: [{ accountId: ACCOUNT, usedAt: null }],
    protectedRoleAccountIds: [ACCOUNT],
  });
  const sessions = {
    async rotateSession(
      sessionId: string,
      options: { expectedTokenVersion: number },
      store: { session: { updateMany(input: unknown): Promise<{ count: number }> } },
    ) {
      await store.session.updateMany({
        where: { id: sessionId, tokenVersion: options.expectedTokenVersion },
        data: { tokenVersion: { increment: 1 } },
      });
      return {
        sessionId,
        cookie: 'mw_session=rotated',
        expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
        policyConsent: { required: false },
      };
    },
  } as unknown as SessionService;
  const events = { async audit() {} } as unknown as BusinessEventService;
  return { db, mfa: new MfaService(db.asPrisma(), sessions, events) };
}

function freshSession(): SessionPayload {
  const now = Date.now();
  return {
    sessionId: SESSION,
    userId: ACCOUNT,
    tokenVersion: 1,
    isElevated: false,
    authenticatedAt: new Date(now - 60_000).toISOString(),
    authLevel: 'aal2',
    stepUpAt: new Date(now - 30_000).toISOString(),
    stepUpExpiresAt: new Date(now + 270_000).toISOString(),
    stepUpMethod: 'webauthn',
    stepUpPurpose: 'mfa_manage',
  };
}
