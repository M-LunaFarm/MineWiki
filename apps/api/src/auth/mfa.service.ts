import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  HttpStatus,
  Injectable,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import { decryptAppSecret, encryptAppSecret } from '../common/secret-codec';
import { BusinessEventService } from '../events/business-event.service';
import {
  SessionService,
  assertFreshStepUp,
  type RotatedSession,
  type SessionPayload,
  type StepUpMethod,
  type StepUpPurpose,
} from '../session/session.service';
import { withActiveCanonicalAccountGroup } from './account-lifecycle-fence';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  verifyTotpCode,
} from './totp';

const ENROLLMENT_TTL_MS = 10 * 60 * 1000;
const RECENT_PRIMARY_AUTH_MS = 15 * 60 * 1000;
const FAILURE_LOCK_THRESHOLD = 5;
const FAILURE_LOCK_MS = 15 * 60 * 1000;

export interface MfaStatus {
  readonly totpEnabled: boolean;
  readonly pendingEnrollment: boolean;
  readonly pendingExpiresAt: string | null;
  readonly recoveryCodesRemaining: number;
  readonly lockedUntil: string | null;
}

export interface TotpEnrollment {
  readonly secret: string;
  readonly otpauthUri: string;
  readonly expiresAt: string;
}

export interface MfaMutationResult {
  readonly session: RotatedSession;
  readonly recoveryCodes?: readonly string[];
}

@Injectable()
export class MfaService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly sessions: SessionService,
    private readonly events: BusinessEventService,
  ) {}

  async getStatus(accountId: string): Promise<MfaStatus> {
    const canonicalId = await this.getCanonicalAccountId(accountId);
    const [credential, recoveryCodesRemaining] = await Promise.all([
      this.prisma.mfaTotpCredential.findUnique({ where: { accountId: canonicalId } }),
      this.prisma.mfaRecoveryCode.count({
        where: { accountId: canonicalId, usedAt: null },
      }),
    ]);
    const now = Date.now();
    return {
      totpEnabled: Boolean(credential?.enabledAt),
      pendingEnrollment: Boolean(
        credential?.pendingExpiresAt &&
        !credential.enabledAt &&
        credential.pendingExpiresAt.getTime() > now,
      ),
      pendingExpiresAt:
        credential?.pendingExpiresAt && credential.pendingExpiresAt.getTime() > now
          ? credential.pendingExpiresAt.toISOString()
          : null,
      recoveryCodesRemaining,
      lockedUntil:
        credential?.lockedUntil && credential.lockedUntil.getTime() > now
          ? credential.lockedUntil.toISOString()
          : null,
    };
  }

  async beginTotpEnrollment(
    session: SessionPayload,
    now = new Date(),
  ): Promise<TotpEnrollment> {
    assertRecentPrimaryAuthentication(session, now.getTime());
    const secret = generateTotpSecret();
    const encryptedSecret = encryptAppSecret(secret);
    if (!encryptedSecret) throw new Error('TOTP secret encryption failed.');
    const expiresAt = new Date(now.getTime() + ENROLLMENT_TTL_MS);

    const profile = await withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        assertSessionBelongsToGroup(session, group.accountIds);
        const canonical = await canonicalAccount(tx, session.userId);
        const existing = await tx.mfaTotpCredential.findUnique({
          where: { accountId: canonical.id },
        });
        if (existing?.enabledAt) {
          throw new ConflictException('이미 TOTP 다중 인증이 활성화되어 있습니다.');
        }
        await tx.mfaTotpCredential.upsert({
          where: { accountId: canonical.id },
          create: {
            accountId: canonical.id,
            secretCiphertext: encryptedSecret,
            pendingExpiresAt: expiresAt,
          },
          update: {
            secretCiphertext: encryptedSecret,
            pendingExpiresAt: expiresAt,
            enabledAt: null,
            lastUsedStep: null,
            failedAttempts: 0,
            lockedUntil: null,
          },
        });
        return canonical;
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );

    await this.events.audit('auth.mfa.totp_enrollment_started', {
      category: 'auth',
      actorAccountId: profile.id,
      subjectType: 'account',
      subjectId: profile.id,
    });
    const label = profile.email ?? profile.displayName ?? profile.id;
    return {
      secret,
      otpauthUri: createOtpAuthUri(secret, label),
      expiresAt: expiresAt.toISOString(),
    };
  }

  async confirmTotpEnrollment(
    session: SessionPayload,
    code: string,
    now = new Date(),
  ): Promise<MfaMutationResult> {
    assertRecentPrimaryAuthentication(session, now.getTime());
    const recoveryCodes = generateRecoveryCodes();
    const result = await withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        assertSessionBelongsToGroup(session, group.accountIds);
        const canonical = await canonicalAccount(tx, session.userId);
        const credential = await tx.mfaTotpCredential.findUnique({
          where: { accountId: canonical.id },
        });
        if (!credential || credential.enabledAt) {
          throw new BadRequestException('확인할 TOTP 등록이 없습니다.');
        }
        if (!credential.pendingExpiresAt || credential.pendingExpiresAt.getTime() <= now.getTime()) {
          throw new BadRequestException('TOTP 등록 시간이 만료되었습니다. 다시 시작해 주세요.');
        }
        const secret = decryptAppSecret(credential.secretCiphertext);
        const step = secret ? verifyTotpCode(secret, code, now.getTime()) : null;
        if (step === null) {
          throw new BadRequestException('인증 앱의 6자리 코드를 확인해 주세요.');
        }
        await tx.mfaTotpCredential.update({
          where: { id: credential.id },
          data: {
            enabledAt: now,
            pendingExpiresAt: null,
            lastUsedStep: step,
            failedAttempts: 0,
            lockedUntil: null,
          },
        });
        await tx.mfaRecoveryCode.deleteMany({ where: { accountId: canonical.id } });
        await tx.mfaRecoveryCode.createMany({
          data: recoveryCodes.map((recoveryCode) => ({
            accountId: canonical.id,
            codeHash: hashRecoveryCode(recoveryCode),
          })),
        });
        await tx.session.deleteMany({
          where: {
            accountId: { in: [...group.accountIds] },
            id: { not: session.sessionId },
          },
        });
        const rotated = await this.sessions.rotateSession(
          session.sessionId,
          { expectedTokenVersion: session.tokenVersion, clearStepUp: true },
          tx,
        );
        return { canonicalId: canonical.id, rotated };
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );

    await this.events.audit('auth.mfa.totp_enabled', {
      category: 'auth',
      actorAccountId: result.canonicalId,
      subjectType: 'account',
      subjectId: result.canonicalId,
      metadata: { recoveryCodeCount: recoveryCodes.length, otherSessionsRevoked: true },
    });
    return { session: result.rotated, recoveryCodes };
  }

  async stepUp(
    session: SessionPayload,
    input: {
      readonly method: Exclude<StepUpMethod, 'webauthn'>;
      readonly purpose: StepUpPurpose;
      readonly code: string;
    },
    now = new Date(),
  ): Promise<MfaMutationResult> {
    const outcome = await withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        assertSessionBelongsToGroup(session, group.accountIds);
        const canonical = await canonicalAccount(tx, session.userId);
        const credential = await tx.mfaTotpCredential.findUnique({
          where: { accountId: canonical.id },
        });
        if (!credential?.enabledAt) {
          return { ok: false as const, error: 'not_enrolled' as const, canonicalId: canonical.id };
        }
        if (credential.lockedUntil && credential.lockedUntil.getTime() > now.getTime()) {
          return {
            ok: false as const,
            error: 'locked' as const,
            canonicalId: canonical.id,
            lockedUntil: credential.lockedUntil,
          };
        }

        const consumed = input.method === 'totp'
          ? await consumeTotp(tx, credential, input.code, now)
          : await consumeRecoveryCode(tx, canonical.id, input.code, now);
        if (!consumed) {
          const failure = await recordMfaFailure(tx, credential, now);
          return {
            ok: false as const,
            error: failure.lockedUntil ? 'locked' as const : 'invalid' as const,
            canonicalId: canonical.id,
            lockedUntil: failure.lockedUntil,
          };
        }

        await tx.mfaTotpCredential.update({
          where: { id: credential.id },
          data: { failedAttempts: 0, lockedUntil: null },
        });
        const rotated = await this.sessions.rotateSession(
          session.sessionId,
          {
            expectedTokenVersion: session.tokenVersion,
            stepUp: { method: input.method, purpose: input.purpose },
          },
          tx,
        );
        return { ok: true as const, canonicalId: canonical.id, rotated };
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );

    if (!outcome.ok) {
      await this.events.audit('auth.mfa.step_up_failed', {
        category: 'auth',
        severity: outcome.error === 'locked' ? 'warning' : 'info',
        actorAccountId: outcome.canonicalId,
        subjectType: 'account',
        subjectId: outcome.canonicalId,
        metadata: { method: input.method, purpose: input.purpose, reason: outcome.error },
      });
      if (outcome.error === 'not_enrolled') {
        throw new ForbiddenException({
          code: 'MFA_ENROLLMENT_REQUIRED',
          message: '먼저 다중 인증을 등록해 주세요.',
        });
      }
      if (outcome.error === 'locked') {
        throw new HttpException({
          code: 'MFA_TEMPORARILY_LOCKED',
          message: '인증 실패 횟수가 초과되었습니다. 잠시 후 다시 시도해 주세요.',
          lockedUntil: outcome.lockedUntil?.toISOString() ?? null,
        }, HttpStatus.TOO_MANY_REQUESTS);
      }
      throw new UnauthorizedException({
        code: 'MFA_CODE_INVALID',
        message: '다중 인증 코드를 확인해 주세요.',
      });
    }

    await this.events.audit('auth.mfa.step_up_succeeded', {
      category: 'auth',
      actorAccountId: outcome.canonicalId,
      subjectType: 'account',
      subjectId: outcome.canonicalId,
      metadata: { method: input.method, purpose: input.purpose },
    });
    return { session: outcome.rotated };
  }

  async regenerateRecoveryCodes(
    session: SessionPayload,
  ): Promise<MfaMutationResult> {
    assertFreshStepUp(session, 'mfa_manage');
    const recoveryCodes = generateRecoveryCodes();
    const result = await withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        assertSessionBelongsToGroup(session, group.accountIds);
        const canonical = await canonicalAccount(tx, session.userId);
        const credential = await tx.mfaTotpCredential.findUnique({ where: { accountId: canonical.id } });
        if (!credential?.enabledAt) throw new NotFoundException('활성화된 다중 인증이 없습니다.');
        await tx.mfaRecoveryCode.deleteMany({ where: { accountId: canonical.id } });
        await tx.mfaRecoveryCode.createMany({
          data: recoveryCodes.map((code) => ({
            accountId: canonical.id,
            codeHash: hashRecoveryCode(code),
          })),
        });
        const rotated = await this.sessions.rotateSession(
          session.sessionId,
          { expectedTokenVersion: session.tokenVersion },
          tx,
        );
        return { canonicalId: canonical.id, rotated };
      },
    );
    await this.events.audit('auth.mfa.recovery_codes_regenerated', {
      category: 'auth',
      actorAccountId: result.canonicalId,
      subjectType: 'account',
      subjectId: result.canonicalId,
      metadata: { recoveryCodeCount: recoveryCodes.length },
    });
    return { session: result.rotated, recoveryCodes };
  }

  async disableTotp(session: SessionPayload): Promise<MfaMutationResult> {
    assertFreshStepUp(session, 'mfa_manage');
    const result = await withActiveCanonicalAccountGroup(
      this.prisma,
      [session.userId],
      async (tx, group) => {
        assertSessionBelongsToGroup(session, group.accountIds);
        const canonical = await canonicalAccount(tx, session.userId);
        const credential = await tx.mfaTotpCredential.findUnique({ where: { accountId: canonical.id } });
        if (!credential?.enabledAt) throw new NotFoundException('활성화된 다중 인증이 없습니다.');
        await tx.mfaRecoveryCode.deleteMany({ where: { accountId: canonical.id } });
        await tx.mfaTotpCredential.delete({ where: { id: credential.id } });
        await tx.session.deleteMany({
          where: {
            accountId: { in: [...group.accountIds] },
            id: { not: session.sessionId },
          },
        });
        const rotated = await this.sessions.rotateSession(
          session.sessionId,
          { expectedTokenVersion: session.tokenVersion, clearStepUp: true },
          tx,
        );
        return { canonicalId: canonical.id, rotated };
      },
    );
    await this.events.audit('auth.mfa.totp_disabled', {
      category: 'auth',
      severity: 'warning',
      actorAccountId: result.canonicalId,
      subjectType: 'account',
      subjectId: result.canonicalId,
      metadata: { otherSessionsRevoked: true },
    });
    return { session: result.rotated };
  }

  private async getCanonicalAccountId(accountId: string): Promise<string> {
    const account = await this.prisma.account.findUnique({
      where: { id: accountId },
      select: { id: true, canonicalAccountId: true, lifecycleStatus: true },
    });
    if (!account || account.lifecycleStatus !== 'active') {
      throw new UnauthorizedException('계정이 활성 상태가 아닙니다.');
    }
    return account.canonicalAccountId ?? account.id;
  }
}

function assertRecentPrimaryAuthentication(session: SessionPayload, nowMs: number): void {
  const authenticatedAt = Date.parse(session.authenticatedAt);
  if (
    !Number.isFinite(authenticatedAt) ||
    authenticatedAt > nowMs + 30_000 ||
    nowMs - authenticatedAt > RECENT_PRIMARY_AUTH_MS
  ) {
    throw new ForbiddenException({
      code: 'RECENT_LOGIN_REQUIRED',
      message: '다중 인증을 설정하려면 다시 로그인해 주세요.',
    });
  }
}

function assertSessionBelongsToGroup(
  session: SessionPayload,
  accountIds: readonly string[],
): void {
  if (!accountIds.includes(session.userId)) {
    throw new UnauthorizedException('현재 세션이 계정 그룹과 일치하지 않습니다.');
  }
}

async function canonicalAccount(tx: Prisma.TransactionClient, accountId: string) {
  const account = await tx.account.findUnique({
    where: { id: accountId },
    select: { id: true, canonicalAccountId: true, email: true, displayName: true },
  });
  if (!account) throw new UnauthorizedException('계정을 찾을 수 없습니다.');
  const canonicalId = account.canonicalAccountId ?? account.id;
  const canonical = canonicalId === account.id
    ? account
    : await tx.account.findUnique({
        where: { id: canonicalId },
        select: { id: true, canonicalAccountId: true, email: true, displayName: true },
      });
  if (!canonical) throw new UnauthorizedException('대표 계정을 찾을 수 없습니다.');
  return canonical;
}

async function consumeTotp(
  tx: Prisma.TransactionClient,
  credential: {
    readonly id: string;
    readonly secretCiphertext: string;
    readonly lastUsedStep: bigint | null;
  },
  code: string,
  now: Date,
): Promise<boolean> {
  const secret = decryptAppSecret(credential.secretCiphertext);
  const step = secret ? verifyTotpCode(secret, code, now.getTime()) : null;
  if (step === null || (credential.lastUsedStep !== null && step <= credential.lastUsedStep)) {
    return false;
  }
  const consumed = await tx.mfaTotpCredential.updateMany({
    where: {
      id: credential.id,
      OR: [{ lastUsedStep: null }, { lastUsedStep: { lt: step } }],
    },
    data: { lastUsedStep: step },
  });
  return consumed.count === 1;
}

async function consumeRecoveryCode(
  tx: Prisma.TransactionClient,
  accountId: string,
  code: string,
  now: Date,
): Promise<boolean> {
  const codeHash = hashRecoveryCode(code);
  const recovery = await tx.mfaRecoveryCode.findUnique({
    where: { accountId_codeHash: { accountId, codeHash } },
  });
  if (!recovery?.usedAt) {
    const consumed = recovery
      ? await tx.mfaRecoveryCode.updateMany({
          where: { id: recovery.id, usedAt: null },
          data: { usedAt: now },
        })
      : { count: 0 };
    return consumed.count === 1;
  }
  return false;
}

async function recordMfaFailure(
  tx: Prisma.TransactionClient,
  credential: { readonly id: string; readonly failedAttempts: number; readonly lockedUntil: Date | null },
  now: Date,
): Promise<{ readonly lockedUntil: Date | null }> {
  const previousFailures = credential.lockedUntil && credential.lockedUntil.getTime() <= now.getTime()
    ? 0
    : credential.failedAttempts;
  const failedAttempts = previousFailures + 1;
  const lockedUntil = failedAttempts >= FAILURE_LOCK_THRESHOLD
    ? new Date(now.getTime() + FAILURE_LOCK_MS)
    : null;
  await tx.mfaTotpCredential.update({
    where: { id: credential.id },
    data: { failedAttempts, lockedUntil },
  });
  return { lockedUntil };
}

function createOtpAuthUri(secret: string, label: string): string {
  const accountLabel = encodeURIComponent(`MineWiki:${label}`);
  const query = new URLSearchParams({
    secret,
    issuer: 'MineWiki',
    algorithm: 'SHA1',
    digits: '6',
    period: '30',
  });
  return `otpauth://totp/${accountLabel}?${query.toString()}`;
}
