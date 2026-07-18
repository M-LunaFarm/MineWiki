import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  HttpException,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { verify } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../common/prisma.service';
import type { SessionPayload } from '../session/session.service';
import {
  readCanonicalAccountGroup,
  withActiveCanonicalAccountGroup,
  type CanonicalAccountGroup,
} from './account-lifecycle-fence';
import { EmailService } from './email.service';
import {
  accountGroupFingerprint as groupFingerprint,
  hashContactValue as hashValue,
  invalidContactEmailToken as invalidToken,
  maskContactEmail as maskEmail,
  normalizeContactEmail as normalizeEmail,
} from './account-email-change-utils';

const RESEND_MS = 10 * 60 * 1000;
const EXPIRY_MS = 24 * 60 * 60 * 1000;
const RECENT_OAUTH_MS = 15 * 60 * 1000;

export interface AccountEmailChangeState {
  readonly currentEmail: string | null;
  readonly hasPassword: boolean;
  readonly pending: null | {
    readonly emailMasked: string;
    readonly status: 'pending';
    readonly expiresAt: string;
    readonly nextResendAt: string;
  };
}

export interface AccountEmailChangeAccepted {
  readonly accepted: true;
  readonly expiresAt: string;
  readonly nextResendAt: string;
}

@Injectable()
export class AccountEmailChangeService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly email: EmailService,
  ) {}

  async getState(session: SessionPayload): Promise<AccountEmailChangeState> {
    const group = await this.resolveActiveGroup(session.userId);
    const [canonical, passwordCount, pending] = await Promise.all([
      this.prisma.account.findUnique({
        where: { id: group.canonicalAccountId },
        select: { email: true },
      }),
      this.prisma.account.count({
        where: { id: { in: [...group.accountIds] }, passwordHash: { not: null } },
      }),
      this.prisma.accountEmailChange.findFirst({
        where: {
          canonicalAccountId: group.canonicalAccountId,
          activeKey: group.canonicalAccountId,
          status: 'pending',
          expiresAt: { gt: new Date() },
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    return {
      currentEmail: canonical?.email ?? null,
      hasPassword: passwordCount > 0,
      pending: pending ? {
        emailMasked: maskEmail(pending.newEmail),
        status: 'pending',
        expiresAt: pending.expiresAt.toISOString(),
        nextResendAt: pending.resendAvailableAt.toISOString(),
      } : null,
    };
  }

  async request(
    session: SessionPayload,
    input: { readonly email: string; readonly password?: string },
  ): Promise<AccountEmailChangeAccepted> {
    const newEmail = normalizeEmail(input.email);
    const group = await this.resolveActiveGroup(session.userId);
    const credential = await this.reauthenticateAndResolveCredential(group, session, input.password);
    const now = new Date();
    const expiresAt = new Date(now.getTime() + EXPIRY_MS);
    const resendAvailableAt = new Date(now.getTime() + RESEND_MS);
    let delivery: { readonly email: string; readonly token: string; readonly expiresAt: Date } | null = null;

    await withActiveCanonicalAccountGroup(this.prisma, [session.userId], async (tx) => {
      const confirmed = await readCanonicalAccountGroup(tx, session.userId);
      this.assertSameGroup(group, confirmed);
      const canonical = await tx.account.findUnique({
        where: { id: confirmed.canonicalAccountId },
        select: { email: true },
      });
      if (!canonical) throw new ConflictException({ code: 'contact_email_account_changed', message: '계정 상태가 변경되었습니다. 다시 시도해 주세요.' });
      if (canonical.email?.trim().toLowerCase() === newEmail) {
        throw new BadRequestException({ code: 'contact_email_unchanged', message: '새 이메일이 현재 이메일과 같습니다.' });
      }

      const unavailable = await this.isEmailUnavailable(tx, newEmail, confirmed.accountIds, confirmed.canonicalAccountId);
      if (unavailable) {
        await tx.auditEvent.create({ data: {
          category: 'account',
          action: 'account.contact_email.change_requested',
          severity: 'info',
          actorAccountId: session.userId,
          subjectType: 'account',
          subjectId: confirmed.canonicalAccountId,
          metadata: { newEmailHash: hashValue(newEmail), accepted: false },
          createdAt: now,
        } });
        return;
      }

      await tx.accountEmailChange.updateMany({
        where: { canonicalAccountId: confirmed.canonicalAccountId, status: 'pending' },
        data: { status: 'superseded', activeKey: null, supersededAt: now, updatedAt: now },
      });
      const token = randomBytes(32).toString('hex');
      await tx.accountEmailChange.create({ data: {
        canonicalAccountId: confirmed.canonicalAccountId,
        credentialAccountId: credential?.id ?? null,
        previousEmail: canonical.email?.trim().toLowerCase() ?? null,
        newEmail,
        tokenHash: hashValue(token),
        groupFingerprint: groupFingerprint(confirmed.accountIds),
        status: 'pending',
        activeKey: confirmed.canonicalAccountId,
        requestedBySessionId: session.sessionId,
        sentAt: now,
        resendAvailableAt,
        expiresAt,
        createdAt: now,
        updatedAt: now,
      } });
      await tx.auditEvent.create({ data: {
        category: 'account',
        action: 'account.contact_email.change_requested',
        severity: 'info',
        actorAccountId: session.userId,
        subjectType: 'account',
        subjectId: confirmed.canonicalAccountId,
        metadata: { newEmailHash: hashValue(newEmail), accepted: true },
        createdAt: now,
      } });
      delivery = { email: newEmail, token, expiresAt };
    });

    const pendingDelivery = delivery as { readonly email: string; readonly token: string; readonly expiresAt: Date } | null;
    if (pendingDelivery) await this.sendVerification(pendingDelivery);
    return { accepted: true, expiresAt: expiresAt.toISOString(), nextResendAt: resendAvailableAt.toISOString() };
  }

  async resend(session: SessionPayload): Promise<AccountEmailChangeAccepted> {
    const group = await this.resolveActiveGroup(session.userId);
    const now = new Date();
    const syntheticExpiry = new Date(now.getTime() + EXPIRY_MS);
    const syntheticResend = new Date(now.getTime() + RESEND_MS);
    let response = { accepted: true as const, expiresAt: syntheticExpiry.toISOString(), nextResendAt: syntheticResend.toISOString() };
    let delivery: { readonly email: string; readonly token: string; readonly expiresAt: Date } | null = null;

    await withActiveCanonicalAccountGroup(this.prisma, [session.userId], async (tx) => {
      const confirmed = await readCanonicalAccountGroup(tx, session.userId);
      this.assertSameGroup(group, confirmed);
      const pending = await tx.accountEmailChange.findFirst({
        where: { canonicalAccountId: confirmed.canonicalAccountId, activeKey: confirmed.canonicalAccountId, status: 'pending' },
        orderBy: { createdAt: 'desc' },
      });
      if (!pending || pending.expiresAt <= now || pending.groupFingerprint !== groupFingerprint(confirmed.accountIds)) {
        if (pending) await tx.accountEmailChange.update({
          where: { id: pending.id },
          data: { status: 'superseded', activeKey: null, supersededAt: now, updatedAt: now },
        });
        return;
      }
      if (pending.resendAvailableAt > now) {
        throw new HttpException({
          code: 'contact_email_resend_cooldown',
          message: '인증 메일은 10분 후 다시 보낼 수 있습니다.',
          nextResendAt: pending.resendAvailableAt.toISOString(),
        }, 429);
      }
      const token = randomBytes(32).toString('hex');
      const nextResendAt = new Date(now.getTime() + RESEND_MS);
      await tx.accountEmailChange.update({
        where: { id: pending.id },
        data: { tokenHash: hashValue(token), sentAt: now, resendAvailableAt: nextResendAt, updatedAt: now },
      });
      await tx.auditEvent.create({ data: {
        category: 'account',
        action: 'account.contact_email.verification_resent',
        severity: 'info',
        actorAccountId: session.userId,
        subjectType: 'account',
        subjectId: confirmed.canonicalAccountId,
        metadata: { newEmailHash: hashValue(pending.newEmail) },
        createdAt: now,
      } });
      response = { accepted: true, expiresAt: pending.expiresAt.toISOString(), nextResendAt: nextResendAt.toISOString() };
      delivery = { email: pending.newEmail, token, expiresAt: pending.expiresAt };
    });
    const pendingDelivery = delivery as { readonly email: string; readonly token: string; readonly expiresAt: Date } | null;
    if (pendingDelivery) await this.sendVerification(pendingDelivery);
    return response;
  }

  async confirm(rawToken: string): Promise<{ readonly success: true; readonly reauthenticationRequired: true }> {
    const token = rawToken.trim();
    if (!token) throw invalidToken();
    const tokenHash = hashValue(token);
    const snapshot = await this.prisma.accountEmailChange.findUnique({ where: { tokenHash } });
    if (!snapshot || snapshot.status !== 'pending' || snapshot.expiresAt <= new Date()) throw invalidToken();
    const changedAt = new Date();
    let previousEmail: string | null = null;

    await withActiveCanonicalAccountGroup(this.prisma, [snapshot.canonicalAccountId], async (tx, activeGroup) => {
      const group = await readCanonicalAccountGroup(tx, snapshot.canonicalAccountId);
      if (group.canonicalAccountId !== snapshot.canonicalAccountId ||
          groupFingerprint(activeGroup.accountIds) !== snapshot.groupFingerprint) throw invalidToken();
      const claimed = await tx.accountEmailChange.updateMany({
        where: { id: snapshot.id, tokenHash, status: 'pending', expiresAt: { gt: changedAt } },
        data: { status: 'confirming', activeKey: null, updatedAt: changedAt },
      });
      if (claimed.count !== 1) throw invalidToken();

      const credentialAccounts = await tx.account.findMany({
        where: { id: { in: [...activeGroup.accountIds] }, passwordHash: { not: null } },
        select: { id: true, provider: true },
      });
      if (credentialAccounts.length > 1 || (credentialAccounts[0]?.id ?? null) !== snapshot.credentialAccountId) throw invalidToken();
      if (await this.isEmailUnavailable(tx, snapshot.newEmail, activeGroup.accountIds, snapshot.canonicalAccountId, snapshot.id)) {
        throw new ConflictException({ code: 'contact_email_unavailable', message: '이 이메일로 변경할 수 없습니다.' });
      }

      const canonical = await tx.account.findUnique({ where: { id: snapshot.canonicalAccountId }, select: { email: true } });
      if (!canonical) throw invalidToken();
      previousEmail = canonical.email?.trim().toLowerCase() ?? snapshot.previousEmail;
      await tx.account.update({
        where: { id: snapshot.canonicalAccountId },
        data: { email: snapshot.newEmail, emailVerified: true },
      });
      const credential = credentialAccounts[0];
      if (credential && credential.id !== snapshot.canonicalAccountId) {
        await tx.account.update({
          where: { id: credential.id },
          data: {
            email: snapshot.newEmail,
            emailVerified: true,
            ...(credential.provider === 'email' ? { providerUserId: snapshot.newEmail } : {}),
          },
        });
      } else if (credential?.provider === 'email') {
        await tx.account.update({
          where: { id: credential.id },
          data: { providerUserId: snapshot.newEmail },
        });
      }

      const groupProfiles = await tx.wikiProfile.findMany({
        where: { accountId: { in: [...activeGroup.accountIds] } },
        orderBy: { id: 'asc' },
        select: { id: true, accountId: true, status: true, mergedIntoProfileId: true },
      });
      const canonicalProfile = groupProfiles.find((profile) =>
        profile.accountId === snapshot.canonicalAccountId && profile.status !== 'merged' && !profile.mergedIntoProfileId
      ) ?? groupProfiles.find((profile) => profile.status !== 'merged' && !profile.mergedIntoProfileId);
      await tx.wikiProfile.updateMany({
        where: { id: { in: groupProfiles.filter((profile) => profile.id !== canonicalProfile?.id).map((profile) => profile.id) } },
        data: { email: null, emailVerifiedAt: null, emailVerificationSentAt: null, updatedAt: changedAt },
      });
      if (canonicalProfile) await tx.wikiProfile.update({
        where: { id: canonicalProfile.id },
        data: { email: snapshot.newEmail, emailVerifiedAt: changedAt, emailVerificationSentAt: null, updatedAt: changedAt },
      });

      await Promise.all([
        tx.session.deleteMany({ where: { accountId: { in: [...activeGroup.accountIds] } } }),
        tx.passwordReset.deleteMany({ where: { accountId: { in: [...activeGroup.accountIds] } } }),
        tx.emailVerification.deleteMany({ where: { accountId: { in: [...activeGroup.accountIds] } } }),
      ]);
      await tx.accountEmailChange.updateMany({
        where: { canonicalAccountId: snapshot.canonicalAccountId, id: { not: snapshot.id }, status: 'pending' },
        data: { status: 'superseded', activeKey: null, supersededAt: changedAt, updatedAt: changedAt },
      });
      await tx.accountEmailChange.update({
        where: { id: snapshot.id },
        data: { status: 'confirmed', activeKey: null, confirmedAt: changedAt, updatedAt: changedAt },
      });
      await tx.auditEvent.create({ data: {
        category: 'account',
        action: 'account.contact_email.changed',
        severity: 'warning',
        actorAccountId: snapshot.canonicalAccountId,
        subjectType: 'account',
        subjectId: snapshot.canonicalAccountId,
        metadata: {
          previousEmailHash: previousEmail ? hashValue(previousEmail) : null,
          newEmailHash: hashValue(snapshot.newEmail),
        },
        createdAt: changedAt,
      } });
    }).catch((error: unknown) => {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2002') {
        throw new ConflictException({ code: 'contact_email_unavailable', message: '이 이메일로 변경할 수 없습니다.' });
      }
      if (error && typeof error === 'object' && 'code' in error && error.code === 'P2034') {
        throw new ConflictException({ code: 'contact_email_concurrency_conflict', message: '계정 정보가 동시에 변경되었습니다. 다시 시도해 주세요.' });
      }
      throw error;
    });

    const noticeEmail = previousEmail as string | null;
    if (noticeEmail && noticeEmail !== snapshot.newEmail) {
      await this.sendChangedNotice(noticeEmail, snapshot.newEmail, changedAt);
    }
    return { success: true, reauthenticationRequired: true };
  }

  private async resolveActiveGroup(accountId: string): Promise<CanonicalAccountGroup> {
    const group = await readCanonicalAccountGroup(this.prisma, accountId);
    const activeCount = await this.prisma.account.count({
      where: { id: { in: [...group.accountIds] }, lifecycleStatus: 'active' },
    });
    if (activeCount !== group.accountIds.length) {
      throw new ConflictException({ code: 'contact_email_account_inactive', message: '현재 계정 상태에서는 이메일을 변경할 수 없습니다.' });
    }
    return group;
  }

  private async reauthenticateAndResolveCredential(
    group: CanonicalAccountGroup,
    session: SessionPayload,
    password?: string,
  ): Promise<{ readonly id: string } | null> {
    const accounts = await this.prisma.account.findMany({
      where: { id: { in: [...group.accountIds] } },
      select: { id: true, passwordHash: true },
    });
    const credentials = accounts.filter((account) => account.passwordHash);
    if (credentials.length > 1) {
      throw new ConflictException({ code: 'contact_email_credential_ambiguous', message: '비밀번호 로그인 계정이 여러 개입니다. 계정 충돌을 먼저 해결해 주세요.' });
    }
    if (credentials.length === 1) {
      if (!password) throw new ForbiddenException({ code: 'contact_email_reauth_required', message: '현재 비밀번호를 입력해 주세요.' });
      if (!(await verify(credentials[0]!.passwordHash!, password))) {
        throw new UnauthorizedException({ code: 'contact_email_password_invalid', message: '현재 비밀번호가 올바르지 않습니다.' });
      }
      return { id: credentials[0]!.id };
    }
    const authenticatedAt = Date.parse(session.authenticatedAt);
    const now = Date.now();
    if (Number.isFinite(authenticatedAt) && authenticatedAt <= now && now - authenticatedAt <= RECENT_OAUTH_MS) return null;
    throw new ForbiddenException({ code: 'contact_email_reauth_required', message: '다시 로그인한 뒤 15분 안에 이메일을 변경해 주세요.' });
  }

  private async isEmailUnavailable(
    tx: Prisma.TransactionClient,
    email: string,
    groupAccountIds: readonly string[],
    canonicalAccountId: string,
    excludeChangeId?: string,
  ): Promise<boolean> {
    const [account, profile, pending] = await Promise.all([
      tx.account.findFirst({
        where: {
          id: { notIn: [...groupAccountIds] },
          lifecycleStatus: 'active',
          OR: [
            { email, emailVerified: true },
            { provider: 'email', providerUserId: email },
          ],
        },
        select: { id: true },
      }),
      tx.wikiProfile.findFirst({
        where: {
          email,
          OR: [{ accountId: null }, { accountId: { notIn: [...groupAccountIds] } }],
        },
        select: { id: true },
      }),
      tx.accountEmailChange.findFirst({
        where: {
          newEmail: email,
          status: 'pending',
          expiresAt: { gt: new Date() },
          canonicalAccountId: { not: canonicalAccountId },
          ...(excludeChangeId ? { id: { not: excludeChangeId } } : {}),
        },
        select: { id: true },
      }),
    ]);
    return Boolean(account || profile || pending);
  }

  private assertSameGroup(left: CanonicalAccountGroup, right: CanonicalAccountGroup): void {
    if (left.canonicalAccountId !== right.canonicalAccountId || groupFingerprint(left.accountIds) !== groupFingerprint(right.accountIds)) {
      throw new ConflictException({ code: 'contact_email_account_scope_changed', message: '계정 연결 상태가 변경되었습니다. 다시 시도해 주세요.' });
    }
  }

  private async sendVerification(delivery: { readonly email: string; readonly token: string; readonly expiresAt: Date }): Promise<void> {
    if (!this.email.isEnabled()) return;
    try {
      await this.email.sendContactEmailChangeVerificationEmail(delivery);
    } catch (error) {
      this.email.logDeliveryFailure(error);
    }
  }

  private async sendChangedNotice(previousEmail: string, newEmail: string, changedAt: Date): Promise<void> {
    if (!this.email.isEnabled()) return;
    try {
      await this.email.sendContactEmailChangedNotice({
        email: previousEmail,
        newEmailMasked: maskEmail(newEmail),
        changedAt,
      });
    } catch (error) {
      this.email.logDeliveryFailure(error);
    }
  }
}
