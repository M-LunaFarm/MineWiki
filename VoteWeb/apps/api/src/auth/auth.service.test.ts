import { after, before, test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { BadRequestException, ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@creepervote/config';
import { AuthService } from './auth.service';
import { AccountSeparationService } from './account-separation.service';
import { SessionService } from '../session/session.service';
import { PrismaService } from '../common/prisma.service';
import { EmailService } from './email.service';
import { UploadService } from '../upload/upload.service';

const hasDatabase = Boolean(process.env.DATABASE_URL);

if (!hasDatabase) {
  test('database required', { skip: 'DATABASE_URL is not configured.' }, () => {});
} else {
  const prisma = new PrismaService();

  before(async () => {
    await prisma.$connect();
  });

  after(async () => {
    await prisma.$disconnect();
  });

  const createAuthService = (configValues: Record<string, string | undefined> = {}) => {
    const config = new ConfigService({ ...configValues } as NodeJS.ProcessEnv);
    const emailService = new EmailService(config);
    const accounts = new AccountSeparationService(prisma);
    const sessions = new SessionService(prisma);
    const uploads = new UploadService(config);
    return new AuthService(accounts, sessions, prisma, emailService, config, uploads);
  };

  const getVerificationToken = async (accountId: string) => {
    const pending = await prisma.emailVerification.findFirst({ where: { accountId } });
    assert.ok(pending?.token);
    return pending.token;
  };

  const getPasswordResetToken = async (accountId: string) => {
    const pending = await prisma.passwordReset.findFirst({ where: { accountId } });
    assert.ok(pending?.token);
    return pending.token;
  };

  test('email registration requires verification before login', async () => {
    const service = createAuthService();
    const email = 'player-' + randomUUID() + '@example.com';
    const registration = await service.registerEmail({
      email,
      password: 'SupersafePW1!',
      displayName: 'Player',
    });

    assert.equal(registration.status, 'verification-required');
    const token = await getVerificationToken(registration.accountId);

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
  });

  test('password reset updates credentials', async () => {
    const service = createAuthService();
    const email = 'reset-' + randomUUID() + '@example.com';
    const initialPassword = 'SupersafePW1!';
    const registration = await service.registerEmail({
      email,
      password: initialPassword,
      displayName: 'Player',
    });
    const verificationToken = await getVerificationToken(registration.accountId);
    await service.verifyEmail(verificationToken);

    await service.requestPasswordReset(email);
    const resetToken = await getPasswordResetToken(registration.accountId);
    await service.resetPassword(resetToken, 'UpdatedPW1!');

    await assert.rejects(
      () => service.loginEmail({ email, password: initialPassword }),
      (error: unknown) => error instanceof UnauthorizedException,
    );
    const login = await service.loginEmail({ email, password: 'UpdatedPW1!' });
    assert.equal(login.account.email, email);
  });

  test('oauth account can enable email/password login on the same account', async () => {
    const service = createAuthService();
    const oauth = await service.handleNaverCallback({
      userId: 'naver-' + randomUUID(),
      displayName: 'OAuthUser',
    });

    const email = 'oauth-setup-' + randomUUID() + '@example.com';
    const setup = await service.setupEmailLogin(oauth.account.id, {
      email,
      password: 'EnablePW1!',
    });
    assert.equal(setup.accountId, oauth.account.id);
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
    });
    const token = await getVerificationToken(emailRegistration.accountId);
    const emailAccount = await service.verifyEmail(token);

    const discordAccount = await service.handleDiscordCallback({
      userId: 'discord-' + randomUUID(),
      email,
      displayName: 'DiscordUser',
    });

    assert.notEqual(emailAccount.account.id, discordAccount.account.id);
    assert.equal(discordAccount.account.provider, 'discord');
    assert.equal(discordAccount.account.email, email);
    assert.equal(discordAccount.account.linkedAccountIds.length, 0);
  });

  test('manual account linking requires feature flag and confirmation', async () => {
    const serviceDisabled = createAuthService({ ACCOUNT_LINKING_ENABLED: 'false' });
    const primaryRegistration = await serviceDisabled.registerEmail({
      email: 'link-' + randomUUID() + '@example.com',
      password: 'LinkPW123!',
      displayName: 'LinkUser',
    });
    const primaryToken = await getVerificationToken(primaryRegistration.accountId);
    const primary = await serviceDisabled.verifyEmail(primaryToken);
    const discord = await serviceDisabled.handleDiscordCallback({
      userId: 'discord-' + randomUUID(),
      email: 'link-' + randomUUID() + '@example.com',
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
    });
    const emailToken = await getVerificationToken(emailRegistration.accountId);
    const emailAcc = await serviceEnabled.verifyEmail(emailToken);
    const discordAcc = await serviceEnabled.handleDiscordCallback({
      userId: 'discord-' + randomUUID(),
      email: 'link2-' + randomUUID() + '@example.com',
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
    });

    await service.linkOAuthAccount(discordLogin.account.id, 'naver', {
      userId: naverUserId,
      displayName: 'NaverLinked',
    });

    const naverLogin = await service.handleNaverCallback({
      userId: naverUserId,
      displayName: 'NaverLinked',
    });

    assert.equal(naverLogin.account.id, discordLogin.account.id);
    assert.equal(naverLogin.account.provider, 'discord');
    assert.ok(naverLogin.account.linkedAccounts.some((account) => account.provider === 'naver'));
  });
}
