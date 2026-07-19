import { ForbiddenException, Injectable, Optional, UnauthorizedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { serialize } from 'cookie';
import { DEFAULT_SESSION_TTL_SECONDS, MINEWIKI_SESSION_COOKIE } from '@minewiki/auth';
import {
  CURRENT_POLICY_VERSIONS,
  type PolicyConsentStatus,
} from '@minewiki/schemas';
import { PrismaService } from '../common/prisma.service';
import { RoleService } from '../roles/role.service';
import { policyConsentStatus } from './policy-consent';
import { withActiveCanonicalAccountGroup } from '../auth/account-lifecycle-fence';

export interface SessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  issuedAt: Date;
  expiresAt: Date;
  readonly token: string;
  tokenVersion: number;
  isElevated: boolean;
  primaryAuthenticatedAt: Date;
  stepUpAt: Date | null;
  stepUpExpiresAt: Date | null;
  stepUpMethod: string | null;
  stepUpPurpose: string | null;
  permissions: string[];
  groups: string[];
  ipAddress: string | null;
  userAgent: string | null;
  lastActiveAt: Date;
  termsPolicyVersion: string | null;
  privacyPolicyVersion: string | null;
}

export interface IssueSessionOptions {
  readonly userId: string;
  readonly ttlSeconds?: number;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface RotatedSession {
  readonly sessionId: string;
  readonly cookie: string;
  readonly expiresAt: string;
  readonly policyConsent: PolicyConsentStatus;
  readonly stepUpExpiresAt?: string | null;
}

export const STEP_UP_TTL_SECONDS = 5 * 60;
export const STEP_UP_PURPOSES = [
  'wiki_admin',
  'role_admin',
  'server_admin',
  'server_ownership_transfer',
  'wiki_release_review',
  'review_moderation',
  'vote_admin',
  'guild_admin',
  'file_admin',
  'audit_read',
  'account_delete_admin',
  'account_moderation',
  'account_merge_admin',
  'mfa_manage',
  'account_export',
  'email_login_setup',
] as const;
export type StepUpPurpose = (typeof STEP_UP_PURPOSES)[number];
export type StepUpMethod = 'totp' | 'recovery_code' | 'webauthn';

export interface RotateSessionOptions {
  readonly expectedTokenVersion: number;
  readonly clearStepUp?: boolean;
  readonly stepUp?: {
    readonly method: StepUpMethod;
    readonly purpose: StepUpPurpose;
    readonly ttlSeconds?: number;
  };
}

export interface SessionPayload {
  readonly sessionId: string;
  readonly userId: string;
  readonly tokenVersion: number;
  readonly isElevated: boolean;
  readonly authenticatedAt: string;
  readonly authLevel?: 'aal1' | 'aal2';
  readonly stepUpAt?: string | null;
  readonly stepUpExpiresAt?: string | null;
  readonly stepUpMethod?: StepUpMethod | null;
  readonly stepUpPurpose?: StepUpPurpose | null;
  readonly permissions?: readonly string[];
  readonly groups?: readonly string[];
  readonly policyConsent?: PolicyConsentStatus;
  /** Current request address populated only by the central HTTP client-IP extractor. */
  readonly requestIp?: string | null;
}

export interface SessionSummary {
  readonly sessionId: string;
  readonly createdAt: string;
  readonly lastActiveAt: string;
  readonly ipAddress: string | null;
  readonly userAgent: string | null;
  readonly isCurrent: boolean;
  readonly tokenVersion: number;
  readonly isElevated: boolean;
  readonly authLevel: 'aal1' | 'aal2';
  readonly stepUpExpiresAt: string | null;
}

@Injectable()
export class SessionService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly roles?: RoleService
  ) {}

  async issueSession(options: IssueSessionOptions): Promise<RotatedSession> {
    const token = this.generateToken();
    const sessionId = randomUUID();
    const issuedAt = new Date();
    const expiresAt = new Date(
      issuedAt.getTime() + (options.ttlSeconds ?? DEFAULT_SESSION_TTL_SECONDS) * 1000
    );
    const sessionIdentity = await withActiveCanonicalAccountGroup(
      this.prisma,
      [options.userId],
      async (tx, group) => {
        const seedAccount = await tx.account.findUnique({
          where: { id: options.userId },
          select: { id: true, canonicalAccountId: true },
        });
        if (!seedAccount) throw new UnauthorizedException('계정이 존재하지 않습니다.');
        const canonicalAccountId = seedAccount.canonicalAccountId ?? seedAccount.id;
        if (!group.accountIds.includes(canonicalAccountId)) {
          throw new UnauthorizedException('대표 계정 연결 상태를 확인할 수 없습니다.');
        }
        const consents = await tx.accountConsent.findMany({
          where: {
            accountId: { in: [...group.accountIds] },
            consentType: { in: ['terms', 'privacy'] },
          },
          orderBy: { consentedAt: 'desc' },
          select: { consentType: true, policyVersion: true },
        });
        const status = policyConsentStatus(
          consents.find((item) => item.consentType === 'terms')?.policyVersion,
          consents.find((item) => item.consentType === 'privacy')?.policyVersion,
        );
        await tx.session.create({
          data: {
            id: sessionId,
            accountId: canonicalAccountId,
            issuedAt,
            expiresAt,
            token: hashSessionToken(token),
            tokenVersion: 1,
            isElevated: false,
            primaryAuthenticatedAt: issuedAt,
            ipAddress: options.ipAddress ?? null,
            userAgent: options.userAgent ?? null,
            lastActiveAt: issuedAt,
            termsPolicyVersion: status.terms.acceptedVersion,
            privacyPolicyVersion: status.privacy.acceptedVersion,
          },
        });
        return { policyConsent: status, canonicalAccountId };
      },
      { inactiveError: () => new UnauthorizedException('계정이 활성 상태가 아닙니다.') },
    );

    return {
      sessionId,
      cookie: this.serializeCookie({
        sessionId,
        userId: sessionIdentity.canonicalAccountId,
        issuedAt,
        expiresAt,
        token,
        tokenVersion: 1,
        isElevated: false,
        primaryAuthenticatedAt: issuedAt,
        stepUpAt: null,
        stepUpExpiresAt: null,
        stepUpMethod: null,
        stepUpPurpose: null,
        permissions: [],
        groups: [],
        ipAddress: options.ipAddress ?? null,
        userAgent: options.userAgent ?? null,
        lastActiveAt: issuedAt,
        termsPolicyVersion: sessionIdentity.policyConsent.terms.acceptedVersion,
        privacyPolicyVersion: sessionIdentity.policyConsent.privacy.acceptedVersion,
      }),
      expiresAt: expiresAt.toISOString(),
      policyConsent: sessionIdentity.policyConsent,
    };
  }

  async rotateSession(
    sessionId: string,
    options: RotateSessionOptions,
    store: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<RotatedSession> {
    const current = await store.session.findFirst({
      where: { id: sessionId, tokenVersion: options.expectedTokenVersion }
    });
    if (!current) {
      throw new UnauthorizedException('세션이 존재하지 않습니다.');
    }

    const token = this.generateToken();
    const issuedAt = new Date();
    const expiresAt = current.expiresAt;
    if (expiresAt.getTime() <= issuedAt.getTime()) {
      throw new UnauthorizedException('세션이 만료되었습니다.');
    }
    const stepUpTtl = Math.min(
      Math.max(Math.trunc(options.stepUp?.ttlSeconds ?? STEP_UP_TTL_SECONDS), 60),
      STEP_UP_TTL_SECONDS,
    );
    const stepUpAt = options.stepUp ? issuedAt : options.clearStepUp ? null : current.stepUpAt;
    const stepUpExpiresAt = options.stepUp
      ? new Date(Math.min(expiresAt.getTime(), issuedAt.getTime() + stepUpTtl * 1000))
      : options.clearStepUp
        ? null
        : current.stepUpExpiresAt;

    const rotated = await store.session.updateMany({
      where: { id: sessionId, tokenVersion: options.expectedTokenVersion },
      data: {
        token: hashSessionToken(token),
        issuedAt,
        expiresAt,
        tokenVersion: current.tokenVersion + 1,
        isElevated: false,
        stepUpAt,
        stepUpExpiresAt,
        stepUpMethod: options.stepUp?.method ?? (options.clearStepUp ? null : current.stepUpMethod),
        stepUpPurpose: options.stepUp?.purpose ?? (options.clearStepUp ? null : current.stepUpPurpose),
        lastActiveAt: issuedAt
      }
    });
    if (rotated.count !== 1) {
      throw new UnauthorizedException('세션이 이미 갱신되었습니다. 다시 로그인해 주세요.');
    }
    const updated = await store.session.findUnique({ where: { id: sessionId } });
    if (!updated) {
      throw new UnauthorizedException('세션이 존재하지 않습니다.');
    }

    return {
      sessionId,
      cookie: this.serializeCookie({
        sessionId: updated.id,
        userId: updated.accountId,
        issuedAt: updated.issuedAt,
        expiresAt: updated.expiresAt,
        token,
        tokenVersion: updated.tokenVersion,
        isElevated: false,
        primaryAuthenticatedAt: updated.primaryAuthenticatedAt,
        stepUpAt: updated.stepUpAt,
        stepUpExpiresAt: updated.stepUpExpiresAt,
        stepUpMethod: updated.stepUpMethod,
        stepUpPurpose: updated.stepUpPurpose,
        permissions: [],
        groups: [],
        ipAddress: updated.ipAddress,
        userAgent: updated.userAgent,
        lastActiveAt: updated.lastActiveAt,
        termsPolicyVersion: updated.termsPolicyVersion,
        privacyPolicyVersion: updated.privacyPolicyVersion,
      }),
      expiresAt: updated.expiresAt.toISOString(),
      policyConsent: policyConsentStatus(
        updated.termsPolicyVersion,
        updated.privacyPolicyVersion,
      ),
      stepUpExpiresAt: updated.stepUpExpiresAt?.toISOString() ?? null,
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.session
      .delete({ where: { id: sessionId } })
      .catch(() => undefined);
  }

  async revokeUserSession(userId: string, sessionId: string): Promise<void> {
    const accountIds = await this.getCanonicalAccountIds(userId);
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId }
    });
    if (!session || !accountIds.includes(session.accountId)) {
      return;
    }
    await this.revokeSession(sessionId);
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
    const accountIds = await this.getCanonicalAccountIds(userId);
    await this.prisma.session.deleteMany({
      where: {
        accountId: { in: accountIds },
        id: exceptSessionId ? { not: exceptSessionId } : undefined
      }
    });
  }

  async getSession(
    sessionId: string,
    presentedToken?: string,
  ): Promise<SessionRecord | undefined> {
    const record = await this.prisma.session.findUnique({
      where: { id: sessionId },
      include: { account: { select: { lifecycleStatus: true, canonicalAccountId: true } } }
    });
    if (!record || (record.account && record.account.lifecycleStatus !== 'active')) {
      return undefined;
    }
    if (record.expiresAt.getTime() < Date.now()) {
      await this.revokeSession(sessionId);
      return undefined;
    }
    const canonicalAccountId = record.account.canonicalAccountId ?? record.accountId;
    if (canonicalAccountId !== record.accountId) {
      const canonical = await this.prisma.account.findUnique({
        where: { id: canonicalAccountId },
        select: { lifecycleStatus: true },
      });
      if (!canonical || canonical.lifecycleStatus !== 'active') return undefined;
      await this.prisma.session.updateMany({
        where: { id: record.id, accountId: record.accountId },
        data: { accountId: canonicalAccountId },
      });
    }
    const access = await this.roles?.getAccountAccess(canonicalAccountId).catch(() => undefined);
    return {
      sessionId: record.id,
      userId: canonicalAccountId,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      token: presentedToken ?? record.token,
      tokenVersion: record.tokenVersion,
      isElevated: false,
      primaryAuthenticatedAt: record.primaryAuthenticatedAt,
      stepUpAt: record.stepUpAt,
      stepUpExpiresAt: record.stepUpExpiresAt,
      stepUpMethod: record.stepUpMethod,
      stepUpPurpose: record.stepUpPurpose,
      permissions: access?.permissions ?? [],
      groups: access?.roles ?? [],
      ipAddress: record.ipAddress,
      userAgent: record.userAgent,
      lastActiveAt: record.lastActiveAt,
      termsPolicyVersion: record.termsPolicyVersion,
      privacyPolicyVersion: record.privacyPolicyVersion,
    };
  }

  async getSessionByToken(token: string | undefined): Promise<SessionRecord | undefined> {
    if (!token) {
      return undefined;
    }
    const record =
      (await this.prisma.session.findUnique({
        where: { token: hashSessionToken(token) },
      })) ??
      (isLegacyRawSessionToken(token)
        ? await this.prisma.session.findUnique({ where: { token } })
        : null);
    if (!record) {
      return undefined;
    }
    return this.getSession(record.id, token);
  }

  toPayload(record: SessionRecord): SessionPayload {
    const hasFreshStepUp = Boolean(
      record.stepUpAt &&
      record.stepUpExpiresAt &&
      record.stepUpExpiresAt.getTime() > Date.now() &&
      record.stepUpMethod &&
      record.stepUpPurpose
    );
    return {
      sessionId: record.sessionId,
      userId: record.userId,
      tokenVersion: record.tokenVersion,
      isElevated: false,
      authenticatedAt: record.primaryAuthenticatedAt.toISOString(),
      authLevel: hasFreshStepUp ? 'aal2' : 'aal1',
      stepUpAt: hasFreshStepUp ? record.stepUpAt!.toISOString() : null,
      stepUpExpiresAt: hasFreshStepUp ? record.stepUpExpiresAt!.toISOString() : null,
      stepUpMethod: hasFreshStepUp ? record.stepUpMethod as StepUpMethod : null,
      stepUpPurpose: hasFreshStepUp ? record.stepUpPurpose as StepUpPurpose : null,
      permissions: record.permissions,
      groups: record.groups,
      policyConsent: policyConsentStatus(
        record.termsPolicyVersion,
        record.privacyPolicyVersion,
      ),
    };
  }

  async getPolicyConsentStatus(userId: string): Promise<PolicyConsentStatus> {
    const accountIds = await this.getCanonicalAccountIds(userId);
    const consents = await this.prisma.accountConsent.findMany({
      where: {
        accountId: { in: accountIds },
        consentType: { in: ['terms', 'privacy'] },
      },
      orderBy: { consentedAt: 'desc' },
      select: { consentType: true, policyVersion: true },
    });
    const termsVersion = consents.find((item) => item.consentType === 'terms')?.policyVersion;
    const privacyVersion = consents.find((item) => item.consentType === 'privacy')?.policyVersion;
    return policyConsentStatus(termsVersion, privacyVersion);
  }

  async acceptCurrentPolicies(
    userId: string,
    context: { readonly ipAddress?: string | null; readonly userAgent?: string | null },
  ): Promise<PolicyConsentStatus> {
    const accountIds = await this.getCanonicalAccountIds(userId);
    const consentedAt = new Date();
    await this.prisma.$transaction(async (transaction) => {
      await transaction.accountConsent.upsert({
        where: {
          accountId_consentType_policyVersion: {
            accountId: userId,
            consentType: 'terms',
            policyVersion: CURRENT_POLICY_VERSIONS.terms.consentVersion,
          },
        },
        create: {
          accountId: userId,
          consentType: 'terms',
          policyVersion: CURRENT_POLICY_VERSIONS.terms.consentVersion,
          consentedAt,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent ?? null,
        },
        update: {},
      });
      await transaction.accountConsent.upsert({
        where: {
          accountId_consentType_policyVersion: {
            accountId: userId,
            consentType: 'privacy',
            policyVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
          },
        },
        create: {
          accountId: userId,
          consentType: 'privacy',
          policyVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
          consentedAt,
          ipAddress: context.ipAddress ?? null,
          userAgent: context.userAgent ?? null,
        },
        update: {},
      });
      await transaction.session.updateMany({
        where: { accountId: { in: accountIds } },
        data: {
          termsPolicyVersion: CURRENT_POLICY_VERSIONS.terms.consentVersion,
          privacyPolicyVersion: CURRENT_POLICY_VERSIONS.privacy.consentVersion,
        },
      });
    });
    return policyConsentStatus(
      CURRENT_POLICY_VERSIONS.terms.consentVersion,
      CURRENT_POLICY_VERSIONS.privacy.consentVersion,
    );
  }

  async listSessionsForUser(
    userId: string,
    currentSessionId?: string
  ): Promise<SessionSummary[]> {
    const accountIds = await this.getCanonicalAccountIds(userId);
    const sessions = await this.prisma.session.findMany({
      where: { accountId: { in: accountIds } },
      orderBy: { lastActiveAt: 'desc' }
    });
    return sessions.map((session) => ({
      sessionId: session.id,
      createdAt: session.createdAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      isCurrent: currentSessionId ? currentSessionId === session.id : false,
      tokenVersion: session.tokenVersion,
      isElevated: false,
      authLevel: session.stepUpExpiresAt && session.stepUpExpiresAt.getTime() > Date.now() ? 'aal2' : 'aal1',
      stepUpExpiresAt: session.stepUpExpiresAt?.toISOString() ?? null,
    }));
  }

  async touchSession(
    sessionId: string,
    ipAddress?: string | null,
    userAgent?: string | null
  ): Promise<void> {
    const data: {
      lastActiveAt: Date;
      ipAddress?: string | null;
      userAgent?: string | null;
    } = {
      lastActiveAt: new Date()
    };
    if (ipAddress) {
      data.ipAddress = ipAddress;
    }
    if (userAgent) {
      data.userAgent = userAgent;
    }
    await this.prisma.session
      .update({
        where: { id: sessionId },
        data
      })
      .catch(() => undefined);
  }

  private serializeCookie(record: SessionRecord): string {
    return serialize(MINEWIKI_SESSION_COOKIE, record.token, {
      httpOnly: true,
      secure: true,
      sameSite: 'strict',
      path: '/',
      maxAge: Math.floor((record.expiresAt.getTime() - Date.now()) / 1000),
      expires: record.expiresAt
    });
  }

  private generateToken(): string {
    return randomBytes(32).toString('base64url');
  }

  private async getCanonicalAccountIds(userId: string): Promise<string[]> {
    const account = await this.prisma.account.findUnique({
      where: { id: userId },
      select: { canonicalAccountId: true },
    });
    if (!account) {
      throw new UnauthorizedException('계정이 존재하지 않습니다.');
    }
    const canonicalId = account.canonicalAccountId ?? userId;
    const accounts = await this.prisma.account.findMany({
      where: {
        OR: [
          { id: canonicalId },
          { id: userId },
          { canonicalAccountId: canonicalId },
        ],
      },
      select: { id: true },
    });
    return [...new Set(accounts.map((item) => item.id))];
  }
}

export function assertFreshStepUp(
  session: SessionPayload,
  purpose: StepUpPurpose,
  nowMs = Date.now(),
): void {
  const authenticatedAt = Date.parse(session.authenticatedAt);
  const stepUpAt = session.stepUpAt ? Date.parse(session.stepUpAt) : Number.NaN;
  const expiresAt = session.stepUpExpiresAt
    ? Date.parse(session.stepUpExpiresAt)
    : Number.NaN;
  const recognizedMethod =
    session.stepUpMethod === 'totp' ||
    session.stepUpMethod === 'recovery_code' ||
    session.stepUpMethod === 'webauthn';
  if (
    session.authLevel !== 'aal2' ||
    session.stepUpPurpose !== purpose ||
    !recognizedMethod ||
    !Number.isFinite(authenticatedAt) ||
    !Number.isFinite(stepUpAt) ||
    !Number.isFinite(expiresAt) ||
    authenticatedAt > stepUpAt ||
    stepUpAt > nowMs ||
    expiresAt <= stepUpAt ||
    expiresAt > stepUpAt + STEP_UP_TTL_SECONDS * 1000 ||
    expiresAt <= nowMs
  ) {
    throw new ForbiddenException({
      code: 'STEP_UP_REQUIRED',
      message: '이 작업을 계속하려면 다중 인증을 다시 확인해 주세요.',
      purpose,
    });
  }
}

const SESSION_TOKEN_HASH_PREFIX = 'sha256:';

export function hashSessionToken(token: string): string {
  return `${SESSION_TOKEN_HASH_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
}

function isLegacyRawSessionToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
