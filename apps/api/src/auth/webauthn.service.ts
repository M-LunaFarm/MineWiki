import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import type { Prisma } from '@prisma/client';
import {
  generateAuthenticationOptions,
  generateRegistrationOptions,
  verifyAuthenticationResponse,
  verifyRegistrationResponse,
  type AuthenticationResponseJSON,
  type AuthenticatorTransportFuture,
  type PublicKeyCredentialCreationOptionsJSON,
  type PublicKeyCredentialRequestOptionsJSON,
  type RegistrationResponseJSON,
  type VerifiedAuthenticationResponse,
  type VerifiedRegistrationResponse,
} from '@simplewebauthn/server';
import { PrismaService } from '../common/prisma.service';
import { BusinessEventService } from '../events/business-event.service';
import {
  SessionService,
  assertFreshStepUp,
  type RotatedSession,
  type SessionPayload,
  type StepUpPurpose,
} from '../session/session.service';
import { withActiveCanonicalAccountGroup } from './account-lifecycle-fence';
import { PROTECTED_ROLE_CODES } from '../roles/role-policy';

const CHALLENGE_TTL_MS = 5 * 60 * 1000;
const CEREMONY_TIMEOUT_MS = 2 * 60 * 1000;
export const MAX_PASSKEYS_PER_ACCOUNT = 10;
const MAX_CREDENTIAL_ID_LENGTH = 512;
const MAX_PUBLIC_KEY_BYTES = 8192;
const MAX_COUNTER = Number.MAX_SAFE_INTEGER;

type CeremonyOperation = 'registration' | 'step_up';

export interface WebAuthnServerAdapter {
  generateRegistrationOptions: typeof generateRegistrationOptions;
  verifyRegistrationResponse: typeof verifyRegistrationResponse;
  generateAuthenticationOptions: typeof generateAuthenticationOptions;
  verifyAuthenticationResponse: typeof verifyAuthenticationResponse;
}

export const WEBAUTHN_SERVER = Symbol('WEBAUTHN_SERVER');
export const DEFAULT_WEBAUTHN_SERVER: WebAuthnServerAdapter = {
  generateRegistrationOptions,
  verifyRegistrationResponse,
  generateAuthenticationOptions,
  verifyAuthenticationResponse,
};

export interface PasskeySummary {
  readonly id: string;
  readonly name: string;
  readonly transports: readonly AuthenticatorTransportFuture[];
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly createdAt: string;
  readonly lastUsedAt: string | null;
}

export interface CeremonyOptions<T> {
  readonly ceremonyId: string;
  readonly expiresAt: string;
  readonly options: T;
}

export interface PasskeyRegistrationResult {
  readonly passkey: PasskeySummary;
}

export interface PasskeyStepUpResult {
  readonly session: RotatedSession;
  readonly purpose: StepUpPurpose;
}

interface ClaimedChallenge {
  readonly canonicalAccountId: string;
  readonly challenge: string;
}

interface AuthenticationCredentialSnapshot {
  readonly id: string;
  readonly credentialId: string;
  readonly publicKey: ReturnType<Uint8Array['slice']>;
  readonly counter: bigint;
  readonly counterVersion: number;
  readonly transports: AuthenticatorTransportFuture[];
}

@Injectable()
export class WebAuthnService {
  private readonly expectedOrigin: string;
  private readonly rpId: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly events: BusinessEventService,
    config: ConfigService,
    @Inject(WEBAUTHN_SERVER) private readonly webauthn: WebAuthnServerAdapter,
  ) {
    this.expectedOrigin = config.get('WEBAUTHN_ORIGIN');
    this.rpId = config.get('WEBAUTHN_RP_ID');
  }

  async beginRegistration(
    session: SessionPayload,
    now = new Date(),
  ): Promise<CeremonyOptions<PublicKeyCredentialCreationOptionsJSON>> {
    assertFreshStepUp(session, 'mfa_manage', now.getTime());
    return withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        const canonical = await resolveCanonicalAccount(tx, session.userId, group.accountIds);
        await assertCurrentSession(tx, session, group.accountIds, now);
        const credentials = await tx.webAuthnCredential.findMany({
          where: { accountId: canonical.id },
          orderBy: { createdAt: 'asc' },
        });
        if (credentials.length >= MAX_PASSKEYS_PER_ACCOUNT) {
          throw new ConflictException({
            code: 'PASSKEY_LIMIT_REACHED',
            message: `패스키는 계정당 최대 ${MAX_PASSKEYS_PER_ACCOUNT}개까지 등록할 수 있습니다.`,
          });
        }
        const options = await this.webauthn.generateRegistrationOptions({
          rpName: 'MineWiki',
          rpID: this.rpId,
          userID: new TextEncoder().encode(canonical.id),
          userName: canonical.id,
          userDisplayName: canonical.displayName?.slice(0, 64) ?? 'MineWiki user',
          timeout: CEREMONY_TIMEOUT_MS,
          attestationType: 'none',
          excludeCredentials: credentials.map((credential) => ({
            id: credential.credentialId,
            transports: parseTransports(credential.transports),
          })),
          authenticatorSelection: {
            residentKey: 'preferred',
            userVerification: 'required',
          },
          supportedAlgorithmIDs: [-7, -257],
        });
        return this.storeChallenge(
          tx,
          session,
          canonical.id,
          'registration',
          null,
          options.challenge,
          now,
          options,
        );
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );
  }

  async finishRegistration(
    session: SessionPayload,
    input: {
      readonly ceremonyId: string;
      readonly name: string;
      readonly response: RegistrationResponseJSON;
    },
    now = new Date(),
  ): Promise<PasskeyRegistrationResult> {
    assertFreshStepUp(session, 'mfa_manage', now.getTime());
    if (input.response.id !== input.response.rawId) {
      throw new BadRequestException('패스키 응답의 자격 증명 ID가 일치하지 않습니다.');
    }
    const claim = await this.claimChallenge(
      session,
      input.ceremonyId,
      'registration',
      null,
      now,
    );

    let verification: VerifiedRegistrationResponse;
    try {
      verification = await this.webauthn.verifyRegistrationResponse({
        response: input.response,
        expectedChallenge: claim.challenge,
        expectedOrigin: this.expectedOrigin,
        expectedRPID: this.rpId,
        requireUserVerification: true,
        supportedAlgorithmIDs: [-7, -257],
      });
    } catch {
      await this.auditFailure('registration', claim.canonicalAccountId, null, 'verification_failed');
      throw new BadRequestException({
        code: 'PASSKEY_REGISTRATION_INVALID',
        message: '패스키 등록 응답을 확인할 수 없습니다. 다시 시작해 주세요.',
      });
    }
    if (!verification.verified || !verification.registrationInfo) {
      await this.auditFailure('registration', claim.canonicalAccountId, null, 'not_verified');
      throw new BadRequestException('패스키 등록을 확인할 수 없습니다.');
    }
    if (verification.registrationInfo.fmt !== 'none') {
      await this.auditFailure('registration', claim.canonicalAccountId, null, 'attestation_not_none');
      throw new BadRequestException('이 패스키 등록은 none attestation을 사용해야 합니다.');
    }

    const credential = verification.registrationInfo.credential;
    assertCredentialId(credential.id);
    if (credential.id !== input.response.id) {
      throw new BadRequestException('검증된 패스키가 요청 자격 증명과 일치하지 않습니다.');
    }
    if (credential.publicKey.byteLength === 0 || credential.publicKey.byteLength > MAX_PUBLIC_KEY_BYTES) {
      throw new BadRequestException('패스키 공개 키 크기가 허용 범위를 벗어났습니다.');
    }
    const counter = toCounter(credential.counter);
    const transports = sanitizeTransports(credential.transports ?? input.response.response.transports);

    const created = await withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        const canonical = await resolveCanonicalAccount(tx, session.userId, group.accountIds);
        if (canonical.id !== claim.canonicalAccountId) {
          throw new UnauthorizedException('패스키 등록 중 계정 연결 상태가 변경되었습니다.');
        }
        await assertCurrentSession(tx, session, group.accountIds, now);
        const count = await tx.webAuthnCredential.count({ where: { accountId: canonical.id } });
        if (count >= MAX_PASSKEYS_PER_ACCOUNT) {
          throw new ConflictException('패스키 등록 한도에 도달했습니다.');
        }
        try {
          return await tx.webAuthnCredential.create({
            data: {
              accountId: canonical.id,
              credentialId: credential.id,
              name: normalizePasskeyName(input.name),
              publicKey: Buffer.from(credential.publicKey),
              counter,
              transports,
              deviceType: verification.registrationInfo.credentialDeviceType,
              backedUp: verification.registrationInfo.credentialBackedUp,
            },
          });
        } catch (error) {
          if (isPrismaUniqueViolation(error)) {
            throw new ConflictException('이미 등록된 패스키입니다.');
          }
          throw error;
        }
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );

    await this.events.audit('auth.mfa.passkey_registered', {
      category: 'auth',
      actorAccountId: claim.canonicalAccountId,
      subjectType: 'webauthn_credential',
      subjectId: created.id,
      metadata: {
        deviceType: created.deviceType,
        backedUp: created.backedUp,
        transportCount: transports.length,
      },
    });
    return { passkey: toPasskeySummary(created) };
  }

  async beginStepUp(
    session: SessionPayload,
    purpose: StepUpPurpose,
    now = new Date(),
  ): Promise<CeremonyOptions<PublicKeyCredentialRequestOptionsJSON>> {
    return withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        const canonical = await resolveCanonicalAccount(tx, session.userId, group.accountIds);
        await assertCurrentSession(tx, session, group.accountIds, now);
        const credentials = await tx.webAuthnCredential.findMany({
          where: { accountId: canonical.id },
          orderBy: { createdAt: 'asc' },
        });
        if (credentials.length === 0) {
          throw new ForbiddenException({
            code: 'PASSKEY_ENROLLMENT_REQUIRED',
            message: '등록된 패스키가 없습니다.',
          });
        }
        const options = await this.webauthn.generateAuthenticationOptions({
          rpID: this.rpId,
          allowCredentials: credentials.map((credential) => ({
            id: credential.credentialId,
            transports: parseTransports(credential.transports),
          })),
          timeout: CEREMONY_TIMEOUT_MS,
          userVerification: 'required',
        });
        return this.storeChallenge(
          tx,
          session,
          canonical.id,
          'step_up',
          purpose,
          options.challenge,
          now,
          options,
        );
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );
  }

  async finishStepUp(
    session: SessionPayload,
    input: {
      readonly ceremonyId: string;
      readonly purpose: StepUpPurpose;
      readonly response: AuthenticationResponseJSON;
    },
    now = new Date(),
  ): Promise<PasskeyStepUpResult> {
    if (input.response.id !== input.response.rawId) {
      throw new BadRequestException('패스키 응답의 자격 증명 ID가 일치하지 않습니다.');
    }
    assertCredentialId(input.response.id);
    const claimed = await this.claimAuthenticationChallenge(session, input, now);
    if (!claimed.credential) {
      await this.auditFailure('step_up', claimed.claim.canonicalAccountId, input.purpose, 'credential_mismatch');
      throw new UnauthorizedException('이 계정에 등록된 패스키가 아닙니다.');
    }

    let verification: VerifiedAuthenticationResponse;
    try {
      verification = await this.webauthn.verifyAuthenticationResponse({
        response: input.response,
        expectedChallenge: claimed.claim.challenge,
        expectedOrigin: this.expectedOrigin,
        expectedRPID: this.rpId,
        credential: {
          id: claimed.credential.credentialId,
          publicKey: claimed.credential.publicKey,
          counter: Number(claimed.credential.counter),
          transports: claimed.credential.transports,
        },
        requireUserVerification: true,
      });
    } catch {
      await this.auditFailure('step_up', claimed.claim.canonicalAccountId, input.purpose, 'verification_failed');
      throw new UnauthorizedException({
        code: 'PASSKEY_ASSERTION_INVALID',
        message: '패스키 인증 응답을 확인할 수 없습니다. 다시 시작해 주세요.',
      });
    }
    if (!verification.verified || !verification.authenticationInfo.userVerified) {
      await this.auditFailure('step_up', claimed.claim.canonicalAccountId, input.purpose, 'not_verified');
      throw new UnauthorizedException('패스키 사용자 확인에 실패했습니다.');
    }
    const newCounter = toCounter(verification.authenticationInfo.newCounter);
    const result = await withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        const canonical = await resolveCanonicalAccount(tx, session.userId, group.accountIds);
        if (canonical.id !== claimed.claim.canonicalAccountId) {
          throw new UnauthorizedException('패스키 인증 중 계정 연결 상태가 변경되었습니다.');
        }
        await assertCurrentSession(tx, session, group.accountIds, now);
        const updated = await tx.webAuthnCredential.updateMany({
          where: {
            id: claimed.credential!.id,
            accountId: canonical.id,
            credentialId: input.response.id,
            counter: claimed.credential!.counter,
            counterVersion: claimed.credential!.counterVersion,
          },
          data: {
            counter: newCounter,
            counterVersion: { increment: 1 },
            deviceType: verification.authenticationInfo.credentialDeviceType,
            backedUp: verification.authenticationInfo.credentialBackedUp,
            lastUsedAt: now,
          },
        });
        if (updated.count !== 1) {
          throw new ConflictException({
            code: 'PASSKEY_COUNTER_RACE',
            message: '패스키 사용 상태가 동시에 변경되었습니다. 새 인증을 시작해 주세요.',
          });
        }
        const rotated = await this.sessions.rotateSession(
          session.sessionId,
          {
            expectedTokenVersion: session.tokenVersion,
            stepUp: { method: 'webauthn', purpose: input.purpose },
          },
          tx,
        );
        return { rotated };
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );

    await this.events.audit('auth.mfa.step_up_succeeded', {
      category: 'auth',
      actorAccountId: claimed.claim.canonicalAccountId,
      subjectType: 'account',
      subjectId: claimed.claim.canonicalAccountId,
      metadata: { method: 'webauthn', purpose: input.purpose },
    });
    return { session: result.rotated, purpose: input.purpose };
  }

  async deletePasskey(
    session: SessionPayload,
    passkeyId: string,
    now = new Date(),
  ): Promise<{ readonly session: RotatedSession }> {
    assertFreshStepUp(session, 'mfa_manage', now.getTime());
    const result = await withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        const canonical = await resolveCanonicalAccount(tx, session.userId, group.accountIds);
        await assertCurrentSession(tx, session, group.accountIds, now);
        const passkey = await tx.webAuthnCredential.findFirst({
          where: { id: passkeyId, accountId: canonical.id },
        });
        if (!passkey) throw new NotFoundException('패스키를 찾을 수 없습니다.');

        const [protectedRoleCount, totp, passkeyCount] = await Promise.all([
          tx.accountRole.count({
            where: {
              accountId: { in: [...group.accountIds] },
              role: { code: { in: [...PROTECTED_ROLE_CODES] } },
            },
          }),
          tx.mfaTotpCredential.findUnique({
            where: { accountId: canonical.id },
            select: { enabledAt: true },
          }),
          tx.webAuthnCredential.count({ where: { accountId: canonical.id } }),
        ]);
        if (protectedRoleCount > 0 && !totp?.enabledAt && passkeyCount <= 1) {
          throw new ConflictException(
            '보호된 관리자 역할을 보유한 계정에는 사용 가능한 다중 인증 수단이 하나 이상 남아 있어야 합니다.',
          );
        }
        await tx.webAuthnCredential.delete({ where: { id: passkey.id } });
        await tx.session.deleteMany({
          where: { accountId: { in: [...group.accountIds] }, id: { not: session.sessionId } },
        });
        const rotated = await this.sessions.rotateSession(
          session.sessionId,
          { expectedTokenVersion: session.tokenVersion, clearStepUp: true },
          tx,
        );
        return { canonicalId: canonical.id, passkey, rotated };
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );
    await this.events.audit('auth.mfa.passkey_deleted', {
      category: 'auth',
      severity: 'warning',
      actorAccountId: result.canonicalId,
      subjectType: 'webauthn_credential',
      subjectId: result.passkey.id,
      metadata: { otherSessionsRevoked: true },
    });
    return { session: result.rotated };
  }

  private async storeChallenge<T>(
    tx: Prisma.TransactionClient,
    session: SessionPayload,
    canonicalAccountId: string,
    operation: CeremonyOperation,
    purpose: StepUpPurpose | null,
    challenge: string,
    now: Date,
    options: T,
  ): Promise<CeremonyOptions<T>> {
    const expiresAt = new Date(now.getTime() + CHALLENGE_TTL_MS);
    await tx.webAuthnChallenge.deleteMany({
      where: {
        accountId: canonicalAccountId,
        OR: [
          { expiresAt: { lte: now } },
          { consumedAt: { not: null } },
          { sessionId: session.sessionId, operation, purpose },
        ],
      },
    });
    const stored = await tx.webAuthnChallenge.create({
      data: {
        accountId: canonicalAccountId,
        sessionId: session.sessionId,
        sessionTokenVersion: session.tokenVersion,
        operation,
        purpose,
        challenge,
        expiresAt,
      },
    });
    return { ceremonyId: stored.id, expiresAt: expiresAt.toISOString(), options };
  }

  private async claimChallenge(
    session: SessionPayload,
    ceremonyId: string,
    operation: CeremonyOperation,
    purpose: StepUpPurpose | null,
    now: Date,
  ): Promise<ClaimedChallenge> {
    return withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        const canonical = await resolveCanonicalAccount(tx, session.userId, group.accountIds);
        await assertCurrentSession(tx, session, group.accountIds, now);
        const consumed = await tx.webAuthnChallenge.updateMany({
          where: {
            id: ceremonyId,
            accountId: canonical.id,
            sessionId: session.sessionId,
            sessionTokenVersion: session.tokenVersion,
            operation,
            purpose,
            consumedAt: null,
            expiresAt: { gt: now },
          },
          data: { consumedAt: now },
        });
        if (consumed.count !== 1) {
          throw new BadRequestException({
            code: 'WEBAUTHN_CEREMONY_INVALID',
            message: '패스키 요청이 만료되었거나 이미 사용되었습니다. 다시 시작해 주세요.',
          });
        }
        const challenge = await tx.webAuthnChallenge.findUnique({ where: { id: ceremonyId } });
        if (!challenge) throw new BadRequestException('패스키 요청을 찾을 수 없습니다.');
        return { canonicalAccountId: canonical.id, challenge: challenge.challenge };
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );
  }

  private async claimAuthenticationChallenge(
    session: SessionPayload,
    input: {
      readonly ceremonyId: string;
      readonly purpose: StepUpPurpose;
      readonly response: AuthenticationResponseJSON;
    },
    now: Date,
  ): Promise<{
    readonly claim: ClaimedChallenge;
    readonly credential: AuthenticationCredentialSnapshot | null;
  }> {
    const claim = await this.claimChallenge(session, input.ceremonyId, 'step_up', input.purpose, now);
    const credential = await this.prisma.webAuthnCredential.findFirst({
      where: {
        accountId: claim.canonicalAccountId,
        credentialId: input.response.id,
      },
    });
    return {
      claim,
      credential: credential
        ? {
            id: credential.id,
            credentialId: credential.credentialId,
            publicKey: Uint8Array.from(credential.publicKey) as ReturnType<Uint8Array['slice']>,
            counter: credential.counter,
            counterVersion: credential.counterVersion,
            transports: parseTransports(credential.transports),
          }
        : null,
    };
  }

  private async auditFailure(
    operation: CeremonyOperation,
    accountId: string,
    purpose: StepUpPurpose | null,
    reason: string,
  ): Promise<void> {
    await this.events.audit('auth.mfa.webauthn_failed', {
      category: 'auth',
      severity: 'info',
      actorAccountId: accountId,
      subjectType: 'account',
      subjectId: accountId,
      metadata: { operation, purpose, reason },
    });
  }
}

async function resolveCanonicalAccount(
  tx: Prisma.TransactionClient,
  seedAccountId: string,
  groupAccountIds: readonly string[],
): Promise<{ readonly id: string; readonly displayName: string | null }> {
  const visited = new Set<string>();
  let currentId = seedAccountId;
  while (true) {
    if (visited.has(currentId)) {
      throw new UnauthorizedException('대표 계정 연결에 순환이 감지되었습니다.');
    }
    visited.add(currentId);
    const current = await tx.account.findUnique({
      where: { id: currentId },
      select: { id: true, canonicalAccountId: true, displayName: true, lifecycleStatus: true },
    });
    if (!current || current.lifecycleStatus !== 'active' || !groupAccountIds.includes(current.id)) {
      throw new UnauthorizedException('활성 대표 계정을 확인할 수 없습니다.');
    }
    if (!current.canonicalAccountId || current.canonicalAccountId === current.id) {
      return { id: current.id, displayName: current.displayName };
    }
    if (!groupAccountIds.includes(current.canonicalAccountId)) {
      throw new UnauthorizedException('대표 계정이 현재 계정 그룹과 일치하지 않습니다.');
    }
    currentId = current.canonicalAccountId;
  }
}

async function assertCurrentSession(
  tx: Prisma.TransactionClient,
  session: SessionPayload,
  activeGroupAccountIds: readonly string[],
  now: Date,
): Promise<void> {
  const current = await tx.session.findFirst({
    where: {
      id: session.sessionId,
      accountId: { in: [...activeGroupAccountIds] },
      tokenVersion: session.tokenVersion,
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  if (!current) {
    throw new UnauthorizedException('현재 세션이 패스키 요청과 일치하지 않습니다.');
  }
}

function normalizePasskeyName(value: string): string {
  const normalized = value.trim().replace(/\s+/gu, ' ');
  if (!normalized || normalized.length > 64) {
    throw new BadRequestException('패스키 이름은 1자 이상 64자 이하여야 합니다.');
  }
  return normalized;
}

function assertCredentialId(value: string): void {
  if (
    value.length === 0 ||
    value.length > MAX_CREDENTIAL_ID_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(value)
  ) {
    throw new BadRequestException('패스키 자격 증명 ID 형식이 올바르지 않습니다.');
  }
}

function toCounter(value: number): bigint {
  if (!Number.isSafeInteger(value) || value < 0 || value > MAX_COUNTER) {
    throw new BadRequestException('패스키 서명 카운터가 허용 범위를 벗어났습니다.');
  }
  return BigInt(value);
}

function sanitizeTransports(
  values: readonly string[] | undefined,
): AuthenticatorTransportFuture[] {
  const allowed = new Set<AuthenticatorTransportFuture>([
    'ble',
    'cable',
    'hybrid',
    'internal',
    'nfc',
    'smart-card',
    'usb',
  ]);
  return [...new Set((values ?? []).filter((value): value is AuthenticatorTransportFuture =>
    allowed.has(value as AuthenticatorTransportFuture),
  ))].slice(0, 7);
}

function parseTransports(value: Prisma.JsonValue | null): AuthenticatorTransportFuture[] {
  return sanitizeTransports(Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []);
}

function toPasskeySummary(credential: {
  readonly id: string;
  readonly name: string;
  readonly transports: Prisma.JsonValue | null;
  readonly deviceType: string;
  readonly backedUp: boolean;
  readonly createdAt: Date;
  readonly lastUsedAt: Date | null;
}): PasskeySummary {
  return {
    id: credential.id,
    name: credential.name,
    transports: parseTransports(credential.transports),
    deviceType: credential.deviceType,
    backedUp: credential.backedUp,
    createdAt: credential.createdAt.toISOString(),
    lastUsedAt: credential.lastUsedAt?.toISOString() ?? null,
  };
}

function isPrismaUniqueViolation(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'P2002');
}
