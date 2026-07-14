import { Injectable, Optional, UnauthorizedException } from '@nestjs/common';
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

interface SessionRecord {
  readonly sessionId: string;
  readonly userId: string;
  issuedAt: Date;
  expiresAt: Date;
  readonly token: string;
  tokenVersion: number;
  isElevated: boolean;
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
  readonly elevated?: boolean;
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

export interface RotatedSession {
  readonly sessionId: string;
  readonly cookie: string;
  readonly expiresAt: string;
  readonly policyConsent: PolicyConsentStatus;
}

export interface SessionPayload {
  readonly sessionId: string;
  readonly userId: string;
  readonly isElevated: boolean;
  readonly authenticatedAt: string;
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
    const policyConsent = await this.getPolicyConsentStatus(options.userId);

    await this.prisma.session.create({
      data: {
        id: sessionId,
        accountId: options.userId,
        issuedAt,
        expiresAt,
        token: hashSessionToken(token),
        tokenVersion: 1,
        isElevated: Boolean(options.elevated),
        ipAddress: options.ipAddress ?? null,
        userAgent: options.userAgent ?? null,
        lastActiveAt: issuedAt,
        termsPolicyVersion: policyConsent.terms.acceptedVersion,
        privacyPolicyVersion: policyConsent.privacy.acceptedVersion,
      }
    });

    return {
      sessionId,
      cookie: this.serializeCookie({
        sessionId,
        userId: options.userId,
        issuedAt,
        expiresAt,
        token,
        tokenVersion: 1,
        isElevated: Boolean(options.elevated),
        permissions: [],
        groups: [],
        ipAddress: options.ipAddress ?? null,
        userAgent: options.userAgent ?? null,
        lastActiveAt: issuedAt,
        termsPolicyVersion: policyConsent.terms.acceptedVersion,
        privacyPolicyVersion: policyConsent.privacy.acceptedVersion,
      }),
      expiresAt: expiresAt.toISOString(),
      policyConsent,
    };
  }

  async rotateSession(sessionId: string, elevated = false): Promise<RotatedSession> {
    const current = await this.prisma.session.findUnique({
      where: { id: sessionId }
    });
    if (!current) {
      throw new UnauthorizedException('세션이 존재하지 않습니다.');
    }

    const token = this.generateToken();
    const issuedAt = new Date();
    const expirationMs = current.expiresAt.getTime() - current.issuedAt.getTime();
    const expiresAt = new Date(issuedAt.getTime() + expirationMs);

    const updated = await this.prisma.session.update({
      where: { id: sessionId },
      data: {
        token: hashSessionToken(token),
        issuedAt,
        expiresAt,
        tokenVersion: current.tokenVersion + 1,
        isElevated: elevated ? true : current.isElevated,
        lastActiveAt: issuedAt
      }
    });

    return {
      sessionId,
      cookie: this.serializeCookie({
        sessionId: updated.id,
        userId: updated.accountId,
        issuedAt: updated.issuedAt,
        expiresAt: updated.expiresAt,
        token,
        tokenVersion: updated.tokenVersion,
        isElevated: updated.isElevated,
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
    };
  }

  async revokeSession(sessionId: string): Promise<void> {
    await this.prisma.session
      .delete({ where: { id: sessionId } })
      .catch(() => undefined);
  }

  async revokeUserSession(userId: string, sessionId: string): Promise<void> {
    const session = await this.prisma.session.findUnique({
      where: { id: sessionId }
    });
    if (!session || session.accountId !== userId) {
      return;
    }
    await this.revokeSession(sessionId);
  }

  async revokeAllSessions(userId: string, exceptSessionId?: string): Promise<void> {
    await this.prisma.session.deleteMany({
      where: {
        accountId: userId,
        id: exceptSessionId ? { not: exceptSessionId } : undefined
      }
    });
  }

  async getSession(
    sessionId: string,
    presentedToken?: string,
  ): Promise<SessionRecord | undefined> {
    const record = await this.prisma.session.findUnique({
      where: { id: sessionId }
    });
    if (!record) {
      return undefined;
    }
    if (record.expiresAt.getTime() < Date.now()) {
      await this.revokeSession(sessionId);
      return undefined;
    }
    const access = await this.roles?.getAccountAccess(record.accountId).catch(() => undefined);
    return {
      sessionId: record.id,
      userId: record.accountId,
      issuedAt: record.issuedAt,
      expiresAt: record.expiresAt,
      token: presentedToken ?? record.token,
      tokenVersion: record.tokenVersion,
      isElevated: record.isElevated,
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
    return {
      sessionId: record.sessionId,
      userId: record.userId,
      isElevated: record.isElevated,
      authenticatedAt: record.issuedAt.toISOString(),
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
    const sessions = await this.prisma.session.findMany({
      where: { accountId: userId },
      orderBy: { lastActiveAt: 'desc' }
    });
    return sessions.map((session) => ({
      sessionId: session.id,
      createdAt: session.issuedAt.toISOString(),
      lastActiveAt: session.lastActiveAt.toISOString(),
      ipAddress: session.ipAddress,
      userAgent: session.userAgent,
      isCurrent: currentSessionId ? currentSessionId === session.id : false,
      tokenVersion: session.tokenVersion,
      isElevated: session.isElevated
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

const SESSION_TOKEN_HASH_PREFIX = 'sha256:';

export function hashSessionToken(token: string): string {
  return `${SESSION_TOKEN_HASH_PREFIX}${createHash('sha256').update(token).digest('hex')}`;
}

function isLegacyRawSessionToken(token: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(token);
}
