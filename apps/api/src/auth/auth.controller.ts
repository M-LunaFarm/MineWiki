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
  oauthStartRequestSchema,
  oauthCompleteRequestSchema,
  type OAuthProvider,
} from '@minewiki/schemas';
import { OAuthFlowService } from './oauth-flow.service';
import { extractClientIp } from '../common/http/client-ip';

@Controller('v1/auth')
export class AuthController {
  constructor(
    private readonly auth: AuthService,
    private readonly sessions: SessionService,
    private readonly oauthFlow: OAuthFlowService,
  ) {}

  @Post('oauth/start')
  @Throttle({ default: { limit: 10, ttl: 60 } })
  startOAuth(@Body() body: unknown) {
    const payload = oauthStartRequestSchema.parse(body);
    return this.oauthFlow.start(payload.provider, payload.redirectUri, payload.returnTo);
  }

  @UseGuards(SessionGuard)
  @Post('oauth/link')
  @Throttle({ default: { limit: 5, ttl: 60 } })
  startOAuthLink(@Body() body: unknown, @CurrentSession() session: SessionPayload) {
    const payload = oauthStartRequestSchema.parse(body);
    return this.oauthFlow.start(
      payload.provider,
      payload.redirectUri,
      payload.returnTo,
      'link',
      session.userId,
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
    const profile = await this.oauthFlow.complete(
      payload.provider,
      payload.code,
      payload.state,
      payload.redirectUri,
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
        account,
        sessionId: sessionRecord.sessionId,
        expiresAt: sessionRecord.expiresAt.toISOString(),
        returnTo: profile.returnTo ?? null,
        mode: 'link',
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
      account: session.account,
      sessionId: session.sessionId,
      expiresAt: session.expiresAt,
      returnTo: profile.returnTo ?? null,
      mode: 'login',
    };
  }

  @Post('email/register')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  registerEmail(
    @Body('email') email: string,
    @Body('password') password: string,
    @Body('displayName') displayName: string | undefined,
  ): Promise<EmailRegistrationResult> {
    return this.auth.registerEmail({ email, password, displayName });
  }

  @Post('email/login')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async loginEmail(
    @Body('email') email: string,
    @Body('password') password: string,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.auth.loginEmail(
      { email, password },
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
    @Body('token') token: string,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.auth.verifyEmail(token, this.extractSessionContext(request));
    reply.header('Set-Cookie', result.cookie);
    return {
      account: result.account,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  @Post('email/resend')
  @Throttle({ default: { limit: 3, ttl: 300 } })
  resendVerification(@Body('email') email: string): Promise<ResendVerificationResult> {
    return this.auth.resendVerification(email);
  }

  @UseGuards(SessionGuard)
  @Post('email/setup')
  @Throttle({ default: { limit: 3, ttl: 300 } })
  setupEmailLogin(
    @CurrentSession() session: SessionPayload,
    @Body('email') email: string,
    @Body('password') password: string,
  ): Promise<ResendVerificationResult> {
    return this.auth.setupEmailLogin(session.userId, { email, password });
  }

  @Post('password/forgot')
  @Throttle({ default: { limit: 3, ttl: 300 } })
  requestPasswordReset(@Body('email') email: string): Promise<PasswordResetRequestResult> {
    return this.auth.requestPasswordReset(email ?? '');
  }

  @Post('password/reset')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  resetPassword(
    @Body('token') token: string,
    @Body('newPassword') newPassword: string,
  ): Promise<PasswordResetConfirmResult> {
    return this.auth.resetPassword(token ?? '', newPassword ?? '');
  }

  @Post('discord/callback')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async discordCallback(
    @Body('userId') userId: string,
    @Body('email') email: string | undefined,
    @Body('username') username: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.auth.handleDiscordCallback(
      {
        userId,
        email,
        displayName: username,
      },
      this.extractSessionContext(request),
    );
    reply.header('Set-Cookie', result.cookie);
    return {
      account: result.account,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  @Post('naver/callback')
  @Throttle({ default: { limit: 8, ttl: 60 } })
  async naverCallback(
    @Body('userId') userId: string,
    @Body('email') email: string | undefined,
    @Body('nickname') nickname: string | undefined,
    @Res({ passthrough: true }) reply: FastifyReply,
    @Req() request: FastifyRequest,
  ) {
    const result = await this.auth.handleNaverCallback(
      {
        userId,
        email,
        displayName: nickname,
      },
      this.extractSessionContext(request),
    );
    reply.header('Set-Cookie', result.cookie);
    return {
      account: result.account,
      sessionId: result.sessionId,
      expiresAt: result.expiresAt,
    };
  }

  private async finalizeOAuth(
    provider: OAuthProvider,
    profile: { providerUserId: string; email?: string; displayName?: string },
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
      },
      this.extractSessionContext(request),
    );
    reply.header('Set-Cookie', result.cookie);
    return result;
  }

  @Post('link-requests')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  createLinkRequest(
    @Body('primaryAccountId') primaryAccountId: string,
    @Body('targetAccountId') targetAccountId: string,
  ) {
    return this.auth.createLinkRequest(primaryAccountId, targetAccountId);
  }

  @Post('link-requests/:requestId/confirm')
  @Throttle({ default: { limit: 5, ttl: 300 } })
  confirmLink(
    @Param('requestId') requestId: string,
    @Body('verificationCode') verificationCode: string,
  ) {
    return this.auth.confirmLink(requestId, verificationCode);
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
  me(@CurrentSession() session: SessionPayload) {
    return this.auth.getAccountView(session.userId);
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
    @Body('currentPassword') currentPassword: string,
    @Body('newPassword') newPassword: string,
  ) {
    await this.auth.changePassword(session.userId, currentPassword ?? '', newPassword ?? '');
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
