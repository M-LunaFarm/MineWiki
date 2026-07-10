import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { hash, verify, Algorithm } from '@node-rs/argon2';
import { randomBytes } from 'node:crypto';
import type { AuthProvider } from './account-separation.service';
import {
  AccountSeparationService,
  type AccountRecord,
  type AccountLinkRequest,
  type AccountLinkResult,
} from './account-separation.service';
import { SessionService } from '../session/session.service';
import { PrismaService } from '../common/prisma.service';
import { EmailService } from './email.service';
import { FileService, type FileImageUploadRequest } from '../file/file.service';

interface EmailRegistrationDto {
  readonly email: string;
  readonly password: string;
  readonly displayName?: string;
}

interface EmailLoginDto {
  readonly email: string;
  readonly password: string;
}

interface EmailLoginSetupDto {
  readonly email: string;
  readonly password: string;
}

interface OAuthPayload {
  readonly userId: string;
  readonly email?: string;
  readonly displayName?: string;
}

interface SessionContext {
  readonly ipAddress?: string | null;
  readonly userAgent?: string | null;
}

interface PendingEmailVerification {
  readonly accountId: string;
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

interface PendingPasswordReset {
  readonly accountId: string;
  readonly email: string;
  readonly token: string;
  readonly expiresAt: Date;
}

export interface AuthAccountView {
  readonly id: string;
  readonly provider: AuthProvider;
  readonly providerUserId: string;
  readonly email?: string;
  readonly displayName?: string;
  readonly avatarUrl?: string;
  readonly emailVerified: boolean;
  readonly hasPassword: boolean;
  readonly createdAt: string;
  readonly lastLoginAt: string | null;
  readonly linkedAccountIds: string[];
  readonly linkedAccounts: LinkedAccountView[];
}

export interface LinkedAccountView {
  readonly id: string;
  readonly provider: AuthProvider;
  readonly email?: string;
  readonly displayName?: string;
}

export interface AuthSessionResult {
  readonly account: AuthAccountView;
  readonly sessionId: string;
  readonly expiresAt: string;
  readonly cookie: string;
}

export interface EmailRegistrationPendingResult {
  readonly status: 'verification-required';
  readonly accountId: string;
  readonly email: string;
  readonly expiresAt: string;
}

export type EmailRegistrationResult = EmailRegistrationPendingResult;

export interface ResendVerificationResult {
  readonly accountId: string;
  readonly email: string;
  readonly expiresAt: string;
}

export interface PasswordResetRequestResult {
  readonly accepted: true;
}

export interface PasswordResetConfirmResult {
  readonly success: true;
}

const ARGON_OPTIONS = {
  memoryCost: 19456,
  timeCost: 2,
  parallelism: 1,
  outputLen: 32,
  algorithm: Algorithm.Argon2id,
} as const;

const PASSWORD_POLICY = /^(?=.*[A-Z])(?=.*[^A-Za-z0-9]).{8,}$/;
const EMAIL_VERIFICATION_TTL_MS = 1000 * 60 * 30; // 30 minutes
const PASSWORD_RESET_TTL_MS = 1000 * 60 * 30; // 30 minutes

@Injectable()
export class AuthService {
  private readonly accountLinkingEnabled: boolean;
  private readonly logger = new Logger(AuthService.name);

  constructor(
    private readonly accounts: AccountSeparationService,
    private readonly sessions: SessionService,
    private readonly prisma: PrismaService,
    private readonly emailService: EmailService,
    private readonly config: ConfigService,
    private readonly files: FileService,
  ) {
    this.accountLinkingEnabled = this.config.getOptional('ACCOUNT_LINKING_ENABLED') === 'true';
  }

  async registerEmail(payload: EmailRegistrationDto): Promise<EmailRegistrationResult> {
    const email = payload.email.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('?대찓?쇱씠 ?꾩슂?⑸땲??');
    }
    if (!payload.password || !PASSWORD_POLICY.test(payload.password)) {
      throw new BadRequestException(
        '鍮꾨?踰덊샇??8???댁긽?대ŉ ?臾몄옄? ?뱀닔臾몄옄瑜?理쒖냼 1???댁긽 ?ы븿? 댁빞 ?⑸땲??',
      );
    }
    const existing = await this.accounts.findByProvider('email', email);
    if (existing) {
      throw new ConflictException('?대? ?깅줉???대찓?쇱엯?덈떎.');
    }

    const passwordHash = await hash(payload.password, ARGON_OPTIONS);
    const account = await this.accounts.registerAccount({
      provider: 'email',
      providerUserId: email,
      email,
      displayName: payload.displayName?.trim() || email.split('@')[0],
      passwordHash,
      emailVerified: false,
    });

    const verification = await this.createEmailVerification(account.id, email);
    await this.dispatchVerificationEmail(verification);

    return {
      status: 'verification-required',
      accountId: account.id,
      email,
      expiresAt: verification.expiresAt.toISOString(),
    };
  }

  async loginEmail(
    payload: EmailLoginDto,
    context: SessionContext = {},
  ): Promise<AuthSessionResult> {
    const email = payload.email.trim().toLowerCase();
    if (!email || !payload.password) {
      throw new UnauthorizedException('?대찓???먮뒗 鍮꾨?踰덊샇媛 ?щ컮瑜댁? ?딆뒿?덈떎.');
    }

    const passwordAccounts = await this.findPasswordAccountsByEmail(email);
    let account: AccountRecord | undefined;
    for (const candidate of passwordAccounts) {
      if (!candidate.passwordHash) {
        continue;
      }
      if (await verify(candidate.passwordHash, payload.password)) {
        if (account) {
          throw new ConflictException(
            '?숈씪??대찓?쇰줈 濡쒓렇???쒕뒗 怨꾩젙???덉뼱?쒖? ?먯썝??臾몄쓽媛 ?꾩슂?⑸땲??',
          );
        }
        account = candidate;
      }
    }

    if (!account) {
      throw new UnauthorizedException('?대찓???먮뒗 鍮꾨?踰덊샇媛 ?щ컮瑜댁? ?딆뒿?덈떎.');
    }
    if (!account.emailVerified) {
      throw new ForbiddenException('?대찓???몄쬆???꾨즺?????ㅼ떆 濡쒓렇?명빐 二쇱꽭??');
    }
    await this.accounts.updateLastLogin(account.id, new Date());
    const session = await this.sessions.issueSession({
      userId: account.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return this.toSessionResult(account, session.cookie, session.sessionId, session.expiresAt);
  }

  async verifyEmail(token: string, context: SessionContext = {}): Promise<AuthSessionResult> {
    const verification = await this.consumeEmailVerification(token);
    const account = await this.accounts.markEmailVerified(verification.accountId);
    await this.accounts.updateLastLogin(account.id, new Date());
    const session = await this.sessions.issueSession({
      userId: account.id,
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return this.toSessionResult(account, session.cookie, session.sessionId, session.expiresAt);
  }

  async setupEmailLogin(
    accountId: string,
    payload: EmailLoginSetupDto,
  ): Promise<ResendVerificationResult> {
    const email = payload.email.trim().toLowerCase();
    if (!email) {
      throw new BadRequestException('?대찓?쇱씠 ?꾩슂?⑸땲??');
    }
    if (!payload.password || !PASSWORD_POLICY.test(payload.password)) {
      throw new BadRequestException(
        '鍮꾨?踰덊샇??8???댁긽?대ŉ ?臾몄옄? ?뱀닔臾몄옄瑜?理쒖냼 1???댁긽 ?ы븿? 댁빞 ?⑸땲??',
      );
    }

    const account = await this.accounts.getAccount(accountId);
    if (!account) {
      throw new NotFoundAccountError();
    }
    if (account.passwordHash) {
      throw new BadRequestException('?대? 鍮꾨?踰덊샇 濡쒓렇?몄씠 ?ㅼ젙??怨꾩젙?낅땲??');
    }

    const existingPasswordAccount = (await this.findPasswordAccountsByEmail(email)).find(
      (item) => item.id !== account.id,
    );
    if (existingPasswordAccount) {
      throw new ConflictException(
        '?대? ?대찓?쇰줈 鍮꾨?踰덊샇 濡쒓렇?몄씠 媛?ν븳 怨꾩젙??議댁옱?⑸땲??',
      );
    }

    const passwordHash = await hash(payload.password, ARGON_OPTIONS);
    await this.prisma.account.update({
      where: { id: account.id },
      data: {
        email,
        passwordHash,
        emailVerified: false,
      },
    });

    const verification = await this.createEmailVerification(account.id, email);
    await this.dispatchVerificationEmail(verification);
    return {
      accountId: account.id,
      email,
      expiresAt: verification.expiresAt.toISOString(),
    };
  }

  async resendVerification(email: string): Promise<ResendVerificationResult> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) {
      throw new BadRequestException('?대찓?쇱씠 ?꾩슂?⑸땲??');
    }

    const account = await this.findSinglePasswordAccountByEmail(normalized);
    if (!account) {
      throw new NotFoundException('?대떦 ?대찓?쇰줈 ?깅줉??怨꾩젙??李얠쓣 ???놁뒿?덈떎.');
    }
    if (account.emailVerified) {
      throw new BadRequestException('?대? ?대찓???몄쬆???꾨즺??怨꾩젙?낅땲??');
    }
    const verification = await this.createEmailVerification(account.id, normalized);
    await this.dispatchVerificationEmail(verification);
    return {
      accountId: account.id,
      email: normalized,
      expiresAt: verification.expiresAt.toISOString(),
    };
  }

  async requestPasswordReset(email: string): Promise<PasswordResetRequestResult> {
    const normalized = email.trim().toLowerCase();
    if (!normalized) {
      throw new BadRequestException('이메일을 입력해 주세요.');
    }
    const target = await this.findSinglePasswordAccountByEmail(normalized);
    if (!target || !target.email) {
      return { accepted: true };
    }
    const reset = await this.createPasswordReset(target.id, target.email);
    await this.dispatchPasswordResetEmail(reset);
    return { accepted: true };
  }

  async resetPassword(token: string, newPassword: string): Promise<PasswordResetConfirmResult> {
    const normalizedToken = token.trim();
    if (!normalizedToken) {
      throw new BadRequestException('재설정 토큰이 필요합니다.');
    }
    if (!newPassword || !PASSWORD_POLICY.test(newPassword)) {
      throw new BadRequestException('비밀번호는 8자 이상, 대문자 및 특수문자를 포함해야 합니다.');
    }
    const reset = await this.consumePasswordReset(normalizedToken);
    const passwordHash = await hash(newPassword, ARGON_OPTIONS);
    await this.prisma.$transaction([
      this.prisma.account.update({
        where: { id: reset.accountId },
        data: { passwordHash, emailVerified: true },
      }),
      this.prisma.passwordReset.deleteMany({
        where: { accountId: reset.accountId },
      }),
    ]);
    await this.sessions.revokeAllSessions(reset.accountId);
    return { success: true };
  }

  async handleDiscordCallback(
    payload: OAuthPayload,
    context: SessionContext = {},
  ): Promise<AuthSessionResult> {
    return this.handleOAuthLogin('discord', payload, context);
  }

  async handleNaverCallback(
    payload: OAuthPayload,
    context: SessionContext = {},
  ): Promise<AuthSessionResult> {
    return this.handleOAuthLogin('naver', payload, context);
  }

  async createLinkRequest(
    primaryAccountId: string,
    targetAccountId: string,
  ): Promise<AccountLinkRequest> {
    if (!this.accountLinkingEnabled) {
      throw new ForbiddenException('怨꾩젙 ?곕룞 湲곕뒫??鍮꾪솢?깊솕?섏뼱 ?덉뒿?덈떎.');
    }
    return this.accounts.createLinkRequest(primaryAccountId, targetAccountId);
  }

  async confirmLink(requestId: string, verificationCode: string): Promise<AccountLinkResult> {
    if (!this.accountLinkingEnabled) {
      throw new ForbiddenException('怨꾩젙 ?곕룞 湲곕뒫??鍮꾪솢?깊솕?섏뼱 ?덉뒿?덈떎.');
    }
    return this.accounts.confirmLink(requestId, verificationCode);
  }

  async getAccountView(accountId: string): Promise<AuthAccountView> {
    const account = await this.accounts.getAccount(accountId);
    if (!account) {
      throw new NotFoundAccountError();
    }
    return this.toAccountView(account);
  }

  getOAuthProviderAvailability(): { discord: boolean; naver: boolean } {
    const discord =
      Boolean(this.config.getOptional('DISCORD_CLIENT_ID')) &&
      Boolean(this.config.getOptional('DISCORD_CLIENT_SECRET'));
    const naver =
      Boolean(this.config.getOptional('NAVER_CLIENT_ID')) &&
      Boolean(this.config.getOptional('NAVER_CLIENT_SECRET'));
    return { discord, naver };
  }

  async updateDisplayName(accountId: string, displayName: string): Promise<AuthAccountView> {
    const trimmed = displayName.trim();
    if (trimmed.length === 0 || trimmed.length > 32) {
      throw new BadRequestException('표시 이름은 1~32자 사이여야 합니다.');
    }
    const account = await this.accounts.getAccount(accountId);
    if (!account) {
      throw new NotFoundAccountError();
    }
    const updated = await this.prisma.account.update({
      where: { id: account.id },
      data: { displayName: trimmed },
    });
    return this.toAccountView({
      ...account,
      displayName: updated.displayName,
    });
  }

  async updateAvatar(accountId: string, upload: FileImageUploadRequest): Promise<AuthAccountView> {
    const account = await this.accounts.getAccount(accountId);
    if (!account) {
      throw new NotFoundAccountError();
    }

    const stored = await this.files.createImage(account.id, {
      ...upload,
      usageContext: 'profile_avatar',
    });
    await this.prisma.account.update({
      where: { id: account.id },
      data: { avatarUrl: stored.publicPath },
    });

    return this.getAccountView(account.id);
  }

  async clearAvatar(accountId: string): Promise<AuthAccountView> {
    const account = await this.accounts.getAccount(accountId);
    if (!account) {
      throw new NotFoundAccountError();
    }

    await this.prisma.account.update({
      where: { id: account.id },
      data: { avatarUrl: null },
    });

    return this.getAccountView(account.id);
  }

  async changePassword(
    accountId: string,
    currentPassword: string,
    newPassword: string,
  ): Promise<void> {
    const account = await this.accounts.getAccount(accountId);
    if (!account) {
      throw new NotFoundAccountError();
    }
    if (!account.passwordHash) {
      throw new ForbiddenException('비밀번호가 설정되지 않은 계정입니다.');
    }
    if (!(await verify(account.passwordHash, currentPassword))) {
      throw new UnauthorizedException('현재 비밀번호가 올바르지 않습니다.');
    }
    if (!PASSWORD_POLICY.test(newPassword)) {
      throw new BadRequestException('비밀번호는 8자 이상이며 대문자/특수문자를 포함해야 합니다.');
    }
    const passwordHash = await hash(newPassword, ARGON_OPTIONS);
    await this.accounts.setPasswordHash(account.id, passwordHash);
  }

  async linkOAuthAccount(
    primaryAccountId: string,
    provider: Extract<AuthProvider, 'discord' | 'naver'>,
    payload: OAuthPayload,
  ): Promise<AuthAccountView> {
    if (!this.accountLinkingEnabled) {
      throw new ForbiddenException('계정 연동 기능이 비활성화되어 있습니다.');
    }
    if (!payload.userId) {
      throw new BadRequestException('OAuth 사용자 식별자가 필요합니다.');
    }

    const primary = await this.accounts.getAccount(primaryAccountId);
    if (!primary) {
      throw new NotFoundAccountError();
    }

    let linked = await this.accounts.findByProvider(provider, payload.userId);
    if (!linked) {
      linked = await this.accounts.registerAccount({
        provider,
        providerUserId: payload.userId,
        email: payload.email?.toLowerCase(),
        displayName: payload.displayName?.trim() || payload.userId,
        emailVerified: true,
      });
    }

    if (linked.id === primaryAccountId) {
      return this.toAccountView(primary);
    }

    const existing = await this.prisma.accountLink.findUnique({
      where: {
        primaryAccountId_linkedAccountId: {
          primaryAccountId,
          linkedAccountId: linked.id,
        },
      },
    });
    if (!existing) {
      await this.prisma.$transaction([
        this.prisma.accountLink.create({
          data: { primaryAccountId, linkedAccountId: linked.id },
        }),
        this.prisma.accountLink.create({
          data: { primaryAccountId: linked.id, linkedAccountId: primaryAccountId },
        }),
      ]);
    }

    return this.toAccountView(primary);
  }

  private async handleOAuthLogin(
    provider: Extract<AuthProvider, 'discord' | 'naver'>,
    payload: OAuthPayload,
    context: SessionContext = {},
  ): Promise<AuthSessionResult> {
    if (!payload.userId) {
      throw new BadRequestException('OAuth ?ъ슜???앸퀎?먭? ?꾩슂?⑸땲??');
    }
    const providerUserId = payload.userId;
    const existing = await this.accounts.findByProvider(provider, providerUserId);
    const account = existing
      ? existing
      : await this.accounts.registerAccount({
          provider,
          providerUserId,
          email: payload.email?.toLowerCase(),
          displayName: payload.displayName?.trim() || `${providerUserId}`,
          emailVerified: true,
        });

    const sessionAccount = await this.resolveSessionAccount(account.id);
    const updatedSessionAccount = await this.accounts.updateLastLogin(sessionAccount.id, new Date());

    const session = await this.sessions.issueSession({
      userId: updatedSessionAccount.id,
      elevated: provider === 'discord',
      ipAddress: context.ipAddress,
      userAgent: context.userAgent,
    });
    return this.toSessionResult(
      updatedSessionAccount,
      session.cookie,
      session.sessionId,
      session.expiresAt,
    );
  }

  private async resolveSessionAccount(accountId: string): Promise<AccountRecord> {
    const connectedAccountIds = await this.collectConnectedAccountIds(accountId);
    if (connectedAccountIds.size === 0) {
      throw new NotFoundAccountError();
    }

    const candidates = await this.prisma.account.findMany({
      where: {
        id: {
          in: Array.from(connectedAccountIds),
        },
      },
      select: {
        id: true,
        createdAt: true,
      },
    });

    if (candidates.length === 0) {
      throw new NotFoundAccountError();
    }

    let canonical = candidates[0];
    for (const candidate of candidates.slice(1)) {
      if (this.isPreferredCanonicalAccount(candidate, canonical)) {
        canonical = candidate;
      }
    }

    const resolved = await this.accounts.getAccount(canonical.id);
    if (!resolved) {
      throw new NotFoundAccountError();
    }
    return resolved;
  }

  private async collectConnectedAccountIds(seedAccountId: string): Promise<Set<string>> {
    const visited = new Set<string>([seedAccountId]);
    let frontier = [seedAccountId];

    while (frontier.length > 0) {
      const links = await this.prisma.accountLink.findMany({
        where: {
          OR: [
            { primaryAccountId: { in: frontier } },
            { linkedAccountId: { in: frontier } },
          ],
        },
        select: {
          primaryAccountId: true,
          linkedAccountId: true,
        },
      });

      const next: string[] = [];
      for (const link of links) {
        if (!visited.has(link.primaryAccountId)) {
          visited.add(link.primaryAccountId);
          next.push(link.primaryAccountId);
        }
        if (!visited.has(link.linkedAccountId)) {
          visited.add(link.linkedAccountId);
          next.push(link.linkedAccountId);
        }
      }
      frontier = next;
    }

    return visited;
  }

  private isPreferredCanonicalAccount(
    candidate: { id: string; createdAt: Date },
    current: { id: string; createdAt: Date },
  ): boolean {
    if (candidate.createdAt.getTime() !== current.createdAt.getTime()) {
      return candidate.createdAt.getTime() < current.createdAt.getTime();
    }
    return candidate.id < current.id;
  }

  private async toSessionResult(
    account: AccountRecord,
    cookie: string,
    sessionId: string,
    expiresAt: string,
  ): Promise<AuthSessionResult> {
    return {
      account: await this.toAccountView(account),
      sessionId,
      expiresAt,
      cookie,
    };
  }

  private async toAccountView(account: AccountRecord): Promise<AuthAccountView> {
    const linkedAccounts = await this.accounts.listLinkedAccounts(account.id);
    return {
      id: account.id,
      provider: account.provider,
      providerUserId: account.providerUserId,
      email: account.email ?? undefined,
      displayName: account.displayName ?? undefined,
      avatarUrl: account.avatarUrl ?? undefined,
      emailVerified: account.emailVerified,
      hasPassword: Boolean(account.passwordHash),
      createdAt: account.createdAt,
      lastLoginAt: account.lastLoginAt,
      linkedAccountIds: await this.accounts.getLinkedAccountIds(account.id),
      linkedAccounts,
    };
  }

  private async findSinglePasswordAccountByEmail(
    email: string,
  ): Promise<AccountRecord | undefined> {
    const candidates = await this.findPasswordAccountsByEmail(email);
    if (candidates.length <= 1) {
      return candidates[0];
    }
    throw new ConflictException(
      '?숈씪??대찓?쇰줈 鍮꾨?踰덊샇 濡쒓렇???쒕뒗 怨꾩젙???덉뼱?쒖? ?먯썝??臾몄쓽媛 ?꾩슂?⑸땲??',
    );
  }

  private async findPasswordAccountsByEmail(email: string): Promise<AccountRecord[]> {
    const accounts = await this.accounts.listAccountsByEmail(email);
    return accounts.filter((account) => Boolean(account.passwordHash));
  }

  private async createEmailVerification(
    accountId: string,
    email: string,
  ): Promise<PendingEmailVerification> {
    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + EMAIL_VERIFICATION_TTL_MS);
    await this.prisma.emailVerification.deleteMany({
      where: { accountId },
    });
    const record = await this.prisma.emailVerification.create({
      data: {
        token,
        accountId,
        email,
        expiresAt,
      },
    });
    return {
      accountId: record.accountId,
      email: record.email,
      token: record.token,
      expiresAt: record.expiresAt,
    };
  }

  private async consumeEmailVerification(token: string): Promise<PendingEmailVerification> {
    await this.prisma.emailVerification.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    const pending = await this.prisma.emailVerification.findUnique({
      where: { token },
    });
    if (!pending) {
      throw new BadRequestException('?좏슚?섏? ?딄굅??留뚮즺???몄쬆 ?좏겙?낅땲???');
    }
    if (pending.expiresAt.getTime() < Date.now()) {
      await this.prisma.emailVerification.delete({ where: { token } });
      throw new BadRequestException('?좏슚?섏? ?딄굅??留뚮즺???몄쬆 ?좏겙?낅땲???');
    }
    await this.prisma.emailVerification.delete({ where: { token } });
    return {
      accountId: pending.accountId,
      email: pending.email,
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
  }

  private async createPasswordReset(
    accountId: string,
    email: string,
  ): Promise<PendingPasswordReset> {
    const token = this.generateToken();
    const expiresAt = new Date(Date.now() + PASSWORD_RESET_TTL_MS);
    await this.prisma.passwordReset.deleteMany({
      where: { OR: [{ accountId }, { email }] },
    });
    const record = await this.prisma.passwordReset.create({
      data: {
        token,
        accountId,
        email,
        expiresAt,
      },
    });
    return {
      accountId: record.accountId,
      email: record.email,
      token: record.token,
      expiresAt: record.expiresAt,
    };
  }

  private async consumePasswordReset(token: string): Promise<PendingPasswordReset> {
    await this.prisma.passwordReset.deleteMany({
      where: { expiresAt: { lt: new Date() } },
    });
    const pending = await this.prisma.passwordReset.findUnique({
      where: { token },
    });
    if (!pending) {
      throw new BadRequestException('유효하지 않거나 만료된 비밀번호 재설정 토큰입니다.');
    }
    if (pending.expiresAt.getTime() < Date.now()) {
      await this.prisma.passwordReset.delete({ where: { token } });
      throw new BadRequestException('유효하지 않거나 만료된 비밀번호 재설정 토큰입니다.');
    }
    await this.prisma.passwordReset.delete({ where: { token } });
    return {
      accountId: pending.accountId,
      email: pending.email,
      token: pending.token,
      expiresAt: pending.expiresAt,
    };
  }

  private buildPasswordResetUrl(token: string): string | undefined {
    const baseUrl = this.config.getOptional('NEXT_PUBLIC_SITE_URL');
    if (!baseUrl) {
      return undefined;
    }
    return `${baseUrl.replace(/\/$/, '')}/login/reset-password?token=${encodeURIComponent(token)}`;
  }

  private async dispatchVerificationEmail(verification: PendingEmailVerification): Promise<void> {
    if (!this.emailService.isEnabled()) {
      this.logger.debug(
        { accountId: verification.accountId },
        'Issued email verification token (SMTP not configured)',
      );
      return;
    }
    try {
      await this.emailService.sendVerificationEmail({
        email: verification.email,
        token: verification.token,
        expiresAt: verification.expiresAt,
      });
    } catch (error) {
      this.emailService.logDeliveryFailure(error);
    }
  }

  private async dispatchPasswordResetEmail(reset: PendingPasswordReset): Promise<void> {
    if (!this.emailService.isEnabled()) {
      this.logger.debug(
        { accountId: reset.accountId },
        'Issued password reset token (SMTP not configured)',
      );
      return;
    }
    const resetUrl = this.buildPasswordResetUrl(reset.token);
    try {
      await this.emailService.sendPasswordResetEmail({
        email: reset.email,
        token: reset.token,
        expiresAt: reset.expiresAt,
        resetUrl,
      });
    } catch (error) {
      this.emailService.logDeliveryFailure(error);
    }
  }

  private generateToken(): string {
    return randomBytes(24).toString('hex');
  }
}

class NotFoundAccountError extends NotFoundException {
  constructor() {
    super('怨꾩젙??李얠쓣 ???놁뒿?덈떎.');
  }
}
