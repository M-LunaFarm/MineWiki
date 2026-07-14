import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@minewiki/config';
import { AuthService, hashAuthToken } from './auth.service';
import { AccountSeparationService } from './account-separation.service';
import { SessionService } from '../session/session.service';
import { PrismaService } from '../common/prisma.service';
import { UploadService } from '../upload/upload.service';
import { FileService } from '../file/file.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();
  const verificationTokens = new Map<string, string>();
  const passwordResetTokens = new Map<string, string>();

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  const createAuthService = (configValues: Record<string, string | undefined> = {}) => {
    const config = new ConfigService({ ...configValues } as NodeJS.ProcessEnv);
    const emailService = {
      isEnabled: () => true,
      sendVerificationEmail: async (payload: { email: string; token: string }) => {
        verificationTokens.set(payload.email, payload.token);
      },
      sendPasswordResetEmail: async (payload: { email: string; token: string }) => {
        passwordResetTokens.set(payload.email, payload.token);
      },
      logDeliveryFailure: (error: unknown) => {
        throw error;
      },
    };
    const accounts = new AccountSeparationService(prisma);
    const sessions = new SessionService(prisma);
    const uploads = new UploadService(config);
    const files = new FileService(prisma, uploads);
    return new AuthService(accounts, sessions, prisma, emailService as never, config, files);
  };

  const getVerificationToken = async (accountId: string) => {
    const pending = await prisma.emailVerification.findFirst({ where: { accountId } });
    assert.ok(pending?.token);
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    assert.ok(account?.email);
    const token = verificationTokens.get(account.email);
    assert.ok(token);
    assert.equal(pending.token, hashAuthToken(token));
    assert.notEqual(pending.token, token);
    return token;
  };

  const getPasswordResetToken = async (accountId: string) => {
    const pending = await prisma.passwordReset.findFirst({ where: { accountId } });
    assert.ok(pending?.token);
    const account = await prisma.account.findUnique({ where: { id: accountId } });
    assert.ok(account?.email);
    const token = passwordResetTokens.get(account.email);
    assert.ok(token);
    assert.equal(pending.token, hashAuthToken(token));
    assert.notEqual(pending.token, token);
    return token;
  };

  test('email registration requires verification before login', async () => {
    const service = createAuthService();
    const email = 'player-' + randomUUID() + '@example.com';
    const registration = await service.registerEmail({
      email,
      password: 'SupersafePW1!',
      displayName: 'Player',
      agreeTerms: true,
      agreePrivacy: true,
    });

    assert.equal(registration.status, 'verification-required');
    const consents = await prisma.accountConsent.findMany({
      where: { accountId: registration.accountId },
      orderBy: { consentType: 'asc' },
    });
    assert.deepEqual(
      consents.map((consent) => [consent.consentType, consent.policyVersion]),
      [
        ['privacy', '2026-07-11-v1.1'],
        ['terms', '2026-07-11-v1.1'],
      ],
    );
    const token = await getVerificationToken(registration.accountId);
    const storedVerification = await prisma.emailVerification.findFirst({
      where: { accountId: registration.accountId },
    });
    assert.ok(storedVerification?.token);
    await assert.rejects(
      () => service.verifyEmail(storedVerification.token),
      (error: unknown) => error instanceof BadRequestException,
    );

    await assert.rejects(
      () => service.loginEmail({ email, password: 'SupersafePW1!' }),
      (error: unknown) => error instanceof ForbiddenException,
    );

    const verified = await service.verifyEmail(token);
    assert.ok(verified.cookie.includes('HttpOnly'));
    assert.ok(verified.cookie.includes('Secure'));
    assert.ok(verified.cookie.includes('SameSite=Strict'));

    const login = await service.loginEmail({ email, password: 'SupersafePW1!' });
    assert.equal(login.account.id, verified.account.id);
    assert.ok(login.cookie.includes('HttpOnly'));
  });

  test('resending verification rotates token', async () => {
    const service = createAuthService();
    const email = 'rotate-' + randomUUID() + '@example.com';
    const registration = await service.registerEmail({
      email,
      password: 'SupersafePW1!',
      displayName: 'Player',
      agreeTerms: true,
      agreePrivacy: true,
    });

    const firstToken = await getVerificationToken(registration.accountId);
    await service.resendVerification(email);
    const secondToken = await getVerificationToken(registration.accountId);

    assert.notEqual(secondToken, firstToken);
    await assert.rejects(
      () => service.verifyEmail(firstToken),
      (error: unknown) => error instanceof BadRequestException,
    );
    const session = await service.verifyEmail(secondToken);
    assert.equal(session.account.id, registration.accountId);

    const verifiedResponse = await service.resendVerification(email);
    const missingEmail = 'missing-' + randomUUID() + '@example.com';
    const missingResponse = await service.resendVerification(missingEmail);
    assert.deepEqual(Object.keys(verifiedResponse).sort(), ['email', 'expiresAt']);
    assert.deepEqual(Object.keys(missingResponse).sort(), ['email', 'expiresAt']);
    assert.equal(verifiedResponse.email, email);
    assert.equal(missingResponse.email, missingEmail);
    assert.equal(
      await prisma.emailVerification.count({ where: { accountId: registration.accountId } }),
      0,
    );
  });

  test('email verification keeps the token when the account update cannot be committed', async () => {
    const service = createAuthService();
    const email = 'verify-rollback-' + randomUUID() + '@example.com';
    const registration = await service.registerEmail({
      email,
      password: 'SupersafePW1!',
      displayName: 'RollbackPlayer',
      agreeTerms: true,
      agreePrivacy: true,
    });
    const token = await getVerificationToken(registration.accountId);

    await prisma.account.update({
      where: { id: registration.accountId },
      data: { email: 'changed-' + randomUUID() + '@example.com' },
    });

    await assert.rejects(
      () => service.verifyEmail(token),
      (error: unknown) => error instanceof BadRequestException,
    );
    assert.equal(
      await prisma.emailVerification.count({ where: { accountId: registration.accountId } }),
      1,
    );
    const account = await prisma.account.findUnique({ where: { id: registration.accountId } });
    assert.equal(account?.emailVerified, false);
  });

  test('password reset updates credentials', async () => {
    const service = createAuthService();
    const email = 'reset-' + randomUUID() + '@example.com';
    const initialPassword = 'SupersafePW1!';
    const registration = await service.registerEmail({
      email,
      password: initialPassword,
      displayName: 'Player',
      agreeTerms: true,
      agreePrivacy: true,
    });
    const verificationToken = await getVerificationToken(registration.accountId);
    await service.verifyEmail(verificationToken);

    await service.requestPasswordReset(email);
    const resetToken = await getPasswordResetToken(registration.accountId);
    const storedReset = await prisma.passwordReset.findFirst({
      where: { accountId: registration.accountId },
    });
    assert.ok(storedReset?.token);
    await assert.rejects(
      () => service.resetPassword(storedReset.token, 'AttackerPW1!'),
      (error: unknown) => error instanceof BadRequestException,
    );
    await service.resetPassword(resetToken, 'UpdatedPW1!');

    await assert.rejects(
      () => service.loginEmail({ email, password: initialPassword }),
      (error: unknown) => error instanceof UnauthorizedException,
    );
    const login = await service.loginEmail({ email, password: 'UpdatedPW1!' });
    assert.equal(login.account.email, email);
  });

  test('password reset atomically preserves credentials, token, and sessions on account drift', async () => {
    const service = createAuthService();
    const email = 'reset-rollback-' + randomUUID() + '@example.com';
    const registration = await service.registerEmail({
      email,
      password: 'SupersafePW1!',
      displayName: 'RollbackPlayer',
      agreeTerms: true,
      agreePrivacy: true,
    });
    await service.verifyEmail(await getVerificationToken(registration.accountId));
    await service.requestPasswordReset(email);
    const resetToken = await getPasswordResetToken(registration.accountId);
    const before = await prisma.account.findUnique({ where: { id: registration.accountId } });
    const sessionCount = await prisma.session.count({
      where: { accountId: registration.accountId },
    });

    await prisma.account.update({
      where: { id: registration.accountId },
      data: { email: 'changed-' + randomUUID() + '@example.com' },
    });

    await assert.rejects(
      () => service.resetPassword(resetToken, 'UpdatedPW1!'),
      (error: unknown) => error instanceof BadRequestException,
    );
    const after = await prisma.account.findUnique({ where: { id: registration.accountId } });
    assert.equal(after?.passwordHash, before?.passwordHash);
    assert.equal(
      await prisma.passwordReset.count({ where: { accountId: registration.accountId } }),
      1,
    );
    assert.equal(
      await prisma.session.count({ where: { accountId: registration.accountId } }),
      sessionCount,
    );
  });

  test('verification and reset tokens can only be claimed once under concurrency', async () => {
    const service = createAuthService();
    const email = 'token-race-' + randomUUID() + '@example.com';
    const registration = await service.registerEmail({
      email,
      password: 'SupersafePW1!',
      displayName: 'RacePlayer',
      agreeTerms: true,
      agreePrivacy: true,
    });
    const verificationToken = await getVerificationToken(registration.accountId);
    const verificationResults = await Promise.allSettled([
      service.verifyEmail(verificationToken),
      service.verifyEmail(verificationToken),
    ]);
    assert.equal(
      verificationResults.filter((result) => result.status === 'fulfilled').length,
      1,
    );
    assert.equal(
      verificationResults.filter((result) => result.status === 'rejected').length,
      1,
    );

    await service.requestPasswordReset(email);
    const resetToken = await getPasswordResetToken(registration.accountId);
    const resetResults = await Promise.allSettled([
      service.resetPassword(resetToken, 'FirstResetPW1!'),
      service.resetPassword(resetToken, 'SecondResetPW1!'),
    ]);
    assert.equal(resetResults.filter((result) => result.status === 'fulfilled').length, 1);
    assert.equal(resetResults.filter((result) => result.status === 'rejected').length, 1);
    assert.equal(
      await prisma.passwordReset.count({ where: { accountId: registration.accountId } }),
      0,
    );
    assert.equal(
      await prisma.session.count({ where: { accountId: registration.accountId } }),
      0,
    );
  });

  test('password change invalidates every outstanding reset token', async () => {
    const service = createAuthService();
    const email = 'change-' + randomUUID() + '@example.com';
    const initialPassword = 'InitialPW1!';
    const registration = await service.registerEmail({
      email,
      password: initialPassword,
      displayName: 'Player',
      agreeTerms: true,
      agreePrivacy: true,
    });
    await service.verifyEmail(await getVerificationToken(registration.accountId));
    await service.requestPasswordReset(email);
    const resetToken = await getPasswordResetToken(registration.accountId);

    await service.changePassword(registration.accountId, initialPassword, 'ChangedPW1!');

    assert.equal(
      await prisma.passwordReset.count({ where: { accountId: registration.accountId } }),
      0,
    );
    await assert.rejects(
      () => service.resetPassword(resetToken, 'AttackerPW1!'),
      (error: unknown) => error instanceof BadRequestException,
    );
    await assert.rejects(
      () => service.loginEmail({ email, password: initialPassword }),
      (error: unknown) => error instanceof UnauthorizedException,
    );
    const login = await service.loginEmail({ email, password: 'ChangedPW1!' });
    assert.equal(login.account.id, registration.accountId);
  });

  test('oauth account can enable email/password login on the same account', async () => {
    const service = createAuthService();
    const oauth = await service.handleNaverCallback({
      userId: 'naver-' + randomUUID(),
      displayName: 'OAuthUser',
      agreeTerms: true,
      agreePrivacy: true,
    });

    const email = 'oauth-setup-' + randomUUID() + '@example.com';
    const setup = await service.setupEmailLogin(oauth.account.id, {
      email,
      password: 'EnablePW1!',
    });
    assert.deepEqual(Object.keys(setup).sort(), ['email', 'expiresAt']);
    assert.equal(setup.email, email);

    await assert.rejects(
      () => service.loginEmail({ email, password: 'EnablePW1!' }),
      (error: unknown) => error instanceof ForbiddenException,
    );

    const token = await getVerificationToken(oauth.account.id);
    await service.verifyEmail(token);

    const login = await service.loginEmail({ email, password: 'EnablePW1!' });
    assert.equal(login.account.id, oauth.account.id);
    assert.equal(login.account.provider, 'naver');
    assert.equal(login.account.hasPassword, true);
    assert.equal(login.account.emailVerified, true);
  });

  test('discord and email accounts with same email remain separate', async () => {
    const service = createAuthService();
    const email = 'duplicate-' + randomUUID() + '@example.com';
    const emailRegistration = await service.registerEmail({
      email,
      password: 'anotherPW1!',
      displayName: 'EmailUser',
      agreeTerms: true,
      agreePrivacy: true,
    });
    const token = await getVerificationToken(emailRegistration.accountId);
    const emailAccount = await service.verifyEmail(token);

    const discordAccount = await service.handleDiscordCallback({
      userId: 'discord-' + randomUUID(),
      email,
      displayName: 'DiscordUser',
      agreeTerms: true,
      agreePrivacy: true,
    });

    const discordSession = await prisma.session.findUnique({
      where: { id: discordAccount.sessionId },
      select: { isElevated: true },
    });

    assert.notEqual(emailAccount.account.id, discordAccount.account.id);
    assert.equal(discordAccount.account.provider, 'discord');
    assert.equal(discordAccount.account.email, email);
    assert.equal(discordAccount.account.linkedAccountIds.length, 0);
    assert.equal(discordSession?.isElevated, false);
  });

  test('manual account linking requires feature flag and confirmation', async () => {
    const serviceDisabled = createAuthService({ ACCOUNT_LINKING_ENABLED: 'false' });
    const primaryRegistration = await serviceDisabled.registerEmail({
      email: 'link-' + randomUUID() + '@example.com',
      password: 'LinkPW123!',
      displayName: 'LinkUser',
      agreeTerms: true,
      agreePrivacy: true,
    });
    const primaryToken = await getVerificationToken(primaryRegistration.accountId);
    const primary = await serviceDisabled.verifyEmail(primaryToken);
    const discord = await serviceDisabled.handleDiscordCallback({
      userId: 'discord-' + randomUUID(),
      email: 'link-' + randomUUID() + '@example.com',
      agreeTerms: true,
      agreePrivacy: true,
    });

    await assert.rejects(
      () => serviceDisabled.createLinkRequest(primary.account.id, discord.account.id),
      (error: unknown) => error instanceof ForbiddenException,
    );

    const serviceEnabled = createAuthService({ ACCOUNT_LINKING_ENABLED: 'true' });
    const emailRegistration = await serviceEnabled.registerEmail({
      email: 'link2-' + randomUUID() + '@example.com',
      password: 'LinkPW456!',
      displayName: 'Linker',
      agreeTerms: true,
      agreePrivacy: true,
    });
    const emailToken = await getVerificationToken(emailRegistration.accountId);
    const emailAcc = await serviceEnabled.verifyEmail(emailToken);
    const discordAcc = await serviceEnabled.handleDiscordCallback({
      userId: 'discord-' + randomUUID(),
      email: 'link2-' + randomUUID() + '@example.com',
      agreeTerms: true,
      agreePrivacy: true,
    });

    const request = await serviceEnabled.createLinkRequest(
      emailAcc.account.id,
      discordAcc.account.id,
    );
    const result = await serviceEnabled.confirmLink(request.id, request.verificationCode);
    assert.equal(result.primaryAccountId, emailAcc.account.id);
    assert.ok(result.linkedAccountIds.includes(discordAcc.account.id));
  });

  test('linked oauth providers issue sessions for the same canonical account', async () => {
    const service = createAuthService({ ACCOUNT_LINKING_ENABLED: 'true' });
    const discordUserId = 'discord-' + randomUUID();
    const naverUserId = 'naver-' + randomUUID();

    const discordLogin = await service.handleDiscordCallback({
      userId: discordUserId,
      displayName: 'DiscordPrimary',
      agreeTerms: true,
      agreePrivacy: true,
    });

    await service.linkOAuthAccount(discordLogin.account.id, 'naver', {
      userId: naverUserId,
      displayName: 'NaverLinked',
    });

    const linkedNaver = await prisma.account.findUnique({
      where: { provider_providerUserId: { provider: 'naver', providerUserId: naverUserId } },
    });
    assert.ok(linkedNaver);
    await prisma.account.update({
      where: { id: linkedNaver.id },
      data: {
        createdAt: new Date(
          new Date(discordLogin.account.createdAt).getTime() - 86_400_000,
        ),
      },
    });

    const naverLogin = await service.handleNaverCallback({
      userId: naverUserId,
      displayName: 'NaverLinked',
    });

    assert.equal(naverLogin.account.id, discordLogin.account.id);
    assert.equal(naverLogin.account.provider, 'discord');
    assert.equal(linkedNaver.canonicalAccountId, discordLogin.account.id);
    assert.ok(naverLogin.account.linkedAccounts.some((account) => account.provider === 'naver'));
  });
}
