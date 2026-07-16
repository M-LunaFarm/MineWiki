import assert from 'node:assert/strict';
import { test } from 'node:test';
import type {
  AuthenticationResponseJSON,
  RegistrationResponseJSON,
  VerifiedAuthenticationResponse,
  VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import type { ConfigService } from '@minewiki/config';
import type { BusinessEventService } from '../events/business-event.service';
import type { SessionService, SessionPayload } from '../session/session.service';
import {
  DEFAULT_WEBAUTHN_SERVER,
  WebAuthnService,
  type WebAuthnServerAdapter,
} from './webauthn.service';
import { MemoryPrisma, type TestCredential } from './webauthn-test-fixture';

const ACCOUNT_A = '11111111-1111-4111-8111-111111111111';
const ALIAS_A = '11111111-1111-4111-8111-222222222222';
const ACCOUNT_B = '22222222-2222-4222-8222-222222222222';
const SESSION_A = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const SESSION_A2 = 'aaaaaaaa-aaaa-4aaa-8aaa-bbbbbbbbbbbb';
const SESSION_B = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const NOW = new Date('2026-07-17T06:00:00.000Z');

test('registration canonicalizes an alias session, accepts a large safe counter, and stores UI summary data', async () => {
  const fixture = createFixture({ aliasSession: true });
  const largeCounter = 4_294_967_296 + 1234;
  fixture.registrationCounter = largeCounter;
  const service = fixture.service();
  const session = freshManageSession(ALIAS_A, SESSION_A);

  const started = await service.beginRegistration(session, NOW);
  assert.equal(fixture.db.state.challenges[0]?.accountId, ACCOUNT_A);
  assert.equal(fixture.db.state.challenges[0]?.sessionId, SESSION_A);
  assert.equal(started.options.user.id, Buffer.from(ACCOUNT_A).toString('base64url'));

  const result = await service.finishRegistration(session, {
    ceremonyId: started.ceremonyId,
    name: '  Work laptop  ',
    response: registrationResponse('credential-alias'),
  }, NOW);
  assert.equal(result.passkey.name, 'Work laptop');
  assert.equal(result.passkey.deviceType, 'multiDevice');
  assert.equal(fixture.db.state.credentials[0]?.accountId, ACCOUNT_A);
  assert.equal(fixture.db.state.credentials[0]?.counter, BigInt(largeCounter));
});

test('a verification failure consumes the challenge and rejects replay', async () => {
  const fixture = createFixture();
  fixture.registrationFailure = true;
  const service = fixture.service();
  const session = freshManageSession(ACCOUNT_A, SESSION_A);
  const started = await service.beginRegistration(session, NOW);

  await assert.rejects(service.finishRegistration(session, {
    ceremonyId: started.ceremonyId,
    name: 'Phone',
    response: registrationResponse('credential-replay'),
  }, NOW));
  assert.equal(fixture.registrationVerifyCalls, 1);
  assert.ok(fixture.db.state.challenges[0]?.consumedAt);

  await assert.rejects(service.finishRegistration(session, {
    ceremonyId: started.ceremonyId,
    name: 'Phone',
    response: registrationResponse('credential-replay'),
  }, NOW), /만료되었거나 이미 사용/u);
  assert.equal(fixture.registrationVerifyCalls, 1);
  assert.equal(fixture.audits[0]?.accountId, ACCOUNT_A);
});

test('step-up challenges reject wrong purpose, session, account, and expiry before verification', async () => {
  const fixture = createFixture({ withCredential: true });
  const service = fixture.service();
  const session = baseSession(ACCOUNT_A, SESSION_A);
  const response = authenticationResponse('credential-a');

  const wrongPurpose = await service.beginStepUp(session, 'wiki_admin', NOW);
  await assert.rejects(service.finishStepUp(session, {
    ceremonyId: wrongPurpose.ceremonyId,
    purpose: 'role_admin',
    response,
  }, NOW));

  const wrongSession = await service.beginStepUp(session, 'wiki_admin', NOW);
  await assert.rejects(service.finishStepUp(baseSession(ACCOUNT_A, SESSION_A2), {
    ceremonyId: wrongSession.ceremonyId,
    purpose: 'wiki_admin',
    response,
  }, NOW));

  const wrongAccount = await service.beginStepUp(session, 'wiki_admin', NOW);
  await assert.rejects(service.finishStepUp(baseSession(ACCOUNT_B, SESSION_B), {
    ceremonyId: wrongAccount.ceremonyId,
    purpose: 'wiki_admin',
    response,
  }, NOW));

  const expired = await service.beginStepUp(session, 'wiki_admin', NOW);
  await assert.rejects(service.finishStepUp(session, {
    ceremonyId: expired.ceremonyId,
    purpose: 'wiki_admin',
    response,
  }, new Date(NOW.getTime() + 6 * 60_000)));
  assert.equal(fixture.authenticationVerifyCalls, 0);
});

test('counter CAS rejects a race and session-rotation failure rolls the counter back', async () => {
  const racing = createFixture({ withCredential: true });
  racing.mutateCounterVersionDuringVerification = true;
  const racingService = racing.service();
  const session = baseSession(ACCOUNT_A, SESSION_A);
  const race = await racingService.beginStepUp(session, 'wiki_admin', NOW);
  await assert.rejects(racingService.finishStepUp(session, {
    ceremonyId: race.ceremonyId,
    purpose: 'wiki_admin',
    response: authenticationResponse('credential-a'),
  }, NOW), /동시에 변경/u);
  assert.equal(racing.db.state.credentials[0]?.counter, 7n);

  const rollback = createFixture({ withCredential: true, rotateFailure: true });
  const rollbackService = rollback.service();
  const attempt = await rollbackService.beginStepUp(session, 'wiki_admin', NOW);
  await assert.rejects(rollbackService.finishStepUp(session, {
    ceremonyId: attempt.ceremonyId,
    purpose: 'wiki_admin',
    response: authenticationResponse('credential-a'),
  }, NOW), /rotation failed/u);
  assert.equal(rollback.db.state.credentials[0]?.counter, 7n);
  assert.equal(rollback.db.state.credentials[0]?.counterVersion, 0);
  assert.ok(rollback.db.state.challenges[0]?.consumedAt);
});

test('passkey deletion is ownership-bound and preserves a last factor for protected accounts', async () => {
  const fixture = createFixture({ withCredential: true, protectedAccount: true });
  fixture.db.state.credentials.push(testCredential({
    id: '33333333-3333-4333-8333-333333333333',
    accountId: ACCOUNT_B,
    credentialId: 'credential-b',
    name: 'Other account key',
  }));
  const service = fixture.service();
  const session = freshManageSession(ACCOUNT_A, SESSION_A);

  await assert.rejects(
    service.deletePasskey(session, '33333333-3333-4333-8333-333333333333', NOW),
    /찾을 수 없습니다/u,
  );
  assert.equal(fixture.db.state.credentials.length, 2);
  await assert.rejects(
    service.deletePasskey(session, '11111111-aaaa-4aaa-8aaa-111111111111', NOW),
    /하나 이상 남아/u,
  );

  fixture.db.state.totpCredentials.push({
    id: 'totp-a',
    accountId: ACCOUNT_A,
    enabledAt: NOW,
  });
  const deleted = await service.deletePasskey(session, '11111111-aaaa-4aaa-8aaa-111111111111', NOW);
  assert.match(deleted.session.cookie, /rotated/u);
  assert.equal(fixture.db.state.credentials.some((item) => item.accountId === ACCOUNT_A), false);
});

test('isElevated alone grants no passkey registration or deletion privilege', async () => {
  const fixture = createFixture({ withCredential: true });
  const service = fixture.service();
  const elevatedOnly = {
    ...baseSession(ACCOUNT_A, SESSION_A),
    isElevated: true,
    authLevel: 'aal1' as const,
    stepUpAt: null,
    stepUpExpiresAt: null,
    stepUpMethod: null,
    stepUpPurpose: null,
  };
  await assert.rejects(service.beginRegistration(elevatedOnly, NOW), /다중 인증을 다시 확인/u);
  await assert.rejects(
    service.deletePasskey(elevatedOnly, '11111111-aaaa-4aaa-8aaa-111111111111', NOW),
    /다중 인증을 다시 확인/u,
  );
});

test('canonical cycles, inactive aliases, and an account merge during verification fail closed', async () => {
  const cycle = createFixture({ withCredential: true });
  cycle.db.state.accounts.find(({ id }) => id === ACCOUNT_A)!.canonicalAccountId = ALIAS_A;
  cycle.db.state.accounts.find(({ id }) => id === ALIAS_A)!.canonicalAccountId = ACCOUNT_A;
  await assert.rejects(
    cycle.service().beginStepUp(baseSession(ACCOUNT_A, SESSION_A), 'wiki_admin', NOW),
    /순환/u,
  );

  const inactive = createFixture({ aliasSession: true });
  inactive.db.state.accounts.find(({ id }) => id === ALIAS_A)!.lifecycleStatus = 'suspended';
  await assert.rejects(
    inactive.service().beginRegistration(freshManageSession(ALIAS_A, SESSION_A), NOW),
    /활성 상태/u,
  );

  const merging = createFixture();
  merging.mutateCanonicalDuringRegistration = true;
  const mergingService = merging.service();
  const registration = await mergingService.beginRegistration(freshManageSession(ACCOUNT_A, SESSION_A), NOW);
  await assert.rejects(mergingService.finishRegistration(freshManageSession(ACCOUNT_A, SESSION_A), {
    ceremonyId: registration.ceremonyId,
    name: 'Merge race',
    response: registrationResponse('credential-merge-race'),
  }, NOW), /계정 연결 상태가 변경/u);
  assert.equal(merging.db.state.credentials.length, 0);
});

test('database-backed name uniqueness closes concurrent duplicate-name registration', async () => {
  const fixture = createFixture();
  const service = fixture.service();
  const firstSession = freshManageSession(ACCOUNT_A, SESSION_A);
  const secondSession = freshManageSession(ACCOUNT_A, SESSION_A2);
  const [first, second] = await Promise.all([
    service.beginRegistration(firstSession, NOW),
    service.beginRegistration(secondSession, NOW),
  ]);
  const outcomes = await Promise.allSettled([
    service.finishRegistration(firstSession, {
      ceremonyId: first.ceremonyId,
      name: 'Shared name',
      response: registrationResponse('credential-name-one'),
    }, NOW),
    service.finishRegistration(secondSession, {
      ceremonyId: second.ceremonyId,
      name: 'shared NAME',
      response: registrationResponse('credential-name-two'),
    }, NOW),
  ]);
  assert.equal(outcomes.filter(({ status }) => status === 'fulfilled').length, 1);
  assert.equal(outcomes.filter(({ status }) => status === 'rejected').length, 1);
  assert.equal(fixture.db.state.credentials.length, 1);
});

function createFixture(options: {
  aliasSession?: boolean;
  withCredential?: boolean;
  protectedAccount?: boolean;
  rotateFailure?: boolean;
} = {}) {
  const db = new MemoryPrisma({
    accounts: [
      { id: ACCOUNT_A, canonicalAccountId: ACCOUNT_A, lifecycleStatus: 'active', displayName: 'Primary' },
      { id: ALIAS_A, canonicalAccountId: ACCOUNT_A, lifecycleStatus: 'active', displayName: 'Alias' },
      { id: ACCOUNT_B, canonicalAccountId: ACCOUNT_B, lifecycleStatus: 'active', displayName: 'Other' },
    ],
    sessions: [
      { id: SESSION_A, accountId: options.aliasSession ? ALIAS_A : ACCOUNT_A, tokenVersion: 1, expiresAt: new Date(NOW.getTime() + 3_600_000) },
      { id: SESSION_A2, accountId: ACCOUNT_A, tokenVersion: 1, expiresAt: new Date(NOW.getTime() + 3_600_000) },
      { id: SESSION_B, accountId: ACCOUNT_B, tokenVersion: 1, expiresAt: new Date(NOW.getTime() + 3_600_000) },
    ],
    credentials: options.withCredential ? [testCredential()] : [],
    protectedRoleAccountIds: options.protectedAccount ? [ACCOUNT_A] : [],
  });
  const fixture = {
    db,
    audits: [] as Array<{ action: string; accountId: string | null }>,
    registrationFailure: false,
    registrationCounter: 0,
    registrationVerifyCalls: 0,
    authenticationVerifyCalls: 0,
    mutateCounterVersionDuringVerification: false,
    mutateCanonicalDuringRegistration: false,
    service() {
      const sessions = {
        async rotateSession(
          sessionId: string,
          rotate: { expectedTokenVersion: number },
          store: { session: { updateMany(input: unknown): Promise<{ count: number }> } },
        ) {
          await store.session.updateMany({
            where: { id: sessionId, tokenVersion: rotate.expectedTokenVersion },
            data: { tokenVersion: { increment: 1 } },
          });
          if (options.rotateFailure) throw new Error('rotation failed');
          return {
            sessionId,
            cookie: 'mw_session=rotated; Secure',
            expiresAt: new Date(NOW.getTime() + 3_600_000).toISOString(),
            policyConsent: { required: false },
            stepUpExpiresAt: new Date(NOW.getTime() + 300_000).toISOString(),
          };
        },
      } as unknown as SessionService;
      const events = {
        async audit(action: string, input: { actorAccountId?: string | null }) {
          fixture.audits.push({ action, accountId: input.actorAccountId ?? null });
        },
      } as unknown as BusinessEventService;
      const config = {
        get(key: string) {
          if (key === 'WEBAUTHN_ORIGIN') return 'https://minewiki.kr';
          if (key === 'WEBAUTHN_RP_ID') return 'minewiki.kr';
          throw new Error(`unexpected config ${key}`);
        },
      } as ConfigService;
      const adapter: WebAuthnServerAdapter = {
        ...DEFAULT_WEBAUTHN_SERVER,
        async verifyRegistrationResponse(options) {
          fixture.registrationVerifyCalls += 1;
          if (fixture.registrationFailure) throw new Error('invalid registration');
          if (fixture.mutateCanonicalDuringRegistration) {
            fixture.db.state.accounts.find(({ id }) => id === ACCOUNT_A)!.canonicalAccountId = ACCOUNT_B;
          }
          return {
            verified: true,
            registrationInfo: {
              fmt: 'none',
              aaguid: '00000000-0000-0000-0000-000000000000',
              credential: {
                id: options.response.id,
                publicKey: Uint8Array.from([1, 2, 3]) as ReturnType<Uint8Array['slice']>,
                counter: fixture.registrationCounter,
                transports: ['internal'],
              },
              credentialType: 'public-key',
              attestationObject: Uint8Array.from([1]) as ReturnType<Uint8Array['slice']>,
              userVerified: true,
              credentialDeviceType: 'multiDevice',
              credentialBackedUp: true,
              origin: 'https://minewiki.kr',
              rpID: 'minewiki.kr',
            },
          } satisfies VerifiedRegistrationResponse;
        },
        async verifyAuthenticationResponse() {
          fixture.authenticationVerifyCalls += 1;
          if (fixture.mutateCounterVersionDuringVerification) {
            const credential = fixture.db.state.credentials[0];
            if (credential) credential.counterVersion += 1;
          }
          return {
            verified: true,
            authenticationInfo: {
              credentialID: 'credential-a',
              newCounter: 8,
              userVerified: true,
              credentialDeviceType: 'singleDevice',
              credentialBackedUp: false,
              origin: 'https://minewiki.kr',
              rpID: 'minewiki.kr',
            },
          } satisfies VerifiedAuthenticationResponse;
        },
      };
      return new WebAuthnService(db.asPrisma(), sessions, events, config, adapter);
    },
  };
  return fixture;
}

function testCredential(input: Partial<TestCredential> = {}): TestCredential {
  return {
    id: input.id ?? '11111111-aaaa-4aaa-8aaa-111111111111',
    accountId: input.accountId ?? ACCOUNT_A,
    credentialId: input.credentialId ?? 'credential-a',
    name: input.name ?? 'Primary key',
    publicKey: Uint8Array.from([1, 2, 3]),
    counter: input.counter ?? 7n,
    counterVersion: input.counterVersion ?? 0,
    transports: input.transports ?? ['internal'],
    deviceType: input.deviceType ?? 'singleDevice',
    backedUp: input.backedUp ?? false,
    createdAt: input.createdAt ?? NOW,
    updatedAt: input.updatedAt ?? NOW,
    lastUsedAt: input.lastUsedAt ?? null,
  };
}

function baseSession(userId: string, sessionId: string): SessionPayload {
  return {
    sessionId,
    userId,
    tokenVersion: 1,
    isElevated: false,
    authenticatedAt: new Date(NOW.getTime() - 60_000).toISOString(),
    authLevel: 'aal1',
  };
}

function freshManageSession(userId: string, sessionId: string): SessionPayload {
  return {
    ...baseSession(userId, sessionId),
    authLevel: 'aal2',
    stepUpAt: new Date(NOW.getTime() - 30_000).toISOString(),
    stepUpExpiresAt: new Date(NOW.getTime() + 270_000).toISOString(),
    stepUpMethod: 'totp',
    stepUpPurpose: 'mfa_manage',
  };
}

function registrationResponse(id: string): RegistrationResponseJSON {
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'Y2xpZW50',
      attestationObject: 'YXR0ZXN0YXRpb24',
      transports: ['internal'],
    },
  };
}

function authenticationResponse(id: string): AuthenticationResponseJSON {
  return {
    id,
    rawId: id,
    type: 'public-key',
    clientExtensionResults: {},
    response: {
      clientDataJSON: 'Y2xpZW50',
      authenticatorData: 'YXV0aA',
      signature: 'c2lnbmF0dXJl',
    },
  };
}
