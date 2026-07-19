import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  ForbiddenException,
  Get,
  Param,
  ParseUUIDPipe,
  Patch,
  Post,
  Res,
  Req,
  UseGuards,
  UnauthorizedException,
} from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import type { FastifyReply, FastifyRequest } from 'fastify';
import {
  AuthService,
  type AuthSessionResult,
  type EmailRegistrationResult,
  type PasswordResetConfirmResult,
  type PasswordResetRequestResult,
  type ResendVerificationResult,
} from './auth.service';
import { SessionGuard } from '../session/session.guard';
import { CurrentSession } from '../session/session.decorator';
import { SessionService, type SessionPayload } from '../session/session.service';
import { issueCsrfToken } from '../session/csrf';
import {
  emailLoginRequestSchema,
  emailLoginSetupRequestSchema,
  emailRegistrationRequestSchema,
  emailResendRequestSchema,
  emailVerificationRequestSchema,
  oauthStartRequestSchema,
  oauthCompleteRequestSchema,
  oauthSignupConsentRequestSchema,
  passwordChangeRequestSchema,
  policyConsentAcceptRequestSchema,
  passwordResetConfirmRequestSchema,
  passwordResetRequestSchema,
  type OAuthProvider,
} from '@minewiki/schemas';
import { OAuthFlowService } from './oauth-flow.service';
import { extractClientIp } from '../common/http/client-ip';
import {
  hashOAuthBrowserBinding,
  issueOAuthBrowserBinding,
  readOAuthBrowserBinding
} from './oauth-browser-binding';
import {
  clearOAuthSignupTicketCookie,
  issueOAuthSignupTicket,
  readOAuthSignupTicket
} from './oauth-signup-ticket';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly oauthFlow: OAuthFlowService,
  ) {}

  @Post('oauth/start')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  startOAuth(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const payload = oauthStartRequestSchema.parse(body);
    const binding = issueOAuthBrowserBinding(request.headers.cookie);
    reply.header('Set-Cookie', binding.cookie);
    return this.oauthFlow.start(
      payload.provider,
      payload.redirectUri,
      payload.returnTo,
      'login',
      undefined,
      payload.agreeTerms,
      payload.agreePrivacy,
      hashOAuthBrowserBinding(binding.value),
    );
  }

  @UseGuards(SessionGuard)
  @Post('oauth/link')
  @Throttle({ default: { limit: 5, ttl: 60 } })
  startOAuthLink(
    @Body() body: unknown,
    @CurrentSession() session: SessionPayload,
    @Req() request: FastifyRequest,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    const payload = oauthStartRequestSchema.parse(body);
    const binding = issueOAuthBrowserBinding(request.headers.cookie);
    reply.header('Set-Cookie', binding.cookie);
    return this.oauthFlow.start(
      payload.provider,
      payload.redirectUri,
      payload.returnTo,
      'link',
      session.userId,
      false,
      false,
      hashOAuthBrowserBinding(binding.value),
    );
  }

  @Post('oauth/complete')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  async completeOAuth(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const payload = oauthCompleteRequestSchema.parse(body);
    const browserBinding = readOAuthBrowserBinding(request.headers.cookie);
    if (!browserBinding) {
      throw new BadRequestException('OAuth 브라우저 확인 정보가 없습니다. 다시 시도해 주세요.');
    }
    const profile = await this.oauthFlow.complete(
      payload.provider,
      payload.code,
      payload.state,
      payload.redirectUri,
      browserBinding,
    );
    if (profile.mode === 'link') {
      const sessionRecord = await this.getOptionalSession(request);
      if (!sessionRecord || sessionRecord.userId !== profile.linkAccountId) {
        throw new UnauthorizedException('로그인이 필요합니다.');
      }
      const account = await this.auth.linkOAuthAccount(sessionRecord.userId, payload.provider, {
        userId: profile.providerUserId,
        email: profile.email,
        displayName: profile.displayName,
      });
      await this.oauthFlow.storeCredential(
        sessionRecord.userId,
        payload.provider,
        profile.providerUserId,
        profile.credential,
      );
      return {
        consentRequired: false,
        account,
        sessionId: sessionRecord.sessionId,
        expiresAt: sessionRecord.expiresAt.toISOString(),
        returnTo: profile.returnTo ?? null,
        mode: 'link',
      };
    }

    const existingAccount = await this.auth.hasOAuthAccount(payload.provider, profile.providerUserId);
    if (!existingAccount && (!profile.agreeTerms || !profile.agreePrivacy)) {
      const signup = issueOAuthSignupTicket();
      await this.oauthFlow.createPendingSignup(profile, signup.hash, browserBinding);
      reply.header('Set-Cookie', signup.cookie);
      return {
        consentRequired: true,
        provider: payload.provider,
        returnTo: profile.returnTo ?? null
      };
    }

    const session = await this.finalizeOAuth(payload.provider, profile, reply, request);
    await this.oauthFlow.storeCredential(
      session.account.id,
      payload.provider,
      profile.providerUserId,
      profile.credential,
    );
    return {
      consentRequired: false,
      account: session.account,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      returnTo: profile.returnTo ?? null,
      mode: 'login',
    };
  }

  @Post('oauth/signup/consent')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async acceptOAuthSignupConsent(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    oauthSignupConsentRequestSchema.parse(body);
    const browserBinding = readOAuthBrowserBinding(request.headers.cookie);
    const signupTicket = readOAuthSignupTicket(request.headers.cookie);
    if (!browserBinding || !signupTicket) {
      throw new BadRequestException('신규 가입 확인이 없거나 만료되었습니다. 간편 로그인을 다시 시작해 주세요.');
    }
    const profile = await this.oauthFlow.consumePendingSignup(signupTicket, browserBinding);
    const session = await this.finalizeOAuth(profile.provider, profile, reply, request);
    await this.oauthFlow.storeCredential(
      session.account.id,
      profile.provider,
      profile.providerUserId,
      profile.credential,
    );
    reply.header('Set-Cookie', [session.cookie, clearOAuthSignupTicketCookie()]);
    return {
      consentRequired: false,
      account: session.account,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      returnTo: profile.returnTo ?? null,
      mode: 'login' as const,
    };
  }

  @Post('email/register')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  registerEmail(
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ): Promise<EmailRegistrationResult> {
    const payload = emailRegistrationRequestSchema.parse(body);
    return this.auth.registerEmail({
      email: payload.email!,
      password: payload.password!,
      displayName: payload.displayName,
      agreeTerms: payload.agreeTerms,
      agreePrivacy: payload.agreePrivacy,
      context: this.extractSessionContext(request),
    });
  }

  @Post('email/login')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async loginEmail(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const payload = emailLoginRequestSchema.parse(body);
    const result = await this.auth.loginEmail(
      { email: payload.email!, password: payload.password! },
      this.extractSessionContext(request),
    );
    reply.header('Set-Cookie', result.cookie);
    return {
      account: result.account,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  @Post('email/verify')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async verifyEmail(
    @Body() body: unknown,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const payload = emailVerificationRequestSchema.parse(body);
    const result = await this.auth.verifyEmail(payload.token, this.extractSessionContext(request));
    reply.header('Set-Cookie', result.cookie);
    return {
      account: result.account,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  @Post('email/resend')
  @Throttle({ default: { limit: 3, ttl: 300 } })
  resendVerification(@Body() body: unknown): Promise<ResendVerificationResult> {
    const payload = emailResendRequestSchema.parse(body);
    return this.auth.resendVerification(payload.email);
  }

  @UseGuards(SessionGuard)
  @Post('email/setup')
  @Throttle({ default: { limit: 3, ttl: 300 } })
  setupEmailLogin(
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ): Promise<ResendVerificationResult> {
    const payload = emailLoginSetupRequestSchema.parse(body);
    return this.auth.setupEmailLogin(session, {
      email: payload.email!,
      password: payload.password!,
    });
  }

  @Post('password/forgot')
  @Throttle({ default: { limit: 3, ttl: 300 } })
  requestPasswordReset(@Body() body: unknown): Promise<PasswordResetRequestResult> {
    const payload = passwordResetRequestSchema.parse(body);
    return this.auth.requestPasswordReset(payload.email);
  }

  @Post('password/reset')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  resetPassword(@Body() body: unknown): Promise<PasswordResetConfirmResult> {
    const payload = passwordResetConfirmRequestSchema.parse(body);
    return this.auth.resetPassword(payload.token, payload.newPassword);
  }

  private async finalizeOAuth(
    provider: OAuthProvider,
    profile: { providerUserId: string; email?: string; displayName?: string; agreeTerms: boolean; agreePrivacy: boolean },
    reply: FastifyReply,
    request: FastifyRequest,
  ): Promise<AuthSessionResult> {
    const handler =
      provider === 'discord'
        ? this.auth.handleDiscordCallback.bind(this.auth)
        : this.auth.handleNaverCallback.bind(this.auth);
    const result = await handler(
      {
        userId: profile.providerUserId,
        email: profile.email,
        displayName: profile.displayName,
        agreeTerms: profile.agreeTerms,
        agreePrivacy: profile.agreePrivacy,
      },
      this.extractSessionContext(request),
    );
    reply.header('Set-Cookie', result.cookie);
    return result;
  }

  @UseGuards(SessionGuard)
  @Get('csrf')
  csrf(@Req() request: FastifyRequest) {
    if (!request.sessionToken) {
      throw new UnauthorizedException('로그인이 필요합니다.');
    }
    return { csrfToken: issueCsrfToken(request.sessionToken) };
  }

  @UseGuards(SessionGuard)
  @Get('me')
  async me(@CurrentSession() session: SessionPayload) {
    const account = await this.auth.getAccountView(session.userId, session.policyConsent);
    return {
      ...account,
      access: {
        isElevated: false,
        authLevel: session.authLevel ?? 'aal1',
        stepUpExpiresAt: session.stepUpExpiresAt ?? null,
        stepUpPurpose: session.stepUpPurpose ?? null,
        roles: [...(session.groups ?? [])],
        permissions: [...(session.permissions ?? [])],
      },
    };
  }

  @UseGuards(SessionGuard)
  @Post('policies/accept')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  acceptPolicies(
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
    @Req() request: FastifyRequest,
  ) {
    policyConsentAcceptRequestSchema.parse(body);
    return this.sessions.acceptCurrentPolicies(session.userId, this.extractSessionContext(request));
  }

  @UseGuards(SessionGuard)
  @Patch('me')
  @Throttle({ default: { limit: 20, ttl: 60 } })
  updateDisplayName(
    @CurrentSession() session: SessionPayload,
    @Body('displayName') displayName: string,
  ) {
    return this.auth.updateDisplayName(session.userId, displayName ?? '');
  }

  @UseGuards(SessionGuard)
  @Post('me/avatar')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  updateAvatar(
    @CurrentSession() session: SessionPayload,
    @Body('data') data: string,
    @Body('filename') filename?: string,
  ) {
    if (!data?.trim()) {
      throw new BadRequestException('이미지 데이터가 필요합니다.');
    }

    return this.auth.updateAvatar(session.userId, {
      data,
      filename: filename?.trim() ? filename.trim() : undefined,
    });
  }

  @UseGuards(SessionGuard)
  @Delete('me/avatar')
  @Throttle({ default: { limit: 10, ttl: 300 } })
  clearAvatar(@CurrentSession() session: SessionPayload) {
    return this.auth.clearAvatar(session.userId);
  }

  @UseGuards(SessionGuard)
  @Patch('password')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  async changePassword(
    @CurrentSession() session: SessionPayload,
    @Body() body: unknown,
  ) {
    const payload = passwordChangeRequestSchema.parse(body);
    await this.auth.changePassword(
      session.userId,
      payload.currentPassword,
      payload.newPassword,
      session.sessionId,
    );
    return { success: true };
  }

  @UseGuards(SessionGuard)
  @Post('logout')
  async logout(
    @CurrentSession() session: SessionPayload,
    @Res({ passthrough: true }) reply: FastifyReply,
  ) {
    await this.sessions.revokeSession(session.sessionId);
    reply.header('Set-Cookie', 'mw_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Strict');
    return { success: true };
  }

  @Get('providers')
  providers() {
    return this.auth.getOAuthProviderAvailability();
  }

  @Get('accounts/:accountId')
  @UseGuards(SessionGuard)
  getAccount(
    @Param('accountId', new ParseUUIDPipe()) accountId: string,
    @CurrentSession() session: SessionPayload,
  ) {
    if (accountId !== session.userId) {
      throw new ForbiddenException('본인 계정만 조회할 수 있습니다.');
    }
    return this.auth.getAccountView(accountId);
  }

  private extractSessionContext(request: FastifyRequest) {
    return {
      ipAddress: extractClientIp(request) ?? null,
      userAgent: (request.headers['user-agent'] as string | undefined) ?? null,
    };
  }

  private async getOptionalSession(request: FastifyRequest) {
    const token = extractSessionToken(request);
    if (!token) {
      return undefined;
    }
    return this.sessions.getSessionByToken(token);
  }
}

function extractSessionToken(request: FastifyRequest): string | undefined {
  const cookieHeader = request.headers.cookie;
  if (!cookieHeader) {
    return undefined;
  }
  for (const part of cookieHeader.split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === 'mw_session') {
      return decodeURIComponent(value ?? '');
    }
  }
  return undefined;
}
